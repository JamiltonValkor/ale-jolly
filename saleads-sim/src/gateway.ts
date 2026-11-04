import {createHash} from 'node:crypto';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {verifyWebToken} from './auth';
import type {SimConfig} from './config';
import {bearer, readBody, readJson, sendJson} from './http-util';
import type {RealmKeys} from './keys';
import type {Store} from './store';

/**
 * Gateway clásico mínimo que usa el front de Meta Assistant, con el token web
 * (`azp = front`) y el sobre `{success, data}` de los servicios:
 *
 * - `GET|PUT /api/subscription/language` (+ `/supported`)
 * - `GET|PUT /api/subscription/credits/agent-cap`
 * - `GET /api/campaigns/agentic/v1/*` (traza del agente, derivada de sus apuestas)
 * - `GET /api/integration/meta/configuration`
 *
 * Y PostHog: `/flags`/`/decide` con las banderas en verdadero y la captura
 * (`/capture`, `/batch`, `/e`, …) que descarta los eventos.
 */

const LANGUAGES = ['es', 'en', 'pt'];
const CAPTURE = /^\/(capture|batch|e|track|engage|s|i\/v0\/e)\/?$/;

const uuidFrom = (seed: string) => {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export function corsHeaders(config: SimConfig, req: IncomingMessage): Record<string, string> {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  const allowed = config.corsOrigins.includes('*') ? origin || '*' : config.corsOrigins.includes(origin) ? origin : '';
  if (!allowed) return {};
  return {
    'access-control-allow-origin': allowed,
    'access-control-allow-headers': 'authorization, content-type, x-business-id, x-request-id, sentry-trace, baggage, traceparent, tracestate',
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}

export async function handleGateway(config: SimConfig, keys: RealmKeys, store: Store, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  const cors = corsHeaders(config, req);
  const isPosthog = /^\/(decide|flags)\/?$/.test(path) || CAPTURE.test(path);
  if (!path.startsWith('/api/') && !isPosthog) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return true;
  }
  const reply = (status: number, body: unknown) => sendJson(res, status, body, cors);

  if (/^\/(decide|flags)\/?$/.test(path)) {
    let requested: string[] = [];
    try {
      const body = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8') || '{}') as {flag_keys_to_evaluate?: unknown};
      if (Array.isArray(body.flag_keys_to_evaluate)) requested = body.flag_keys_to_evaluate.filter((k): k is string => typeof k === 'string');
    } catch {/* posthog-js puede mandar el cuerpo comprimido: se ignora */}
    const keysOn = [...new Set([...config.posthogFlags, ...requested])];
    reply(200, {
      flags: Object.fromEntries(keysOn.map((key, i) => [key, {key, enabled: true, variant: null,
        reason: {code: 'condition_match', condition_index: 0, description: 'simulado: siempre activo'},
        metadata: {id: i + 1, version: 1, payload: null}}])),
      featureFlags: Object.fromEntries(keysOn.map((key) => [key, true])),
      featureFlagPayloads: {},
      errorsWhileComputingFlags: false,
      quotaLimited: [],
      requestId: uuidFrom(`${Date.now()}:${Math.random()}`),
      config: {enable_collect_everything: false},
      sessionRecording: false,
      supportedCompression: [],
    });
    return true;
  }
  if (CAPTURE.test(path)) {
    await readBody(req, 8 * 1024 * 1024).catch(() => undefined);
    reply(200, {status: 1});
    return true;
  }

  const userId = await verifyWebToken(config, keys, bearer(req));
  if (!userId) {
    reply(401, {error: 'Unauthorized'});
    return true;
  }
  const account = store.account(userId);

  if (path === '/api/subscription/language') {
    if (req.method === 'PUT' || req.method === 'POST') {
      const body = ((await readJson(req, 16 * 1024).catch(() => undefined)) ?? {}) as {language_code?: unknown};
      if (typeof body.language_code !== 'string' || !LANGUAGES.includes(body.language_code)) {
        reply(400, {success: false, error: 'INVALID_LANGUAGE'});
        return true;
      }
      account.language_code = body.language_code;
      account.language_updated_at = new Date().toISOString();
      store.save();
    }
    reply(200, {success: true, data: {user_id: userId, language_code: account.language_code, updated_at: account.language_updated_at}});
    return true;
  }
  if (path === '/api/subscription/language/supported') {
    reply(200, {success: true, data: [{code: 'es', name: 'Español'}, {code: 'en', name: 'English'}, {code: 'pt', name: 'Português'}]});
    return true;
  }
  if (path === '/api/subscription/credits/agent-cap') {
    if (req.method === 'PUT') {
      const body = ((await readJson(req, 16 * 1024).catch(() => undefined)) ?? {}) as {cap?: unknown};
      if (typeof body.cap !== 'number' || !Number.isInteger(body.cap) || body.cap < 0) {
        reply(400, {success: false, error: 'INVALID_CAP'});
        return true;
      }
      account.agent_cap = body.cap;
      store.save();
    }
    const start = new Date();
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);
    const used = 120;
    reply(200, {success: true, data: {
      cap: account.agent_cap, used_this_period: used, remaining: account.agent_cap === null ? null : Math.max(0, account.agent_cap - used),
      period_start: start.toISOString(), period_end: end.toISOString(),
    }});
    return true;
  }
  if (path === '/api/integration/meta/configuration') {
    const businessId = url.searchParams.get('businessId') ?? (typeof req.headers['x-business-id'] === 'string' ? req.headers['x-business-id'] : '');
    if (!store.ownedBusiness(userId, businessId)) {
      reply(404, {success: false, error: 'NOT_FOUND'});
      return true;
    }
    reply(200, {
      simulated: true, businessId,
      oauthData: {selectedAdAccountId: 'act_000000000000001', verifiedAdAccountCurrency: {accountId: '000000000000001', currency: 'COP'}},
    });
    return true;
  }
  const prefix = '/api/campaigns/agentic/v1';
  if (path.startsWith(prefix) && req.method === 'GET') {
    const rest = path.slice(prefix.length);
    let m = /^\/businesses\/([0-9a-f-]{36})\/agent-actions$/.exec(rest);
    if (m) {
      if (!store.ownedBusiness(userId, m[1])) reply(200, {success: true, data: {items: [], next_cursor: null}});
      else reply(200, {success: true, data: {items: agentActions(store, m[1]), next_cursor: null}});
      return true;
    }
    m = /^\/agent-actions\/([0-9a-f-]{36})$/.exec(rest);
    if (m) {
      const owned = store.businessesOf(userId).flatMap((b) => agentActions(store, b.id));
      const action = owned.find((a) => a.agent_action_id === m![1]);
      if (!action) reply(404, {success: false, error: 'AGENT_ACTION_NOT_FOUND'});
      else reply(200, {success: true, data: {...action, steps: [{seq: 1, step_kind: 'state_changed', platform_object_type: null, platform_object_id: null,
        before_value: null, after_value: {state: 'succeeded'}, error: null, writer: 'saleads-sim', at: action.created_at}], spend: null, spend_source: 'none'}});
      return true;
    }
    if (/^\/objects\/[^/]+\/[^/]+\/agent-actions$/.test(rest)) {
      reply(200, {success: true, data: {items: [], next_cursor: null}});
      return true;
    }
  }
  // Ruta del gateway que la demo no imita: 404 sin contrato = «no disponible» en el BFF.
  reply(404, {error: 'Not Found', simulated: true});
  return true;
}

