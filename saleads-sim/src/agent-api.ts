import type {IncomingMessage, ServerResponse} from 'node:http';
import Ajv2020, {type ErrorObject, type ValidateFunction} from 'ajv/dist/2020';
import addFormatsModule from 'ajv-formats';
import {readAuth, type BearerAuthenticator} from './auth';
import type {SimConfig} from './config';
import {BodyTooLarge, readJson, sendJson} from './http-util';
import type {CallLogger} from './mcp';
import type {RegisteredTool} from './tools/registry';

/**
 * REST `/agent/v1` del CLI del asistente (sa-mcp-server `agent-api.ts`):
 * mismo token y audiencia que `/mcp`, solo para el cliente del asistente.
 * `GET /commands` = catálogo; `GET /commands/:name` = esquema;
 * `POST /commands/:name` = ejecutar. Sobre `{ok, data}` / `{ok:false, code, …}`.
 */

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => void;
const NO_STORE = {'cache-control': 'no-store'};
const STATUS_BY_CODE: Record<string, number> = {'MCP-E-RATE-LIMITED': 429, 'MCP-E-SUBSCRIPTION-REQUIRED': 402, 'MCP-E-ACCESS-NOT-ENABLED': 403};
const LANDING_ARTIFACT = new Set(['saleads_landing_validate', 'saleads_landing_preview', 'saleads_landing_submit_version']);

export function commandSummary(description: string): string {
  const flat = description.replace(/\s+/g, ' ').trim();
  const end = flat.search(/[.!?](\s|$)/);
  const sentence = end >= 0 ? flat.slice(0, end + 1) : flat;
  return sentence.length <= 120 ? sentence : `${sentence.slice(0, 119).trimEnd()}…`;
}

function errorFields(errors: ErrorObject[] | null | undefined): string[] {
  const fields = new Set<string>();
  for (const error of errors ?? []) {
    const params = error.params as {missingProperty?: unknown; additionalProperty?: unknown};
    if (typeof params.missingProperty === 'string') fields.add(`${error.instancePath}/${params.missingProperty}`);
    else if (typeof params.additionalProperty === 'string') fields.add(`${error.instancePath}/${params.additionalProperty}`);
    else fields.add(error.instancePath || '/');
  }
  return [...fields].slice(0, 20);
}

const failure = (status: number, code: string, message: string, nextAction: string, extra: Record<string, unknown> = {}) =>
  ({status, body: {ok: false, code, message, next_action: nextAction, retryable: false, ...extra}});

