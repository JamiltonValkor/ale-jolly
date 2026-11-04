import assert from 'node:assert/strict';
import {after, before, describe, it} from 'node:test';
import {loadContracts} from '../src/tools/registry';
import {Sampler} from '../src/tools/sample';
import {agent, assistantTokens, callTool, DEMO_BUSINESS, rpc, start, validator, type Harness} from './helpers';

/**
 * Una prueba por herramienta del contrato: se llama con una entrada mínima
 * válida contra su `inputSchema` (con el negocio demo) y la respuesta debe ser
 * o bien válida contra su `outputSchema`, o bien un error del catálogo
 * (`isError` + `structuredContent.error.code` `MCP-E-*`). Las del dominio
 * `agent` se prueban por `/agent/v1` (no están en `tools/list`).
 */

const contracts = loadContracts();
const ajv = validator();
/** Falso ale-runtime: responde una salida válida de la tool de Stock que se está probando. */
let current = '';
const okStock = async () => new Response(JSON.stringify(new Sampler(contracts[current]?.outputSchema ?? {}, 'https://saleads.local').sample()),
  {status: 200, headers: {'content-type': 'application/json'}});

/** Entradas escritas a mano donde el esquema tiene condiciones que el generador no resuelve. */
const FIXTURES: Record<string, Record<string, unknown>> = {
  saleads_subscribe_events: {business_id: DEMO_BUSINESS, url: 'https://hooks.example.com/saleads', delivery_mode: 'standard_webhooks',
    secret: `whsec_${'A'.repeat(32)}`, types: ['*']},
};

describe('herramientas contra su esquema', () => {
  let h: Harness;
  let token: string;
  before(async () => {
    h = await start({}, okStock as unknown as typeof fetch);
    token = (await assistantTokens(h)).body.access_token;
  });
  after(() => h.close());

  it('tools/list publica las herramientas no-agent (stock incluido para el usuario demo), en las dos versiones', async () => {
    for (const version of ['2025-11-25', '2026-07-28']) {
      const {status, message} = await rpc(h, token, 'tools/list', {}, version);
      assert.equal(status, 200, `tools/list ${version}`);
      const names = new Set<string>((message.result.tools as Array<{name: string}>).map((t) => t.name));
      assert.ok(names.has('saleads_get_account_overview'));
      assert.ok(names.has('saleads_stock_get_overview'));
      assert.ok(!names.has('saleads_landing_create'), 'el dominio agent es solo REST');
      assert.ok(!names.has('saleads_agent_register_bets'));
      const call = await rpc(h, token, 'tools/call', {name: 'saleads_get_account_overview', arguments: {}}, version);
      assert.equal(call.message.result.structuredContent.selected_business_id, DEMO_BUSINESS, `tools/call ${version}`);
    }
  });

  it('GET y DELETE de /mcp responden 405', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`${h.base}/mcp`, {method, headers: {authorization: `Bearer ${token}`, accept: 'text/event-stream'}});
      assert.equal(res.status, 405, method);
    }
  });

  for (const [name, contract] of Object.entries(contracts)) {
    it(name, async () => {
      current = name;
      const check = ajv.compile(contract.inputSchema);
      const input = (FIXTURES[name] ?? new Sampler(contract.inputSchema, 'https://saleads.local').sampleValid((v) => check(v) as boolean)) as Record<string, unknown>;
      if ('business_id' in input) input.business_id = DEMO_BUSINESS;
      assert.ok(ajv.validate(contract.inputSchema, input), `entrada de prueba inválida: ${ajv.errorsText()}`);
      let structured: Record<string, any>;
      let isError: boolean;
      if (name.startsWith('saleads_landing_') || name.startsWith('saleads_agent_')) {
        const res = await agent(h, token, 'POST', name, input);
        assert.ok([200, 400, 403].includes(res.status), `HTTP ${res.status} ${JSON.stringify(res.body)}`);
        isError = res.body.ok === false;
        structured = isError ? {error: res.body} : res.body.data;
      } else {
        const result = await callTool(h, token, name, input);
        isError = result.isError === true;
        structured = result.structuredContent ?? JSON.parse(result.content[0].text);
      }
      if (isError) {
        assert.match(String(structured.error?.code), /^MCP-E-[A-Z-]+$/, JSON.stringify(structured));
      } else if (contract.outputSchema) {
        assert.ok(ajv.validate(contract.outputSchema, structured), `${name}: ${ajv.errorsText()}\n${JSON.stringify(structured).slice(0, 400)}`);
      }
    });
  }
});
