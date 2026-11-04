import 'reflect-metadata';
import {EventEmitter} from 'node:events';
import {createServer, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import type {INestApplication} from '@nestjs/common';
import {Test} from '@nestjs/testing';
import type {Request as ExpressRequest, Response as ExpressResponse} from 'express';
import request from 'supertest';
import {MetaInferenceRelay} from '../src/ai/meta-relay';
import {MAX_META_RELAY_BODY_BYTES, META_API_BASE_URL, META_MODEL_ID} from '../src/ai/meta-model';
import {AppModule} from '../src/app.module';
import {flagUnavailable} from '../src/domain/errors';
import {configureApp} from '../src/http/configure-app';
import {MetaRelayController} from '../src/http/meta-relay.controller';
import {nextTransition} from '../src/lifecycle/readiness';
import type {AssistantRow} from '../src/persistence/assistant-repository';
import {Database} from '../src/persistence/database';
import {FieldCipher} from '../src/security/field-cipher';
import {IdentityVerifier} from '../src/security/identity';
import {ISSUER, testKeys} from './support/tokens';

const OWNER_A = 'owner-a', OWNER_B = 'unrelated-owner-b';
const UPSTREAM_KEY = 'synthetic-backend-only-meta-key';
const FRAME = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Olá ✓"}\n\n';
const DONE = 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"synthetic-response","status":"completed"}}\n\n';
const INPUT = {model: META_MODEL_ID, input: [{role: 'user', content: 'Synthetic request'}], stream: true};

