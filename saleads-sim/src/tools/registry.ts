import {readdirSync, readFileSync} from 'node:fs';
import Ajv2020 from 'ajv/dist/2020';
import addFormatsModule from 'ajv-formats';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {betHandlers} from './bets';
import {businessHandlers, checkBusinessArg} from './business';
import {guarded, nowIso, type ContractDef, type ToolDeps, type ToolHandler} from './common';
import {landingHandlers} from './landings';
import {getOperation, runAsync} from './operations';
import {Sampler} from './sample';
import {stockHandlers} from './stock';
import {strategyHandlers} from './strategy';

/**
 * Catálogo de herramientas: los contratos de `contracts/schemas` (copiados de
 * sa-mcp-server, ver `contracts/SOURCE`) con su dominio, y el handler de cada
 * una. Las que no tienen núcleo con estado responden una salida de demo
 * válida contra su `outputSchema` (generada desde el propio esquema).
 */

export const CONTRACTS_DIR = fileURLToPath(new URL('../../contracts/schemas', import.meta.url));

/** Dominios (sa-mcp-server `tool-domains.ts`). `agent` es solo REST (/agent/v1); `stock`, solo para sus usuarios. */
const DOMAIN_OVERRIDES: Record<string, string> = {
  saleads_get_help: 'business', saleads_get_business_bootstrap: 'business', saleads_request_approval: 'business',
  saleads_share_learning: 'business', saleads_list_skill_catalog: 'business',
  saleads_get_meta_status: 'meta', saleads_search_locations: 'meta',
  saleads_list_plans: 'plan', saleads_get_growth_cycle: 'plan', saleads_get_cycle_sales: 'plan',
  saleads_create_media_upload: 'media', saleads_set_campaign_images: 'media',
  saleads_prepare_campaign: 'drafts', saleads_update_campaign_copies: 'drafts', saleads_approve_campaign: 'drafts',
  saleads_list_campaigns: 'launch', saleads_get_campaign_health: 'launch', saleads_get_box_metrics: 'launch',
  saleads_get_campaign_ads: 'launch', saleads_get_results: 'launch', saleads_get_launch_status: 'launch',
  saleads_pause_campaign: 'launch', saleads_request_resume_campaign: 'launch', saleads_request_plan_launch: 'launch',
  saleads_get_operation: 'operations',
};

export function domainOf(name: string): string {
  if (DOMAIN_OVERRIDES[name]) return DOMAIN_OVERRIDES[name];
  if (name.startsWith('saleads_landing_') || name.startsWith('saleads_agent_')) return 'agent';
  if (name.startsWith('saleads_stock_')) return 'stock';
  if (/special_plan|special_dates/.test(name)) return 'special-plan';
  if (/_events?$|event_subscriptions/.test(name)) return 'events';
  if (/strategy/.test(name)) return 'strategy';
  if (/_plan$/.test(name)) return 'plan';
  return 'business';
}

export interface RegisteredTool {
  definition: ContractDef & {domain: string; source: 'contract' | 'dev'};
  handler: ToolHandler;
  /** true = respuesta de demo generada desde el esquema (sin núcleo con estado). */
  generic: boolean;
}

export function loadContracts(dir = CONTRACTS_DIR): Record<string, ContractDef> {
  const out: Record<string, ContractDef> = {};
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const contract = JSON.parse(readFileSync(join(dir, file), 'utf8')) as ContractDef;
    out[contract.name] = contract;
  }
  return out;
}

const PING: ContractDef = {
  name: 'saleads_ping', title: 'Ping (dev)',
  description: 'Herramienta de diagnóstico solo para desarrollo: confirma que el servidor MCP de SaleADS responde. No accede a datos del usuario.',
  requiredScope: 'saleads:read', async: false,
  annotations: {title: 'Ping (dev)', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  inputSchema: {$schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false,
    properties: {message: {type: 'string', maxLength: 200}, delay_ms: {type: 'integer', minimum: 0, maximum: 5000}}},
  outputSchema: {$schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false,
    properties: {ok: {type: 'boolean', const: true}, message: {type: 'string'}, protocol_era: {type: 'string', enum: ['legacy', 'modern']},
      instance_id: {type: 'string'}, server_time: {type: 'string', format: 'date-time'}},
    required: ['ok', 'protocol_era', 'instance_id', 'server_time']},
};

export function buildRegistry(deps: ToolDeps): Map<string, RegisteredTool> {
  const contracts = deps.contracts ?? loadContracts();
  deps.contracts = contracts;
  const core: Record<string, ToolHandler> = {
    ...businessHandlers(deps), ...strategyHandlers(deps), ...betHandlers(deps), ...landingHandlers(deps), ...stockHandlers(deps),
    saleads_get_operation: (args, ctx) => guarded(() => getOperation(deps, ctx, args)),
    saleads_ping: async (args, ctx) => {
      const delay = typeof args.delay_ms === 'number' ? Math.min(args.delay_ms, 5000) : 0;
      if (delay) await new Promise((r) => setTimeout(r, delay));
      const out = {ok: true, message: typeof args.message === 'string' ? args.message : 'pong', protocol_era: ctx.era ?? 'modern', instance_id: deps.config.instanceId, server_time: nowIso()};
      return {content: [{type: 'text', text: JSON.stringify(out)}], structuredContent: out};
    },
  };
  const registry = new Map<string, RegisteredTool>();
  for (const contract of [...Object.values(contracts), PING]) {
    const handler = core[contract.name];
    registry.set(contract.name, {
      definition: {...contract, domain: contract === PING ? 'dev' : domainOf(contract.name), source: contract === PING ? 'dev' : 'contract'},
      handler: handler ?? genericHandler(deps, contract),
      generic: !handler,
    });
  }
  return registry;
}

/** Salida de demo válida contra el esquema, con la propiedad del negocio verificada; las async pasan por operaciones. */
const ajv = new Ajv2020({strict: false, allErrors: true});
(addFormatsModule as unknown as (a: Ajv2020) => void)(ajv);

function genericHandler(deps: ToolDeps, contract: ContractDef): ToolHandler {
  const schema = contract.outputSchema ?? {type: 'object'};
  const validate = ajv.compile(schema);
  const sampler = new Sampler(schema, deps.config.publicBaseUrl);
  return (args, ctx) => guarded(async () => {
    checkBusinessArg(deps, ctx.auth.userId, args);
    const work = async () => sampler.sampleValid((v) => validate(v)) as Record<string, unknown>;
    return contract.async ? runAsync(deps, ctx, contract.name, args, work) : work();
  });
}
