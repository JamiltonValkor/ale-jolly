import {
  guarded, invalid, isUuid, ownedBusiness, toolError,
  type ToolDeps, type ToolErrorPayload, type ToolHandler,
} from './common';

/**
 * Las 15 `saleads_stock_*` son reenvío puro a ale-runtime
 * `/internal/stock/businesses/:businessId/*`, igual que sa-mcp-server
 * (`src/tools/stock/stock-common.ts` y `src/clients/routes.stock.ts`):
 * `x-internal-api-token`, `x-user-id` del token validado, `x-business-id` del
 * negocio verificado; `business_id` va en la ruta, nunca en el cuerpo.
 */

interface Spec {
  method: 'GET' | 'POST';
  path: string;
  params?: Record<string, string>;
  query?: string[];
  body?: boolean;
}

const SPECS: Record<string, Spec> = {
  saleads_stock_get_overview: {method: 'GET', path: 'overview', query: ['tarjeta', 'order_id', 'document_id']},
  saleads_stock_get_item: {method: 'GET', path: 'items/:variantId', params: {variantId: 'variante_id'}},
  saleads_stock_list_proposals: {method: 'GET', path: 'proposals', query: ['status', 'limit']},
  saleads_stock_propose: {method: 'POST', path: 'proposals', body: true},
  saleads_stock_confirm_count: {method: 'POST', path: 'proposals/:id/confirm-count', params: {id: 'proposal_id'}, body: true},
  saleads_stock_list_suppliers: {method: 'GET', path: 'suppliers', query: ['variante_id']},
  saleads_stock_list_orders: {method: 'GET', path: 'orders', query: ['status', 'con_novedad']},
  saleads_stock_get_bet_signal: {method: 'GET', path: 'bet-signal/:variantId', params: {variantId: 'variante_id'}},
  saleads_stock_take_photo: {method: 'POST', path: 'photos', body: true},
  saleads_stock_get_photo: {method: 'GET', path: 'photos/:id', params: {id: 'photo_id'}},
  saleads_stock_document_register: {method: 'POST', path: 'documents', body: true},
  saleads_stock_document_extract: {method: 'POST', path: 'documents/:id/extract', params: {id: 'document_id'}},
  saleads_stock_supplier_send: {method: 'POST', path: 'supplier/send', body: true},
  saleads_stock_supplier_wait: {method: 'GET', path: 'supplier/wait', query: ['order_id', 'after']},
  saleads_stock_robot_say: {method: 'POST', path: 'robot/say', body: true},
};

export const STOCK_TOOLS = Object.keys(SPECS);
const LONG_WAIT = new Set(['saleads_stock_take_photo', 'saleads_stock_document_extract', 'saleads_stock_supplier_wait']);
const UNTRUSTED = new Set(STOCK_TOOLS.filter((t) => !['saleads_stock_robot_say', 'saleads_stock_supplier_send', 'saleads_stock_document_register'].includes(t)));
const URL_FIELDS = new Set(['url', 'image_url', 'foto_url', 'enlace']);
// Invisibles y de control (sin \t, \n, \r): zero-width, bidi y similares.
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F­​-‏‪-‮⁠-⁤⁦-⁯﻿]/gu;

const decodeEntities = (value: string) => value.includes('&')
  ? value.replace(/&#(\d{1,7});|&#x([0-9a-f]{1,6});/gi, (m, dec, hex) => {
    const code = dec ? Number(dec) : parseInt(hex, 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : m;
  }) : value;

function cleanDeep(value: unknown, key?: string): unknown {
  if (typeof value === 'string') return key !== undefined && URL_FIELDS.has(key) ? value : decodeEntities(value).replace(INVISIBLE, '');
  if (Array.isArray(value)) return value.map((item) => cleanDeep(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleanDeep(v, k)]));
  return value;
}