describe('account-bound managed Meta Responses relay', () => {
  let app: INestApplication, upstream: Server, origin: string, backend: string, relay: MetaInferenceRelay;
  let mode = 'sse', onUpstreamClose: (() => void) | undefined;
  const cipher = new FieldCipher(Buffer.alloc(32, 29));
  const rows = new Map<string, AssistantRow>();
  const findActive = jest.fn(async (owner: string) => rows.get(owner) ?? null);
  const flag = {isEnabled: jest.fn(async (_owner: string) => true)};
  const tokens = new Map<string, string>();
  const calls: Array<{url: string; init: RequestInit; body: Record<string, unknown>}> = [];
  const route = '/meta-inference/v1/responses';
  const fetcher = jest.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({url: String(url), init: init!, body: JSON.parse(String(init?.body)) as Record<string, unknown>});
    return fetch(origin + '/responses', init);
  });

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      req.resume();
      req.once('end', () => {
        if (mode === 'redirect') {res.writeHead(307, {location: origin + '/must-not-follow'}).end(); return;}
        if (mode === 'error' || mode === 'rate-limit') {
          res.writeHead(mode === 'error' ? 401 : 429, {'content-type': 'application/json'}).end(JSON.stringify({api_key: UPSTREAM_KEY, private: 'synthetic-private-error'})); return;
        }
        if (mode === 'json') {res.writeHead(200, {'content-type': 'application/json'}).end('{"id":"synthetic-json","output":[]}'); return;}
        res.writeHead(200, {'content-type': 'text/event-stream; charset=utf-8'});
        res.write(FRAME.slice(0, 43)); res.write(FRAME.slice(43));
        if (mode === 'hold') {res.once('close', () => onUpstreamClose?.()); return;}
        res.end(DONE);
      });
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    origin = 'http://127.0.0.1:' + (upstream.address() as AddressInfo).port;
    for (const owner of [OWNER_A, OWNER_B]) rows.set(owner, {
      user_id: owner, status: 'ready', step: null, instance_name: 'vm-' + owner,
      api_server_key_enc: cipher.seal('assistants.api_server_key_enc', owner, 'control-secret-' + owner),
    } as AssistantRow);
    relay = new MetaInferenceRelay({scope: {enabled: true, userId: OWNER_A, allUsers: true}, apiKey: UPSTREAM_KEY, timeoutMs: 300_000},
      {repository: {findActive}, cipher, flag, fetcher});
    for (const owner of [OWNER_A, OWNER_B]) tokens.set(owner, (await relay.credentialForUser(owner))!);
    const keys = await testKeys();
    const module = await Test.createTestingModule({imports: [AppModule.register({
      database: new Database({query: jest.fn(), end: jest.fn()} as never), cipher, flag, metaRelay: relay,
      identity: new IdentityVerifier({issuer: ISSUER, audience: '', clients: ['front']}, keys.jwks),
    })]}).compile();
    app = configureApp(module.createNestApplication({bodyParser: false, logger: false}));
    await app.listen(0, '127.0.0.1');
    backend = await app.getUrl();
    flag.isEnabled.mockClear();
  });
  beforeEach(() => {mode = 'sse'; flag.isEnabled.mockReset().mockResolvedValue(true); calls.length = 0; fetcher.mockClear(); findActive.mockClear();});
  afterAll(async () => {await app.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));});
  const post = (owner = OWNER_A, body: unknown = INPUT) => request(app.getHttpServer()).post(route)
    .set('Authorization', 'Bearer ' + tokens.get(owner)).send(body as object);

  it('uses distinct inference-only credentials for unrelated assistants, not the platform or control key', async () => {
    expect(tokens.get(OWNER_A)).not.toBe(tokens.get(OWNER_B));
    for (const owner of [OWNER_A, OWNER_B]) {
      expect(await relay.credentialForUser(owner)).toBe(tokens.get(owner));
      expect(tokens.get(owner)).not.toContain(UPSTREAM_KEY);
      expect(tokens.get(owner)).not.toContain('control-secret-');
      expect(tokens.get(owner)).not.toBe('control-secret-' + owner);
      const response = await post(owner).expect(200);
      expect(response.text).toBe(FRAME + DONE);
      expect(flag.isEnabled).toHaveBeenLastCalledWith(owner);
      expect(calls.at(-1)!.url).toBe(META_API_BASE_URL + '/responses');
      expect(calls.at(-1)!.init).toMatchObject({method: 'POST', redirect: 'error',
        headers: {authorization: 'Bearer ' + UPSTREAM_KEY, 'content-type': 'application/json'}});
      expect(calls.at(-1)!.body).toEqual({...INPUT, store: false});
    }
  });

  it('rejects missing, forged, unknown and control credentials before making a provider request', async () => {
    await request(app.getHttpServer()).post(route).send(INPUT).expect(401);
    const a = tokens.get(OWNER_A)!;
    for (const token of [UPSTREAM_KEY, 'control-secret-' + OWNER_A, 'web.jwt.token',
      a.replace(Buffer.from(OWNER_A).toString('base64url'), Buffer.from(OWNER_B).toString('base64url')),
      a.replace(Buffer.from(OWNER_A).toString('base64url'), Buffer.from('unknown-account').toString('base64url')),
      a.slice(0, -2) + 'AA']) {
      const response = await request(app.getHttpServer()).post(route).set('Authorization', 'Bearer ' + token).send(INPUT).expect(401);
      expect(JSON.stringify(response.body)).not.toContain(token);
    }
    expect(flag.isEnabled).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });

  it('rechecks the existing per-owner feature flag and fails closed when it is false or unavailable', async () => {
    flag.isEnabled.mockResolvedValue(false);
    await post(OWNER_B).expect(403);
    expect(flag.isEnabled).toHaveBeenLastCalledWith(OWNER_B);
    expect(await relay.credentialForUser(OWNER_B)).toBeNull();
    flag.isEnabled.mockRejectedValue(flagUnavailable());
    await post(OWNER_B).expect(503);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps an issued probe credential valid when readiness observes the configuration restart', async () => {
    const row = rows.get(OWNER_B)!;
    const original = {...row};
    try {
      row.status = 'activating'; row.step = 'configure_ai';
      const token = await relay.credentialForUser(OWNER_B);
      expect(token).toBe(tokens.get(OWNER_B));
      const now = new Date();
      const transition = nextTransition({...row, updated_at: now}, {vm: 'running', ip: null, hermes: 'not_responding'}, now, 90_000)!;
      expect(transition).toMatchObject({status: 'activating', step: 'installing_agent'});
      row.status = transition.status; row.step = transition.step;
      // The restart may lower readiness after delivery but before Hermes sends its probe.
      expect(await relay.credentialForUser(OWNER_B)).toBeNull();
      const response = await request(app.getHttpServer()).post(route).set('Authorization', 'Bearer ' + token).send(INPUT).expect(200);
      expect(response.text).toBe(FRAME + DONE);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(flag.isEnabled).toHaveBeenLastCalledWith(OWNER_B);
    } finally {rows.set(OWNER_B, original);}
  });

  it('allows the configure-ai probe but rejects ineligible phases, missing bindings and revoked credentials', async () => {
    const row = rows.get(OWNER_B)!;
    const original = {...row};
    try {
      row.status = 'activating'; row.step = 'configure_ai';
      await post(OWNER_B).expect(200);
      calls.length = 0; fetcher.mockClear();
      for (const status of ['stopped', 'failed', 'deleting'] as const) {
        row.status = status;
        expect(await relay.credentialForUser(OWNER_B)).toBeNull();
        await post(OWNER_B).expect(401);
      }
      row.status = 'activating';
      for (const step of ['preparing_access', 'preparing_environment', null] as const) {
        row.step = step;
        expect(await relay.credentialForUser(OWNER_B)).toBeNull();
        await post(OWNER_B).expect(401);
      }
      row.step = 'installing_agent';
      for (const patch of [{instance_name: null}, {api_server_key_enc: null}, {user_id: OWNER_A}]) {
        Object.assign(row, patch);
        await post(OWNER_B).expect(401);
        Object.assign(row, original, {status: 'activating', step: 'installing_agent'});
      }
      flag.isEnabled.mockResolvedValue(false);
      await post(OWNER_B).expect(403);
      flag.isEnabled.mockResolvedValue(true);
      await post(OWNER_B, {...INPUT, model: 'other-model'}).expect(400);
      row.api_server_key_enc = cipher.seal('assistants.api_server_key_enc', OWNER_B, 'rotated-control-secret');
      await post(OWNER_B).expect(401);
      row.status = 'ready'; row.step = null;
      await post(OWNER_B).expect(401);
      expect(await relay.credentialForUser(OWNER_B)).not.toBe(tokens.get(OWNER_B));
      rows.delete(OWNER_B); await post(OWNER_B).expect(401);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {rows.set(OWNER_B, original);}
  });

  it.each([
    {model: 'other-model'}, {model: META_MODEL_ID, tools: [{type: 'file_search'}]},
    {model: META_MODEL_ID, previous_response_id: 'foreign-response'}, {model: META_MODEL_ID, conversation: 'foreign-conversation'},
    {model: META_MODEL_ID, background: true}, {model: META_MODEL_ID, input: [{type: 'item_reference', id: 'foreign-item'}]},
    {model: META_MODEL_ID, input: [{type: 'input_file', file_id: 'foreign-file'}]},
    {model: META_MODEL_ID, input: [{role: 'user', content: [{type: 'input_image', file_id: 'foreign-image'}]}]},
  ])('rejects a changed model or provider-side state reference %#', async body => {
    await post(OWNER_B, body).expect(400); expect(fetcher).not.toHaveBeenCalled();
  });

  it('preserves function tools, hosted web search and native local history while disabling provider storage', async () => {
    const body = {...INPUT, store: true, tools: [{type: 'function', name: 'saleads_read', parameters: {type: 'object'}}, {type: 'web_search'}],
      input: [{role: 'user', content: 'Prior message'}, {type: 'function_call', name: 'saleads_read', call_id: 'local-call', arguments: '{}'},
        {type: 'function_call_output', call_id: 'local-call', output: '{"ok":true}'}]};
    await post(OWNER_B, body).expect(200);
    expect(calls[0]!.body).toEqual({...body, store: false});
    const images = {...INPUT, input: [{role: 'user', content: [
      {type: 'input_image', image_url: 'https://assets.example.invalid/owner-image.png'},
      {type: 'input_image', image_url: 'data:image/png;base64,c3ludGhldGlj'},
    ]}]};
    await post(OWNER_B, images).expect(200);
    expect(calls.at(-1)!.body).toEqual({...images, store: false});
    mode = 'json';
    const response = await post(OWNER_B, {...INPUT, stream: false}).expect(200);
    expect(response.text).toBe('{"id":"synthetic-json","output":[]}');
  });

  it('allows bounded native context above 128 KiB only on this relay route', async () => {
    await post(OWNER_B, {...INPUT, input: 'x'.repeat(150_000)}).expect(200);
    expect(calls).toHaveLength(1);
    await post(OWNER_B, {...INPUT, input: 'x'.repeat(MAX_META_RELAY_BODY_BYTES)}).expect(413);
    await request(app.getHttpServer()).put('/assistants/me/ai').send({oversized: 'x'.repeat(150_000)}).expect(413);
    expect(calls).toHaveLength(1);
    await request(app.getHttpServer()).get('/meta-inference/v1/models').expect(404);
    await request(app.getHttpServer()).get(route + '/foreign-response').expect(404);
  });

  it.each(['error', 'rate-limit', 'redirect'])('does not retry or expose the provider error body for %s', async value => {
    mode = value;
    const response = await post(OWNER_B).expect(value === 'rate-limit' ? 429 : value === 'redirect' ? 503 : 502);
    expect(JSON.stringify(response.body)).not.toMatch(/synthetic-backend|synthetic-private|mr1\./);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(calls[0]!.init.redirect).toBe('error');
  });

  it('aborts the upstream stream promptly when the VM disconnects', async () => {
    mode = 'hold';
    let closed!: () => void;
    const upstreamClosed = new Promise<void>(resolve => {closed = resolve;});
    onUpstreamClose = closed;
    const abort = new AbortController();
    const response = await fetch(backend + route, {method: 'POST', headers: {authorization: 'Bearer ' + tokens.get(OWNER_B), 'content-type': 'application/json'},
      body: JSON.stringify(INPUT), signal: abort.signal});
    await response.body!.getReader().read();
    abort.abort();
    await Promise.race([upstreamClosed, new Promise((_, reject) => {const timeout = setTimeout(() => reject(new Error('upstream_not_cancelled')), 2000); timeout.unref();})]);
    expect(calls[0]!.init.signal!.aborted).toBe(true);
    onUpstreamClose = undefined;
  });
});

