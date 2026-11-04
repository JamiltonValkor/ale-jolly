import {ComputeError} from '../src/compute/compute-client';
import {RestInstanceClient} from '../src/compute/instance-client';
import {HttpHermesClient, PROBE_SESSION_ID, sessionShortId} from '../src/hermes/hermes-client';
import {outboundFetch} from '../src/outbound/http-client';
import {RestInstanceMetadata} from '../src/renewal/instance-metadata';

const TARGET = {ip: '10.128.0.42', apiServerKey: 'apikey-SECRET-0123456789abcdef'}; // gitleaks:allow -- synthetic test credential
const UA = 'SaleADS-Assistant-Service/0.1 (+https://saleads.ai)';

type Call = {url: string; method: string; headers: Headers; body: string | null};

function fakeFetch(routes: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const base = (async (input: string | URL, init: RequestInit = {}) => {
    const call = {url: String(input), method: init.method ?? 'GET', headers: new Headers(init.headers), body: (init.body as string) ?? null};
    calls.push(call);
    return routes(call);
  }) as typeof fetch;
  return {calls, fetcher: outboundFetch({userAgent: UA, timeoutMs: 5000}, base)};
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
const sse = (frames: Array<[string, Record<string, unknown>]>) => new Response(
  frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify({session_id: PROBE_SESSION_ID, run_id: 'run_1', seq: 1, ts: 1, ...data})}\n\n`).join('') + ': keepalive\n\n',
  {status: 200, headers: {'content-type': 'text/event-stream'}});

describe('HttpHermesClient (OCB-008/010)', () => {
  it('health: lee platform, status y readiness.checks con Bearer y User-Agent explícito', async () => {
    const {calls, fetcher} = fakeFetch(() => json({status: 'degraded', platform: 'hermes-agent', readiness: {status: 'degraded', checks: {
      state_db: {status: 'ok', detail: 'not initialized'}, model: {status: 'degraded'}, disk: {status: 'ok', used_percent: 3}}}}));
    const health = await new HttpHermesClient(fetcher, 8642).health(TARGET, 3000);
    expect(health).toEqual({kind: 'answered', platform: 'hermes-agent', status: 'degraded', checks: {state_db: 'ok', model: 'degraded', disk: 'ok'}});
    expect(calls[0]!.url).toBe('http://10.128.0.42:8642/health/detailed');
    expect(calls[0]!.headers.get('authorization')).toBe(`Bearer ${TARGET.apiServerKey}`);
    expect(calls[0]!.headers.get('user-agent')).toBe(UA);
  });

  it('health: 401 → unauthorized, 500 → http_error, red → unreachable', async () => {
    expect(await new HttpHermesClient(fakeFetch(() => json({error: 'x'}, 401)).fetcher, 8642).health(TARGET, 3000)).toEqual({kind: 'unauthorized'});
    expect(await new HttpHermesClient(fakeFetch(() => json({}, 500)).fetcher, 8642).health(TARGET, 3000)).toEqual({kind: 'http_error', status: 500});
    expect(await new HttpHermesClient(fakeFetch(() => {throw new TypeError('ECONNREFUSED');}).fetcher, 8642).health(TARGET, 3000))
      .toEqual({kind: 'unreachable'});
  });

  const probeRoutes = (stream: () => Response) => (call: Call) => {
    if (call.method === 'DELETE') return json({}, 404);
    if (call.url.endsWith('/api/sessions')) return json({object: 'hermes.session'}, 201);
    return stream();
  };

  it('turno de prueba por Sessions SSE: run.completed → completed; borra la sesión de prueba antes y después', async () => {
    const {calls, fetcher} = fakeFetch(probeRoutes(() => sse([
      ['run.started', {}], ['message.started', {}], ['assistant.delta', {delta: 'OK'}],
      ['assistant.completed', {content: 'OK', completed: true}], ['run.completed', {completed: true}], ['done', {}],
    ])));
    expect(await new HttpHermesClient(fetcher, 8642).probeTurn(TARGET, 'ping', 10_000)).toEqual({kind: 'completed'});
    expect(calls.map(c => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      `DELETE /api/sessions/${PROBE_SESSION_ID}`, 'POST /api/sessions',
      `POST /api/sessions/${PROBE_SESSION_ID}/chat/stream`, `DELETE /api/sessions/${PROBE_SESSION_ID}`,
    ]);
    expect(JSON.parse(calls[1]!.body!)).toMatchObject({id: PROBE_SESSION_ID});
    expect(JSON.parse(calls[2]!.body!)).toEqual({message: 'ping'});
  });

  it('key rechazada (G-07): run.failed con el aviso del proveedor en assistant.completed → failed + texto para clasificar', async () => {
    const {fetcher} = fakeFetch(probeRoutes(() => sse([
      ['run.started', {}], ['assistant.completed', {content: 'OpenRouter rejected your API key, so the model can\'t be reached. HTTP 401', completed: false}],
      ['run.failed', {completed: false, partial: false, interrupted: false}], ['done', {}],
    ])));
    const outcome = await new HttpHermesClient(fetcher, 8642).probeTurn(TARGET, 'ping', 10_000);
    expect(outcome).toMatchObject({kind: 'failed'});
    expect((outcome as {text: string}).text).toContain('rejected your API key');
  });

  it('error del agente (p. ej. contexto < 64K al iniciar) → failed; stream sin cierre → unreachable; 401 → unauthorized', async () => {
    const failing = fakeFetch(probeRoutes(() => sse([['error', {message: 'which is below the minimum 64,000 required'}], ['done', {}]])));
    expect(await new HttpHermesClient(failing.fetcher, 8642).probeTurn(TARGET, 'ping', 10_000))
      .toEqual({kind: 'failed', text: 'which is below the minimum 64,000 required'});
    const cut = fakeFetch(probeRoutes(() => sse([['run.started', {}]])));
    expect(await new HttpHermesClient(cut.fetcher, 8642).probeTurn(TARGET, 'ping', 10_000)).toEqual({kind: 'unreachable', reason: 'stream_ended'});
    const denied = fakeFetch(call => call.method === 'DELETE' ? json({}, 401) : json({}, 401));
    expect(await new HttpHermesClient(denied.fetcher, 8642).probeTurn(TARGET, 'ping', 10_000)).toEqual({kind: 'unauthorized'});
  });
});

describe('HttpHermesClient.ensureSession: títulos únicos (IVB-023)', () => {
  const taken = json({error: {message: "Title 'SaleADS' is already in use by session saleads-main", type: 'invalid_request_error', param: null, code: 'invalid_title'}}, 400);

  it('título repetido: reintenta una vez con el sufijo del id y queda ok', async () => {
    const {calls, fetcher} = fakeFetch(call => JSON.parse(call.body!).title === 'SaleADS' ? taken : json({}, 201));
    expect(await new HttpHermesClient(fetcher, 8642).ensureSession(TARGET, 'saleads-flow-f4ef3532-9587-48bc-82b4-4dcac01525ca', 3000)).toEqual({kind: 'ok'});
    expect(calls.map(call => JSON.parse(call.body!).title)).toEqual(['SaleADS', 'SaleADS f4ef3532']);
  });

  it('si el reintento también choca, es rechazo de Hermes y no un reinicio', async () => {
    const {calls, fetcher} = fakeFetch(() => json({error: {code: 'invalid_title'}}, 400));
    expect(await new HttpHermesClient(fetcher, 8642).ensureSession(TARGET, 'saleads-flow-f4ef3532-x', 3000, 'SaleADS', 'robot'))
      .toEqual({kind: 'rejected', status: 400, code: 'invalid_title'});
    expect(calls).toHaveLength(2);
  });

  it('otro 4xx no reintenta; 409, 5xx y red siguen como antes', async () => {
    const other = fakeFetch(() => json({error: {code: 'bad'}}, 422));
    expect(await new HttpHermesClient(other.fetcher, 8642).ensureSession(TARGET, 's1', 3000)).toEqual({kind: 'rejected', status: 422, code: 'bad'});
    expect(other.calls).toHaveLength(1);
    expect(await new HttpHermesClient(fakeFetch(() => json({}, 409)).fetcher, 8642).ensureSession(TARGET, 's1', 3000)).toEqual({kind: 'ok'});
    expect(await new HttpHermesClient(fakeFetch(() => json({}, 502)).fetcher, 8642).ensureSession(TARGET, 's1', 3000)).toEqual({kind: 'unreachable', reason: 'session_502'});
    expect(await new HttpHermesClient(fakeFetch(() => {throw new TypeError('ECONNREFUSED');}).fetcher, 8642).ensureSession(TARGET, 's1', 3000))
      .toEqual({kind: 'unreachable', reason: 'network'});
  });

  it('sufijo corto de la sesión', () => {
    expect(sessionShortId('saleads-flow-f4ef3532-9587')).toBe('f4ef3532');
    expect(sessionShortId('robot-6fc08a9b-123a')).toBe('6fc08a9b');
    expect(sessionShortId('saleads-main')).toBe('main');
  });
});

describe('HttpHermesClient: trabajos (MCB-003)', () => {
  const live = {
    id: '0123456789ab', name: 'saleads:loop-tick', prompt: 'p', skills: ['saleads-loop-orchestration'], skill: 'saleads-loop-orchestration',
    schedule: {kind: 'cron', expr: '0 */3 * * *', display: '0 */3 * * *'}, enabled: false, state: 'paused',
    origin: {platform: 'api_server', chat_id: 'api', peer_ip: '10.0.0.9', source_ip: '10.0.0.9', user_agent: 'x'},
  };

  it('listJobs arma la vista con schedule objeto o cadena, sin IPs del origen, y descarta filas sin id', async () => {
    const {fetcher} = fakeFetch(() => json({jobs: [
      live,
      {id: 'aaaaaaaaaaaa', name: 'mi-recordatorio', prompt: 'x', skill: 'una', schedule: '0 9 * * *', state: 'scheduled', origin: {}},
      {name: 'sin-id', prompt: 'x'},
    ]}));
    const listed = await new HttpHermesClient(fetcher, 8642).listJobs(TARGET, 3000);
    expect(listed).toEqual({kind: 'ok', names: ['saleads:loop-tick', 'mi-recordatorio', 'sin-id'], jobs: [
      {id: '0123456789ab', name: 'saleads:loop-tick', prompt: 'p', skills: ['saleads-loop-orchestration'], enabled: false, origin: {platform: 'api_server', chatId: 'api'}},
      {id: 'aaaaaaaaaaaa', name: 'mi-recordatorio', prompt: 'x', skills: ['una'], enabled: true, origin: {platform: null, chatId: null}},
    ]});
    expect(JSON.stringify(listed)).not.toContain('10.0.0.9');
  });

  it('updateJob manda PATCH con solo las claves dadas y nunca enabled ni schedule', async () => {
    const {calls, fetcher} = fakeFetch(() => json(live));
    const client = new HttpHermesClient(fetcher, 8642);
    expect(await client.updateJob(TARGET, '0123456789ab', {prompt: 'nuevo', skills: ['a', 'b']}, 3000)).toEqual({kind: 'updated'});
    expect(await client.updateJob(TARGET, '0123456789ab', {skills: ['a']}, 3000)).toEqual({kind: 'updated'});
    expect(calls.map(call => `${call.method} ${new URL(call.url).pathname}`)).toEqual(['PATCH /api/jobs/0123456789ab', 'PATCH /api/jobs/0123456789ab']);
    expect(JSON.parse(calls[0]!.body!)).toEqual({prompt: 'nuevo', skills: ['a', 'b']});
    expect(JSON.parse(calls[1]!.body!)).toEqual({skills: ['a']});
    expect(calls[0]!.headers.get('authorization')).toBe(`Bearer ${TARGET.apiServerKey}`);
  });

  it('updateJob no llama con un id fuera del patrón de Hermes ni sin claves', async () => {
    const {calls, fetcher} = fakeFetch(() => json({}));
    const client = new HttpHermesClient(fetcher, 8642);
    expect(await client.updateJob(TARGET, '../../api/x', {prompt: 'p'}, 3000)).toEqual({kind: 'rejected', status: 0});
    expect(await client.updateJob(TARGET, '0123456789AB', {prompt: 'p'}, 3000)).toEqual({kind: 'rejected', status: 0});
    expect(await client.updateJob(TARGET, '0123456789ab', {}, 3000)).toEqual({kind: 'rejected', status: 0});
    expect(calls).toHaveLength(0);
  });

  it('updateJob mapea 404, 401/403, 400 y 5xx sin leer el cuerpo del error (puede citar el prompt)', async () => {
    let read = false;
    const failing = (status: number) => () => {
      const response = json({error: 'prompt rechazado: <texto del prompt>'}, status);
      const original = response.json.bind(response);
      response.json = async () => {read = true; return original();};
      return response;
    };
    const outcome = async (status: number) => new HttpHermesClient(fakeFetch(failing(status)).fetcher, 8642).updateJob(TARGET, '0123456789ab', {prompt: 'p'}, 3000);
    expect(await outcome(404)).toEqual({kind: 'not_found'});
    expect(await outcome(401)).toEqual({kind: 'unauthorized'});
    expect(await outcome(403)).toEqual({kind: 'unauthorized'});
    expect(await outcome(400)).toEqual({kind: 'rejected', status: 400});
    expect(await outcome(502)).toEqual({kind: 'unreachable', reason: 'job_502'});
    expect(read).toBe(false);
    expect(await new HttpHermesClient(fakeFetch(() => {throw new TypeError('ECONNREFUSED');}).fetcher, 8642).updateJob(TARGET, '0123456789ab', {prompt: 'p'}, 3000))
      .toEqual({kind: 'unreachable', reason: 'network'});
  });
});

describe('RestInstanceClient sobre el transporte compartido de OCB-009', () => {
  const tokens = {token: async () => 'gcp-token'};
  const name = `sa-assistant-${'b'.repeat(32)}`;
  const location = {project: 'saleads-dev', apiBase: 'https://compute.googleapis.com/compute/v1'};

  it('instances.get: estado, IP privada y metadata; 404 → null', async () => {
    const {calls, fetcher} = fakeFetch(call => call.url.includes('c'.repeat(32)) ? json({error: {errors: [{reason: 'notFound'}]}}, 404)
      : json({status: 'RUNNING', networkInterfaces: [{networkIP: '10.128.0.9'}], metadata: {fingerprint: 'abc=', items: [{key: 'k', value: 'v'}]}}));
    const client = new RestInstanceClient(new RestInstanceMetadata(location, tokens, fetcher), 'us-central1-a');
    expect(await client.getInstance(name)).toEqual({status: 'RUNNING', privateIp: '10.128.0.9', fingerprint: 'abc=', items: [{key: 'k', value: 'v'}]});
    expect(calls[0]!.url).toBe(`https://compute.googleapis.com/compute/v1/projects/saleads-dev/zones/us-central1-a/instances/${name}`);
    expect(calls[0]!.headers.get('user-agent')).toBe(UA);
    expect(await client.getInstance(`sa-assistant-${'c'.repeat(32)}`)).toBeNull();
    await expect(client.getInstance('not-an-assistant')).rejects.toBeInstanceOf(ComputeError);
  });

  it('setMetadata con fingerprint (412 → ComputeError 412) y guest attribute (404 → null)', async () => {
    let conflict = true;
    const {calls, fetcher} = fakeFetch(call => {
      if (call.url.includes('getGuestAttributes')) return call.url.includes('applied-version') ? json({variableValue: 'v1'}) : json({}, 404);
      if (call.url.endsWith('/setMetadata')) {
        if (conflict) {conflict = false; return json({error: {errors: [{reason: 'conditionNotMet'}]}}, 412);}
        return json({name: 'operation-1'});
      }
      return json({status: 'DONE'});
    });
    const client = new RestInstanceClient(new RestInstanceMetadata(location, tokens, fetcher, {operationTimeoutMs: 1000}), 'us-central1-a');
    await expect(client.setMetadata(name, 'fp', [{key: 'hermes-env', value: 'X=1\n'}])).rejects.toMatchObject({status: 412});
    await client.setMetadata(name, 'fp2', [{key: 'hermes-env', value: 'X=1\n'}]);
    expect(JSON.parse(calls.filter(c => c.url.endsWith('/setMetadata'))[1]!.body!)).toEqual({fingerprint: 'fp2', items: [{key: 'hermes-env', value: 'X=1\n'}]});
    expect(await client.guestAttribute(name, 'hermes/applied-version')).toBe('v1');
    expect(await client.guestAttribute(name, 'hermes/apply-status')).toBeNull();
  });
});
