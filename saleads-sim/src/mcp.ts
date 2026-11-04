import {toNodeHandler, type NodeMcpRequestHandler} from '@modelcontextprotocol/node';
import {
  createMcpHandler, fromJsonSchema, McpServer, type CallToolResult, type JsonSchemaType, type McpRequestContext,
} from '@modelcontextprotocol/server';
import {readAuth, type BearerAuthenticator} from './auth';
import type {SimConfig} from './config';
import type {RegisteredTool} from './tools/registry';

/**
 * `/mcp` Streamable HTTP sin sesión, en las dos eras (2026-07-28 y
 * 2025-11-25), con el mismo SDK y las mismas opciones que sa-mcp-server
 * (`mcp-http.handler.ts` y `mcp-server.factory.ts`): `legacy: 'stateless'`
 * (GET/DELETE = 405), respuestas por SSE con keep-alive y `tools/call` sin
 * `initialize`. El dominio `agent` no se lista aquí (solo REST) y `stock`
 * solo para sus usuarios.
 */

const INSTRUCTIONS =
  'Servidor MCP de SaleADS. Usa únicamente las herramientas disponibles en tools/list; ' +
  'no supongas que un flujo de otro entorno está habilitado en este conector. ' +
  'Nunca lanza campañas: el lanzamiento lo confirma el usuario en la web de SaleADS.';

export const STREAMING_HEADERS: Readonly<Record<string, string>> = {'X-Accel-Buffering': 'no', 'Cache-Control': 'no-cache, no-transform'};

/** Log de herramientas desconocidas o fallidas (riesgo del plan §6: «el MCP simulado no cubre una herramienta»). */
export type CallLogger = (event: {tool: string; transport: 'mcp' | 'rest'; outcome: string; user: string}) => void;

export function createMcpEndpoint(config: SimConfig, registry: Map<string, RegisteredTool>, authenticate: BearerAuthenticator, log: CallLogger): NodeMcpRequestHandler {
  const stockUsers = new Set(config.stockUserIds);
  const bindings = [...registry.values()].filter((tool) => tool.definition.domain !== 'agent').map((tool) => ({
    tool,
    inputSchema: fromJsonSchema(tool.definition.inputSchema as JsonSchemaType),
    outputSchema: tool.definition.outputSchema ? fromJsonSchema(tool.definition.outputSchema as JsonSchemaType) : undefined,
  }));

  const factory = (ctx: McpRequestContext) => {
    const server = new McpServer(
      {name: 'sa-mcp-server', title: 'SaleADS', version: config.version},
      {capabilities: {tools: {listChanged: false}}, instructions: INSTRUCTIONS},
    );
    const principal = readAuth(ctx.authInfo)?.userId;
    for (const binding of bindings) {
      const {definition} = binding.tool;
      if (definition.domain === 'stock' && (!principal || !stockUsers.has(principal))) continue;
      server.registerTool(definition.name, {
        title: definition.title,
        description: definition.description,
        inputSchema: binding.inputSchema,
        ...(binding.outputSchema ? {outputSchema: binding.outputSchema} : {}),
        annotations: definition.annotations,
        _meta: {'ai.saleads/requiredScope': definition.requiredScope},
        scopeChallenge: ({authInfo}) => {
          if (!authInfo) return {scopes: [definition.requiredScope], errorDescription: 'Authentication required'};
          if (authInfo.scopes.includes(definition.requiredScope)) return undefined;
          return {scopes: [...new Set([...authInfo.scopes, definition.requiredScope])] as [string, ...string[]], errorDescription: `Tool requires scope ${definition.requiredScope}`};
        },
      }, async (args: unknown, sdkCtx): Promise<CallToolResult> => {
        const auth = readAuth(sdkCtx.http?.authInfo ?? ctx.authInfo)!;
        const result = await binding.tool.handler((args ?? {}) as Record<string, unknown>, {auth, era: ctx.era, transport: 'mcp', signal: sdkCtx.mcpReq.signal});
        log({tool: definition.name, transport: 'mcp', outcome: result.isError ? 'tool_error' : binding.tool.generic ? 'ok_generic' : 'ok', user: auth.userId});
        return result as CallToolResult;
      });
    }
    return server;
  };

  const handler = createMcpHandler(factory, {
    legacy: 'stateless',
    responseMode: 'sse',
    keepAliveMs: config.sseHeartbeatMs,
    maxRequestBodySize: 4 * 1024 * 1024,
    onerror: (error) => console.warn(JSON.stringify({msg: 'mcp.transport_error', error: error.name, message: error.message})),
  });

  return toNodeHandler({
    fetch: async (request: Request, init?: Parameters<typeof handler.fetch>[1]) => {
      const auth = await authenticate(request);
      if (auth instanceof Response) return auth;
      const response = await handler.fetch(await asLegacyWhenUnclaimed(request), {...init, authInfo: auth});
      const headers = new Headers(response.headers);
      for (const [name, value] of Object.entries(STREAMING_HEADERS)) headers.set(name, value);
      return new Response(response.body, {status: response.status, statusText: response.statusText, headers});
    },
  }, {maxRequestBodySize: 4 * 1024 * 1024});
}

/** Revisiones que el SDK conoce; cualquier otra fecha que no traiga el sobre `_meta` se atiende como la era clásica. */
const KNOWN_REVISIONS = new Set(['2025-03-26', '2025-06-18', '2025-11-25', '2026-07-28']);
const LEGACY_REVISION = '2025-11-25';

/**
 * El SDK trata toda revisión >= 2026-07-28 como moderna y exige `params._meta`. ale-runtime manda una cabecera
 * con su propia fecha y un `tools/call` clásico sin sobre: sin esto el sim respondería 400 a todas sus llamadas.
 */
export async function asLegacyWhenUnclaimed(request: Request): Promise<Request> {
  const version = request.headers.get('mcp-protocol-version');
  if (request.method !== 'POST' || !version || KNOWN_REVISIONS.has(version)) return request;
  const body = await request.clone().text();
  let claimed = false;
  try {
    const parsed = JSON.parse(body) as unknown;
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    claimed = messages.some((m) => typeof m === 'object' && m !== null && typeof (m as {params?: {_meta?: unknown}}).params?._meta === 'object');
  } catch {
    return request;
  }
  if (claimed) return request;
  const headers = new Headers(request.headers);
  headers.set('mcp-protocol-version', LEGACY_REVISION);
  return new Request(request.url, {method: request.method, headers, body});
}