/** Traza del agente (campaign-service AAB-010) derivada de sus apuestas y landings. Simulada. */
function agentActions(store: Store, businessId: string) {
  const bets = Object.values(store.state.bets).filter((b) => b.business_id === businessId).map((b) => ({
    agent_action_id: uuidFrom(`action:bet:${b.bet_id}`), business_id: businessId, trace_id: uuidFrom(`trace:${b.communication_strategy_version_id}`),
    kind: 'register_bets', subject_type: 'bet', subject_id: b.bet_id, campaign_id: null, bet_ref: null, skill_ref: null,
    request_summary: `Apuesta «${b.label}» (vuelta ${b.round_number}) · simulado`, request_args: null, approval_required: false, approval_id: null,
    state: 'succeeded', outcome_summary: `Estado: ${b.state}`, created_at: b.state_at, executed_at: b.state_at,
  }));
  const landings = Object.values(store.state.landings).filter((l) => l.business_id === businessId).map((l) => ({
    agent_action_id: uuidFrom(`action:landing:${l.id}`), business_id: businessId, trace_id: uuidFrom(`trace:landing:${l.id}`),
    kind: 'landing_create', subject_type: 'landing', subject_id: l.id, campaign_id: null, bet_ref: null, skill_ref: null,
    request_summary: `Landing «${l.name}» · simulado`, request_args: null, approval_required: true, approval_id: null,
    state: l.status === 'published' ? 'succeeded' : 'pending_approval', outcome_summary: `Versiones: ${l.latestN ?? 0}`,
    created_at: l.created_at, executed_at: l.status === 'published' ? l.updated_at : null,
  }));
  return [...bets, ...landings].sort((a, b) => b.created_at.localeCompare(a.created_at));
}
