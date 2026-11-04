import {createHash, randomBytes} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {AddressInfo} from 'node:net';
import Ajv2020 from 'ajv/dist/2020';
import addFormatsModule from 'ajv-formats';
import {createApp, type SimApp} from '../src/app';
import type {SimConfig} from '../src/config';

export const DEMO_BUSINESS = 'a6b8e93d-386f-4141-96ff-4b49e137728a';

export interface Harness {
  app: SimApp;
  base: string;
  close(): Promise<void>;
}

export async function start(overrides: Partial<SimConfig> = {}, fetchImpl?: typeof fetch): Promise<Harness> {
  const app = await createApp({
    port: 0, dataDir: mkdtempSync(join(tmpdir(), 'saleads-sim-')), asyncDelayMs: 50, syncWaitMs: 2000,
    metaAssistantToken: 'x'.repeat(40), ...overrides,
  }, {persist: false, ...(fetchImpl ? {fetch: fetchImpl} : {})});
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return {app, base, close: () => new Promise((resolve) => app.server.close(() => resolve()))};
}

export const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return {verifier, challenge: createHash('sha256').update(verifier, 'ascii').digest('base64url')};
};

export const SCOPE = 'openid offline_access saleads-mcp saleads:read saleads:strategy saleads:campaigns saleads:launch saleads:events';
export const REDIRECT = 'http://localhost:3000/api/sales-assistant/oauth/callback';

/** Flujo completo del asistente: authorize (PKCE, prompt=none) → code → token. */
export async function assistantTokens(h: Harness, scope = SCOPE) {
  const {verifier, challenge} = pkce();
  const auth = new URL(`${h.base}/realms/sale-ads/protocol/openid-connect/auth`);
  auth.search = new URLSearchParams({
    response_type: 'code', client_id: 'mcp-saleads-assistant-dev', redirect_uri: REDIRECT, scope,
    state: 'state-123', code_challenge: challenge, code_challenge_method: 'S256', prompt: 'none',
  }).toString();
  const redirect = await fetch(auth, {redirect: 'manual'});
  const location = new URL(redirect.headers.get('location')!);
  const code = location.searchParams.get('code')!;
  const token = await fetch(`${h.base}/realms/sale-ads/protocol/openid-connect/token`, {
    method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: 'mcp-saleads-assistant-dev'}),
  });
  return {location, status: token.status, body: await token.json() as Record<string, any>};
}

let rpcId = 1;
/** JSON-RPC `tools/call` como lo hace ale-runtime (`src/orqa/mcp-client.ts`): sin initialize, SSE. */
export async function rpc(h: Harness, token: string, method: string, params: unknown, version = '2025-11-25') {
  const id = rpcId++;
  // Era 2026-07-28: sobre por petición en `params._meta`, sin sesión ni initialize.
  if (version === '2026-07-28') {
    params = {...(params as object), _meta: {
      'io.modelcontextprotocol/protocolVersion': version,
      'io.modelcontextprotocol/clientInfo': {name: 'saleads-sim-test', version: '1.0.0'},
      'io.modelcontextprotocol/clientCapabilities': {},
    }};
  }
  const response = await fetch(`${h.base}/mcp`, {
    method: 'POST',
    headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': version,
      ...(version === '2026-07-28' ? {'mcp-method': method, ...(method === 'tools/call' ? {'mcp-name': String((params as {name: string}).name)} : {})} : {})},
    body: JSON.stringify({jsonrpc: '2.0', id, method, params}),
  });
  const text = await response.text();
  let message: any = null;
  if (response.headers.get('content-type')?.startsWith('text/event-stream')) {
    for (const block of text.split(/\n\n/)) {
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (!data) continue;
      const parsed = JSON.parse(data);
      if (parsed.id === id) message = parsed;
    }
  } else if (text) {
    message = JSON.parse(text);
  }
  return {status: response.status, message, headers: response.headers};
}

export async function callTool(h: Harness, token: string, name: string, args: Record<string, unknown>) {
  const {message, status} = await rpc(h, token, 'tools/call', {name, arguments: args});
  if (status !== 200 || !message?.result) throw new Error(`tools/call ${name} → HTTP ${status} ${JSON.stringify(message)}`);
  return message.result as {structuredContent?: any; content: Array<{text: string}>; isError?: boolean};
}

export async function agent(h: Harness, token: string, method: 'GET' | 'POST', name?: string, body?: unknown) {
  const response = await fetch(`${h.base}/agent/v1/commands${name ? `/${name}` : ''}`, {
    method, headers: {authorization: `Bearer ${token}`, accept: 'application/json', ...(body !== undefined ? {'content-type': 'application/json'} : {})},
    ...(body !== undefined ? {body: JSON.stringify(body)} : {}),
  });
  return {status: response.status, body: await response.json() as any};
}

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => void;
export function validator() {
  const ajv = new Ajv2020({strict: false, allErrors: true});
  addFormats(ajv);
  return ajv;
}

export const b64file = (content: string) => {
  const bytes = Buffer.from(content, 'utf8');
  return {encoding: 'base64', content: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length};
};