export function createAgentApi(config: SimConfig, registry: Map<string, RegisteredTool>, authenticate: BearerAuthenticator, log: CallLogger) {
  const enabled = [...registry.values()].filter(({definition}) => definition.source === 'contract'
    && ((config.agentApiCommands.includes(definition.name) && definition.annotations.readOnlyHint) || definition.domain === 'agent'));
  const byName = new Map(enabled.map((tool) => [tool.definition.name, tool]));
  const ajv = new Ajv2020({strict: false, allErrors: true});
  addFormats(ajv);
  const validators = new Map<string, ValidateFunction>(enabled.map((t) => [t.definition.name, ajv.compile(t.definition.inputSchema)]));
  const catalog = enabled.map(({definition}) => ({
    name: definition.name, title: definition.title, summary: commandSummary(definition.description),
    required_scope: definition.requiredScope, async: definition.async, read_only: definition.annotations.readOnlyHint,
  })).sort((a, b) => a.name.localeCompare(b.name));

  async function handle(req: IncomingMessage, url: URL, command: string | undefined): Promise<{status: number; body: unknown; headers?: Record<string, string>}> {
    const headers = new Headers();
    if (req.headers.authorization) headers.set('authorization', String(req.headers.authorization));
    if (req.headers['x-request-id']) headers.set('x-request-id', String(req.headers['x-request-id']));
    const outcome = await authenticate(new Request('http://agent-api.local/agent/v1', {headers}));
    if (outcome instanceof Response) {
      const responseHeaders: Record<string, string> = {};
      outcome.headers.forEach((value, key) => {responseHeaders[key] = value;});
      const text = await outcome.text();
      let body: unknown = {error: 'invalid_token'};
      try {if (text) body = JSON.parse(text);} catch {/* sin JSON */}
      return {status: outcome.status, body, headers: responseHeaders};
    }
    const auth = readAuth(outcome);
    if (!auth || auth.clientId !== config.assistantClientId) {
      return failure(403, 'MCP-E-ACCESS-NOT-ENABLED', 'Esta conexión no tiene habilitado el canal del agente.', 'Usa el asistente de SaleADS conectado por el dueño.');
    }
    if (req.method === 'GET' && command === undefined) return {status: 200, body: {ok: true, data: {commands: catalog}}};
    const tool = command ? byName.get(command) : undefined;
    if (!tool) {
      log({tool: command ?? '(none)', transport: 'rest', outcome: 'unknown_command', user: auth.userId});
      return failure(404, 'MCP-E-UNKNOWN-COMMAND', 'Ese comando no existe o no está disponible para el agente.', 'Lista los comandos con GET /agent/v1/commands y usa uno disponible.');
    }
    const {definition} = tool;
    if (req.method === 'GET') {
      return {status: 200, body: {ok: true, data: {
        name: definition.name, title: definition.title, description: definition.description, required_scope: definition.requiredScope,
        async: definition.async, read_only: definition.annotations.readOnlyHint, input_schema: definition.inputSchema,
        ...(url.searchParams.get('output') === '1' && definition.outputSchema ? {output_schema: definition.outputSchema} : {}),
      }}};
    }
    if (req.method !== 'POST') {
      return {...failure(405, 'MCP-E-INVALID-INPUT', 'Método no permitido.', 'Usa GET para leer el comando y POST para ejecutarlo.'), headers: {allow: 'GET, POST'}};
    }
    let args: unknown;
    try {
      args = (await readJson(req, LANDING_ARTIFACT.has(definition.name) ? 576 * 1024 : 262_144)) ?? {};
    } catch (error) {
      const large = error instanceof BodyTooLarge;
      return failure(large ? 413 : 400, 'MCP-E-INVALID-INPUT', large ? 'El cuerpo de la petición es demasiado grande.' : 'El cuerpo debe ser JSON válido.', 'Envía los argumentos del comando como un objeto JSON.');
    }
    if (!auth.scopes.has(definition.requiredScope)) {
      return failure(403, 'MCP-E-INSUFFICIENT-SCOPE', 'La conexión del dueño no tiene el permiso que pide este comando.', 'Pide al dueño reconectar SaleADS con el permiso indicado.', {details: {required_scope: definition.requiredScope}});
    }
    const validate = validators.get(definition.name)!;
    if (typeof args !== 'object' || args === null || Array.isArray(args) || !validate(args)) {
      return failure(400, 'MCP-E-INVALID-INPUT', 'Los argumentos no cumplen el contrato del comando.', 'Revisa los campos de details.fields con GET /agent/v1/commands/<nombre> y vuelve a llamar.', {
        details: {fields: typeof args === 'object' && args !== null && !Array.isArray(args) ? errorFields(validate.errors) : ['/']},
      });
    }
    try {
      const result = await tool.handler(args as Record<string, unknown>, {auth, era: null, transport: 'rest'});
      log({tool: definition.name, transport: 'rest', outcome: result.isError ? 'tool_error' : tool.generic ? 'ok_generic' : 'ok', user: auth.userId});
      const structured = result.structuredContent ?? {};
      if (result.isError) {
        const error = (structured as {error?: Record<string, unknown>}).error ?? {};
        const code = typeof error.code === 'string' ? error.code : 'MCP-E-UPSTREAM-UNAVAILABLE';
        return {status: STATUS_BY_CODE[code] ?? 200, body: {
          ok: false, code, message: error.message, ...(error.next_action ? {next_action: error.next_action} : {}),
          retryable: error.retryable === true, ...(error.details ? {details: error.details} : {}), ...(error.action_url ? {action_url: error.action_url} : {}),
        }};
      }
      const operationId = (structured as {operation_id?: unknown}).operation_id;
      return {status: 200, body: {ok: true, data: structured, ...(typeof operationId === 'string' ? {operation_id: operationId} : {})}};
    } catch (error) {
      console.error(JSON.stringify({msg: 'agent_api.exception', command: definition.name, error: (error as Error)?.name}));
      return {status: 500, body: {ok: false, code: 'MCP-E-UPSTREAM-UNAVAILABLE', message: 'Error interno al ejecutar el comando.', retryable: true}};
    }
  }

  return {
    enabledCommands: () => catalog.map((c) => c.name),
    async serve(req: IncomingMessage, res: ServerResponse, url: URL, command: string | undefined) {
      const out = await handle(req, url, command);
      sendJson(res, out.status, out.body, {...NO_STORE, ...(out.headers ?? {})});
    },
  };
}
