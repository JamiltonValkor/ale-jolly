import {createHash, generateKeyPairSync, sign, verify} from 'node:crypto';
import {Logger, type LoggerService} from '@nestjs/common';
import {signedGetUrlV4, type BlobSigner} from '../src/lifecycle/memory-archive';
import {HttpMcpToolClient, type McpCallOutcome, type McpToolClient} from '../src/orqa/mcp-client';
import {SEED_SCHEMA, SeedService, seedObjectName, selectedBusinessId, type SeedStorage} from '../src/orqa/seed';
import type {AssistantEvent, AssistantRow} from '../src/persistence/assistant-repository';
import {FakeInstances, INSTANCE} from './support/hermes-fakes';

const USER = '11111111-1111-4111-8111-111111111111';
const B1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FOREIGN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TOKEN = 'eyJaccess-token-SECRET';
const NOW = new Date('2026-10-29T08:48:31.000Z');

class CaptureLogger implements LoggerService {
  readonly lines: string[] = [];
  log(message: unknown) {this.lines.push(String(message));}
  warn(message: unknown) {this.lines.push(String(message));}
  error(message: unknown) {this.lines.push(String(message));}
}

/** MCP simulado: el overview del dueño y un bootstrap por negocio (guionable). */
class FakeMcp implements McpToolClient {
  readonly calls: Array<{token: string; name: string; args: Record<string, unknown>}> = [];
  businesses = [B1, B2];
  bootstrap = new Map<string, McpCallOutcome>();

  async call(token: string, name: string, args: Record<string, unknown>): Promise<McpCallOutcome> {
    this.calls.push({token, name, args});
    if (name === 'saleads_get_account_overview') return {ok: true, data: {businesses: this.businesses.map(id => ({business_id: id, name: 'n'})), selected_business_id: B1}};
    const id = String(args.business_id);
    return this.bootstrap.get(id) ?? {ok: true, data: {schema_version: 'saleads-business-bootstrap/1', business_id: id, context: {facts: {offer: 'Example Beauty SECRET-FACT'}}}};
  }
}

class FakeStorage implements SeedStorage {
  readonly uploads = new Map<string, string>();
  async upload(object: string, body: Buffer): Promise<void> {this.uploads.set(object, body.toString('utf8'));}
  async signedGetUrl(object: string, now: Date, ttlSeconds: number): Promise<string> {
    return `https://storage.googleapis.com/saleads-dev-assistant-memories/${object}?X-Goog-Date=${now.toISOString()}&X-Goog-Expires=${ttlSeconds}&X-Goog-Signature=SIGNATURE-SECRET`;
  }
}

function setup() {
  const events: AssistantEvent[] = [];
  const row = {user_id: USER, status: 'ready', instance_name: INSTANCE} as unknown as AssistantRow;
  const instances = new FakeInstances();
  const mcp = new FakeMcp();
  const storage = new FakeStorage();
  let token: string | null = TOKEN;
  const service = new SeedService({ttlSeconds: 3600, toolTimeoutMs: 1000, debounceMs: 60_000}, {
    repository: {findActive: async () => row, appendEvent: async event => {events.push(event);}},
    instances, accessToken: async () => token, mcp, storage, now: () => NOW,
  });
  return {events, instances, mcp, storage, service, setToken: (value: string | null) => {token = value;}};
}

