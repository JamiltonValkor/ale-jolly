import {createHash} from 'node:crypto';
import type {SimConfig, SaleadsScope} from '../config';
import type {Store} from '../store';

/** Mismo modelo de resultado que sa-mcp-server (`tool-definition.ts` y `tool-errors.ts`). */

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{type: 'text'; text: string}>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolErrorPayload {
  code: string;
  message: string;
  next_action: string;
  retryable: boolean;
  details: Record<string, unknown>;
  action_url: string | null;
}

export interface AuthContext {
  userId: string;
  clientId: string;
  scopes: Set<SaleadsScope>;
  requestId: string;
  expiresAt: number;
}

export interface ToolCallContext {
  auth: AuthContext;
  era: 'legacy' | 'modern' | null;
  transport: 'mcp' | 'rest';
  signal?: AbortSignal;
}

export interface ContractDef {
  name: string;
  title: string;
  description: string;
  requiredScope: SaleadsScope;
  annotations: {title: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean};
  async: boolean;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface ToolDeps {
  config: SimConfig;
  store: Store;
  fetch: typeof fetch;
  contracts?: Record<string, ContractDef>;
}

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<ToolResult>;

export function structuredResult(structuredContent: Record<string, unknown>): ToolResult {
  return {content: [{type: 'text', text: JSON.stringify(structuredContent)}], structuredContent};
}

export function toolErrorResult(error: ToolErrorPayload): ToolResult {
  return {
    isError: true,
    content: [{type: 'text', text: `${error.code}: ${error.message} ${error.next_action}`}],
    structuredContent: {error},
  };
}

export class ToolError extends Error {
  constructor(readonly payload: ToolErrorPayload) {
    super(payload.code);
  }
}

export const toolError = (code: string, message: string, nextAction: string, retryable = false,
  details: Record<string, unknown> = {}, actionUrl: string | null = null) =>
  new ToolError({code, message, next_action: nextAction, retryable, details, action_url: actionUrl});

export const invalid = (field: string, message = `El campo ${field} no es válido.`) =>
  toolError('MCP-E-INVALID-INPUT', message, `Corrige ${field} y reintenta.`, false, {fields: [field]});

export const businessNotFound = () => toolError('MCP-E-BUSINESS-NOT-FOUND',
  'El negocio no existe o no pertenece a esta cuenta.',
  'Lista los negocios con saleads_get_account_overview y usa uno de ellos.', false, {});

export const notFound = (what: string) => toolError('MCP-E-NOT-FOUND', `No se encontró ${what}.`,
  'Verifica el id con la herramienta de lectura correspondiente.', false, {});

export const conflict = (message: string, nextAction: string, details: Record<string, unknown> = {}) =>
  toolError('MCP-E-CONFLICT', message, nextAction, true, details);

export const upstreamUnavailable = (reason: string) => toolError('MCP-E-UPSTREAM-UNAVAILABLE',
  'Un servicio de SaleADS no respondió correctamente.', 'Reintenta en un momento; si persiste, informa al usuario.', true, {reason});

/** Corre un handler y convierte los `ToolError` en resultados `isError` (como `runAgent` del real). */
export async function guarded(fn: () => Promise<Record<string, unknown> | ToolResult>): Promise<ToolResult> {
  try {
    const value = await fn();
    return isToolResult(value) ? value : structuredResult(value);
  } catch (error) {
    if (error instanceof ToolError) return toolErrorResult(error.payload);
    throw error;
  }
}

function isToolResult(value: Record<string, unknown> | ToolResult): value is ToolResult {
  return Array.isArray((value as ToolResult).content) && ('structuredContent' in value || 'isError' in value);
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

/** Hash canónico de argumentos (claves ordenadas), para idempotencia. */
export function argsHash(value: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
    return v;
  };
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export const nowIso = () => new Date().toISOString();
export const text = (value: unknown): string => (typeof value === 'string' ? value : '');
export const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Negocio del dueño o error del catálogo. */
export function ownedBusiness(deps: ToolDeps, ctx: ToolCallContext, businessId: unknown) {
  if (!isUuid(businessId)) throw invalid('business_id');
  const business = deps.store.ownedBusiness(ctx.auth.userId, businessId);
  if (!business) throw businessNotFound();
  return business;
}
