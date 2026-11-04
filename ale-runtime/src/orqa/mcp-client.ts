import type {OutboundFetch} from '../outbound/http-client';
import {readSse} from '../hermes/hermes-client';

/**
 * Cliente mínimo del MCP de SaleADS para el propio servicio (ORQA OSB-007).
 * JSON-RPC `tools/call` por Streamable HTTP en la era 2026-10-31: el MCP la
 * sirve sin sesión y sin `initialize` previo (sa-mcp-server
 * src/transport/mcp-http.handler.ts), y responde por SSE. El token del dueño
 * va en el Bearer y nunca se registra; tampoco los argumentos ni el resultado.
 */

export type McpCallOutcome =
  | {ok: true; data: Record<string, unknown>}
  | {ok: false; code: string};

export interface McpToolClient {
  call(accessToken: string, name: string, args: Record<string, unknown>, timeoutMs: number): Promise<McpCallOutcome>;
}

const PROTOCOL = '2026-10-27';
const CODE = /^[A-Za-z0-9_.:-]{1,80}$/;

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Código seguro del error de una tool (`MCP-E-...`), nunca su mensaje. */
function toolErrorCode(result: Record<string, unknown>): string {
  const structured = record(result.structuredContent);
  const candidates = [record(structured?.error)?.code, structured?.code];
  const content = Array.isArray(result.content) ? result.content : [];
  for (const item of content) {
    const text = record(item)?.text;
    if (typeof text !== 'string') continue;
    try {
      const parsed = record(JSON.parse(text));
      candidates.push(record(parsed?.error)?.code, parsed?.code);
    } catch {/* texto libre */}
  }
  const code = candidates.find((value): value is string => typeof value === 'string' && CODE.test(value));
  return code ?? 'tool_error';
}

export class HttpMcpToolClient implements McpToolClient {
  private nextId = 1;

  constructor(private readonly url: string, private readonly fetcher: OutboundFetch) {}

  async call(accessToken: string, name: string, args: Record<string, unknown>, timeoutMs: number): Promise<McpCallOutcome> {
    const id = this.nextId++;
    let response: Response;
    try {
      response = await this.fetcher(this.url, {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': PROTOCOL,
        },
        body: JSON.stringify({jsonrpc: '2.0', id, method: 'tools/call', params: {name, arguments: args}}),
      });
    } catch {
      return {ok: false, code: 'mcp_unreachable'};
    }
    if (response.status === 401 || response.status === 403) {await this.drain(response); return {ok: false, code: 'mcp_unauthorized'};}
    if (!response.ok || !response.body) {await this.drain(response); return {ok: false, code: `mcp_http_${response.status}`};}
    let message: Record<string, unknown> | null = null;
    try {
      if (response.headers.get('content-type')?.startsWith('text/event-stream')) {
        for await (const {data} of readSse(response.body)) {
          const candidate = record(data);
          if (candidate?.id === id) {message = candidate; break;}
        }
      } else {
        message = record(await response.json());
      }
    } catch {
      return {ok: false, code: 'mcp_body'};
    } finally {
      await this.drain(response);
    }
    if (!message) return {ok: false, code: 'mcp_no_response'};
    if (message.error) return {ok: false, code: 'mcp_rpc_error'};
    const result = record(message.result);
    if (!result) return {ok: false, code: 'mcp_no_result'};
    if (result.isError === true) return {ok: false, code: toolErrorCode(result)};
    const structured = record(result.structuredContent);
    if (structured) return {ok: true, data: structured};
    const text = Array.isArray(result.content) ? record(result.content[0])?.text : undefined;
    if (typeof text === 'string') {
      try {
        const parsed = record(JSON.parse(text));
        if (parsed) return {ok: true, data: parsed};
      } catch {/* no JSON */}
    }
    return {ok: false, code: 'mcp_unstructured'};
  }

  private async drain(response: Response): Promise<void> {
    try {await response.body?.cancel();} catch {/* ya consumido */}
  }
}

/**
 * La web sondea el primer ciclo cada 3–10 s y cada lectura pregunta al MCP qué negocios tiene el dueño y cuál eligió:
 * unas 12 llamadas por minuto a `saleads_get_account_overview` con la página abierta. Este envoltorio comparte esa
 * respuesta por token durante `ttlMs` (y la llamada en vuelo). Solo esa herramienta y sin argumentos; los fallos no
 * se guardan, y elegir otro negocio por este cliente (`saleads_select_business`) borra la del dueño. El token es la
 * llave en memoria y nunca se registra.
 */
export function withAccountOverviewCache(inner: McpToolClient, ttlMs: number, now: () => number = Date.now): McpToolClient {
  const cache = new Map<string, {at: number; outcome: Promise<McpCallOutcome>}>();
  return {
    call(accessToken, name, args, timeoutMs) {
      if (name === 'saleads_select_business') cache.delete(accessToken);
      if (name !== 'saleads_get_account_overview' || Object.keys(args).length) return inner.call(accessToken, name, args, timeoutMs);
      const at = now();
      for (const [token, entry] of cache) if (at - entry.at >= ttlMs) cache.delete(token);
      const hit = cache.get(accessToken);
      if (hit) return hit.outcome;
      const outcome = inner.call(accessToken, name, args, timeoutMs);
      cache.set(accessToken, {at, outcome});
      void outcome.then(result => {if (!result.ok) cache.delete(accessToken);}, () => cache.delete(accessToken));
      return outcome;
    },
  };
}