it('waits for response drain before reading another Meta stream chunk', async () => {
  let reads = 0, resume!: () => void;
  const stream = new ReadableStream<Uint8Array>({pull(controller) {
    reads++;
    if (reads === 1) controller.enqueue(Buffer.from('first'));
    else if (reads === 2) controller.enqueue(Buffer.from('second'));
    else controller.close();
  }}, {highWaterMark: 0});
  const response = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const writes: string[] = [];
  response.status = () => response; response.setHeader = () => response; response.flushHeaders = () => undefined;
  response.write = (chunk: Uint8Array) => {writes.push(Buffer.from(chunk).toString()); if (writes.length === 1) resume(); return writes.length > 1;};
  response.end = () => {response.writableEnded = true; response.writableFinished = true;};
  const paused = new Promise<void>(resolve => {resume = resolve;});
  const controller = new MetaRelayController({responses: async () => new Response(stream, {headers: {'content-type': 'text/event-stream'}})} as unknown as MetaInferenceRelay);
  const pending = controller.responses({headers: {authorization: 'Bearer synthetic'}} as ExpressRequest, INPUT, response as unknown as ExpressResponse);
  await paused;
  expect(reads).toBe(1); expect(writes).toEqual(['first']);
  response.emit('drain'); await pending;
  expect(writes).toEqual(['first', 'second']);
});