describe('semilla del cerebro (OSB-007)', () => {
  let logger: CaptureLogger;
  beforeEach(() => {logger = new CaptureLogger(); Logger.overrideLogger(logger);});

  it('con dos negocios del dueño la semilla trae dos entradas, sube por contenido y fija hermes-seed-url', async () => {
    const {service, storage, instances, mcp, events} = setup();
    await expect(service.refresh(USER)).resolves.toEqual({result: 'applied', businesses: 2, failed: 0});
    expect(mcp.calls.every(call => call.token === TOKEN)).toBe(true);
    const [object, body] = [...storage.uploads.entries()][0]!;
    const seed = JSON.parse(body) as {schema: string; generated_at: string; businesses: Array<{business_id: string}>};
    expect(seed.schema).toBe(SEED_SCHEMA);
    expect(seed.generated_at).toBe(NOW.toISOString());
    expect(seed.businesses.map(b => b.business_id)).toEqual([B1, B2]);
    expect(object).toBe(seedObjectName(USER, seed.businesses));
    expect(object).toMatch(new RegExp(`^seeds/${USER}/[0-9a-f]{16}\\.json$`));
    expect(instances.item('hermes-seed-url')).toContain(`/saleads-dev-assistant-memories/${object}?`);
    expect(instances.item('hermes-seed-url')).toContain('X-Goog-Expires=3600');
    expect(instances.item('hermes-mcp-tokens')).toBeDefined();
    expect(events.at(-1)).toMatchObject({kind: 'orqa.seed_published', detail: 'result=applied businesses=2 failed=0'});
  });

  it('un negocio ajeno nunca aparece: el bootstrap que devuelve otro negocio se descarta', async () => {
    const {service, storage, mcp, events} = setup();
    mcp.bootstrap.set(B2, {ok: true, data: {business_id: FOREIGN}});
    await service.refresh(USER);
    const body = [...storage.uploads.values()][0]!;
    expect(body).not.toContain(FOREIGN);
    expect(events).toContainEqual(expect.objectContaining({kind: 'orqa.seed_business_failed', detail: `business=${B2} code=business_mismatch`}));
  });

  it('el fallo de un negocio no bloquea a los otros y deja un evento con la causa', async () => {
    const {service, storage, mcp, events} = setup();
    mcp.bootstrap.set(B1, {ok: false, code: 'MCP-E-UPSTREAM-UNAVAILABLE'});
    await expect(service.refresh(USER)).resolves.toEqual({result: 'applied', businesses: 1, failed: 1});
    expect(JSON.parse([...storage.uploads.values()][0]!).businesses.map((b: {business_id: string}) => b.business_id)).toEqual([B2]);
    expect(events).toContainEqual(expect.objectContaining({kind: 'orqa.seed_business_failed', detail: `business=${B1} code=MCP-E-UPSTREAM-UNAVAILABLE`}));
  });

  it('ni el token, ni la URL firmada, ni el contenido de la semilla aparecen en eventos o logs', async () => {
    const {service, events, mcp} = setup();
    mcp.bootstrap.set(B2, {ok: false, code: 'MCP-E-UPSTREAM-UNAVAILABLE'});
    await service.refresh(USER);
    expect(events.length).toBeGreaterThan(1);
    const all = JSON.stringify(events) + logger.lines.join('\n');
    for (const secret of [TOKEN, 'SIGNATURE-SECRET', 'SECRET-FACT', 'X-Goog']) expect(all).not.toContain(secret);
  });

  it('con la misma semilla ya cargada en la VM no sube ni reescribe; si no se cargó, firma de nuevo', async () => {
    const {service, instances, storage} = setup();
    await service.refresh(USER);
    const url = instances.item('hermes-seed-url')!;
    const sets = instances.sets.length;
    const guest = instances.guestAttribute.bind(instances);
    instances.guestAttribute = async (name, key) => key === 'hermes/seed-status'
      ? `loaded:${createHash('sha256').update(url).digest('hex').slice(0, 12)}` : guest(name, key);
    await expect(service.refresh(USER)).resolves.toMatchObject({result: 'up_to_date'});
    expect(instances.sets).toHaveLength(sets);
    instances.guestAttribute = async (name, key) => key === 'hermes/seed-status' ? 'failed:403' : guest(name, key);
    await expect(service.refresh(USER)).resolves.toMatchObject({result: 'applied'});
    expect(storage.uploads.size).toBe(1);
  });

  it('sin credencial o sin negocios no toca la VM', async () => {
    const {service, instances, events, setToken} = setup();
    setToken(null);
    await expect(service.refresh(USER)).resolves.toEqual({result: 'skipped', reason: 'no_credential'});
    expect(events.at(-1)).toMatchObject({kind: 'orqa.seed_failed', detail: 'reason=no_credential'});
    expect(instances.sets).toHaveLength(0);
  });

  it('onReady respeta el debounce por usuario', async () => {
    const {service, mcp} = setup();
    await service.onReady(USER);
    await expect(service.onReady(USER)).resolves.toBeNull();
    expect(mcp.calls.filter(call => call.name === 'saleads_get_account_overview')).toHaveLength(1);
  });
});