/** `{code}` de ale-runtime al catálogo (`stockFailure` del real). */
function stockFailure(status: number, body: unknown): ToolErrorPayload {
  const raw = body && typeof body === 'object' ? (body as Record<string, unknown>).code : undefined;
  const downstream = typeof raw === 'string' && /^[A-Z_]{1,64}$/.test(raw) ? raw : `HTTP_${status}`;
  const details = {downstream_code: downstream, downstream_status: status};
  const e = (code: string, message: string, next_action: string, retryable: boolean, extra: Record<string, unknown> = {}): ToolErrorPayload =>
    ({code, message, next_action, retryable, details: {...details, ...extra}, action_url: null});
  if (downstream === 'STOCK_NEGATIVE') return e('MCP-E-CONFLICT', 'El saldo no alcanza para esta operación.', 'Lee el saldo actual con saleads_stock_get_item y explícale al dueño. No reintentes igual.', false, {reason: 'stock_negative'});
  if (downstream === 'STOCK_OTHER_RUN') return e('MCP-E-INVALID-INPUT', 'Ese producto o esa propuesta no son de la corrida activa.', 'Lee saleads_stock_get_overview en este turno y usa solo sus ids. No copies ids del tablero ni de turnos viejos.', false, {reason: 'other_run'});
  if (downstream === 'STOCK_ALERT_ID_REQUIRED') return e('MCP-E-INVALID-INPUT', 'Los avisos de Stock se dicen con su alerta_id, no con texto libre.', 'Lee avisos_pendientes en saleads_stock_get_overview y llama saleads_stock_robot_say solo con business_id y alerta_id.', false, {reason: 'alert_id_required'});
  if (status === 409 || status === 412) return e('MCP-E-CONFLICT', 'El recurso cambió o ya se resolvió.', 'Relee el recurso y decide de nuevo con su revisión actual.', true);
  if (status === 404) return e('MCP-E-BUSINESS-NOT-FOUND', 'El negocio o el recurso no existe, o Stock no está habilitado para él.', 'Lista los negocios con saleads_get_account_overview y usa uno de ellos.', false);
  if (status === 429) return e('MCP-E-RATE-LIMITED', 'Se alcanzó el límite de Stock.', 'Espera un momento y reintenta.', true);
  if (status >= 500) return e('MCP-E-UPSTREAM-UNAVAILABLE', 'Un servicio de SaleADS no respondió correctamente.', 'Reintenta en un momento; si persiste, informa al usuario.', true);
  return e('MCP-E-INVALID-INPUT', 'SaleADS rechazó esta petición de Stock.', 'Revisa los campos contra el esquema de la herramienta y reintenta.', false);
}

export function stockHandlers(deps: ToolDeps): Record<string, ToolHandler> {
  const {config} = deps;
  const allowed = new Set(config.stockUserIds);
  return Object.fromEntries(Object.entries(SPECS).map(([tool, spec]) => [tool, (rawArgs, ctx) => guarded(async () => {
    if (!allowed.has(ctx.auth.userId)) {
      throw toolError('MCP-E-ACCESS-NOT-ENABLED', 'Stock todavía no está habilitado para esta cuenta.',
        'Informa al usuario que Stock aún no está habilitado para su cuenta. No reintentes.', false, {reason: 'stock_not_enabled'});
    }
    const args = rawArgs ?? {};
    if (!isUuid(args.business_id)) throw invalid('business_id');
    let path = spec.path;
    for (const [param, field] of Object.entries(spec.params ?? {})) {
      if (!isUuid(args[field])) throw invalid(field);
      path = path.replace(`:${param}`, encodeURIComponent(String(args[field])));
    }
    const business = ownedBusiness(deps, ctx, args.business_id);
    if (!config.metaAssistantToken) {
      throw toolError('MCP-E-UPSTREAM-UNAVAILABLE', 'Stock no está configurado en este entorno.', 'Informa al usuario; falta el token interno.', true, {reason: 'internal_token_missing'});
    }
    const url = new URL(`${config.metaAssistantUrl}/internal/stock/businesses/${business.id}/${path}`);
    for (const name of spec.query ?? []) {
      const value = args[name];
      if (typeof value === 'string' || typeof value === 'number') url.searchParams.set(name, String(value));
      else if (typeof value === 'boolean') url.searchParams.set(name, String(value));
    }
    const routed = new Set(['business_id', ...Object.values(spec.params ?? {})]);
    const body = spec.body ? Object.fromEntries(Object.entries(args).filter(([k]) => !routed.has(k))) : undefined;
    let response: Response;
    try {
      response = await deps.fetch(url, {
        method: spec.method,
        headers: {
          accept: 'application/json', 'x-internal-api-token': config.metaAssistantToken, 'x-user-id': ctx.auth.userId,
          'x-business-id': business.id, 'x-request-id': ctx.auth.requestId,
          ...(body ? {'content-type': 'application/json'} : {}),
        },
        ...(body ? {body: JSON.stringify(body)} : {}),
        signal: AbortSignal.timeout(LONG_WAIT.has(tool) ? config.stockTimeoutMs : 30_000),
      });
    } catch {
      throw toolError('MCP-E-UPSTREAM-UNAVAILABLE', 'Stock no respondió.', 'Reintenta en un momento.', true, {reason: 'unreachable'});
    }
    let parsed: unknown = null;
    try {parsed = await response.json();} catch {parsed = null;}
    if (response.status >= 400) return {isError: true, ...errorResult(stockFailure(response.status, parsed))};
    const data = (parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>;
    return (UNTRUSTED.has(tool) ? cleanDeep(data) : data) as Record<string, unknown>;
  })] as [string, ToolHandler]));
}

function errorResult(error: ToolErrorPayload) {
  return {content: [{type: 'text' as const, text: `${error.code}: ${error.message} ${error.next_action}`}], structuredContent: {error}};
}