describe('negocio seleccionado en la web', () => {
  const con = (outcome: McpCallOutcome): McpToolClient => ({call: async () => outcome} as unknown as McpToolClient);
  const ID = '11111111-1111-4111-8111-111111111111';

  it('devuelve solo un id válido del overview del dueño', async () => {
    await expect(selectedBusinessId(con({ok: true, data: {selected_business_id: ID}}), 't', 10)).resolves.toBe(ID);
    await expect(selectedBusinessId(con({ok: true, data: {selected_business_id: 'x'}}), 't', 10)).resolves.toBeNull();
    await expect(selectedBusinessId(con({ok: true, data: {}}), 't', 10)).resolves.toBeNull();
    await expect(selectedBusinessId(con({ok: false, code: 'mcp_unavailable'} as McpCallOutcome), 't', 10)).resolves.toBeNull();
  });
});

describe('signed URL V4 de lectura de la semilla (OSB-007)', () => {
  const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
  const signer: BlobSigner = {email: 'sa-assistant-service@saleads-dev.iam.gserviceaccount.com', sign: async payload => sign('sha256', payload, privateKey)};

  it('GET con solo host firmado, vence en 1 h y la firma se verifica', async () => {
    const parts = await signedGetUrlV4({bucket: 'saleads-dev-assistant-memories', object: `seeds/${USER}/0123456789abcdef.json`, now: NOW, ttlSeconds: 3600, signer});
    expect(parts.canonicalRequest.split('\n')[0]).toBe('GET');
    expect(parts.canonicalRequest).toContain('\nhost:storage.googleapis.com\n\nhost\nUNSIGNED-PAYLOAD');
    const url = new URL(parts.url);
    expect(url.searchParams.get('X-Goog-SignedHeaders')).toBe('host');
    expect(url.searchParams.get('X-Goog-Expires')).toBe('3600');
    expect(verify('sha256', Buffer.from(parts.stringToSign), publicKey, Buffer.from(url.searchParams.get('X-Goog-Signature')!, 'hex'))).toBe(true);
  });
});

describe('cliente MCP del servicio (OSB-007)', () => {
  const sse = (frames: string) => new Response(frames, {status: 200, headers: {'content-type': 'text/event-stream'}});

  it('tools/call sin sesión en la era 2026-10-31, Bearer del dueño y resultado estructurado por SSE', async () => {
    const calls: Array<{url: string; init: RequestInit}> = [];
    const client = new HttpMcpToolClient('https://mcp.test/mcp', async (url, init = {}) => {
      calls.push({url: String(url), init});
      return sse(': keepalive\n\nevent: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{}"}],"structuredContent":{"business_id":"x"}}}\n\n');
    });
    await expect(client.call(TOKEN, 'saleads_get_business_bootstrap', {business_id: 'x'}, 1000)).resolves.toEqual({ok: true, data: {business_id: 'x'}});
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers['mcp-protocol-version']).toBe('2026-11-02');
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({method: 'tools/call', params: {name: 'saleads_get_business_bootstrap'}});
  });

  it('un error de tool devuelve solo su código; 401 y red caída tienen códigos propios', async () => {
    const replies = [
      sse('data: {"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[{"type":"text","text":"{\\"error\\":{\\"code\\":\\"MCP-E-BUSINESS-NOT-FOUND\\",\\"message\\":\\"secreto\\"}}"}]}}\n\n'),
      new Response('', {status: 401}),
    ];
    const client = new HttpMcpToolClient('https://mcp.test/mcp', async () => {
      const next = replies.shift();
      if (!next) throw new Error('down');
      return next;
    });
    await expect(client.call(TOKEN, 't', {}, 1000)).resolves.toEqual({ok: false, code: 'MCP-E-BUSINESS-NOT-FOUND'});
    await expect(client.call(TOKEN, 't', {}, 1000)).resolves.toEqual({ok: false, code: 'mcp_unauthorized'});
    await expect(client.call(TOKEN, 't', {}, 1000)).resolves.toEqual({ok: false, code: 'mcp_unreachable'});
  });
});
