import 'reflect-metadata';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {z} from 'zod';
import {BrainSnapshotService, BrainSnapshotStore, uploadObjectName, type SnapshotStorage} from '../src/orqa/brain-snapshots';
import {BrainSnapshotPoller} from '../src/orqa/brain-snapshot-poller';
import {KnowledgeSyncService, KnowledgeSyncStore, redactPii} from '../src/orqa/knowledge-sync';
import type {AssistantEvent, AssistantRow} from '../src/persistence/assistant-repository';
import {FieldCipher} from '../src/security/field-cipher';
import {FakeInstances, INSTANCE} from './support/hermes-fakes';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';
import {USER_ID} from './support/tokens';

/**
 * Copia del zod `knowledge-sync.v1` de BI (sa-business-intelligence-service
 * src/nest/domain/knowledge/knowledge-sync.schema.ts, AAB-020/AAB-021): estricto, claves extra → 400.
 */
const iso = z.string().min(1).max(40);
const KnowledgeSyncV1 = z.object({
  source: z.literal('brain'),
  snapshot_version: z.number().int().min(0),
  generated_at: iso,
  facts: z.array(z.object({
    path: z.string().min(1).max(120), offering_ref: z.string().uuid().nullable(), value: z.unknown(),
    provenance: z.enum(['owner_said', 'owner_decided', 'agent_inferred', 'platform']), revision_id: z.string().min(1).max(128),
    version: z.number().int().min(0), observed_at: iso, recorded_at: iso,
  }).strict()).max(200),
  items: z.array(z.object({
    node_id: z.string().min(1).max(64), type: z.string().min(1).max(64), label: z.string().max(200), summary: z.string().max(500),
    provenance: z.string().min(1).max(40), stage: z.string().max(40).nullable().optional(), outcome: z.string().max(20).nullable().optional(),
    confidence: z.string().max(20).nullable().optional(), valid_from: z.string().max(300).nullable().optional(),
    superseded_by: z.string().max(64).nullable().optional(), winner: z.boolean().nullable().optional(),
    bet_node_id: z.string().max(64).nullable().optional(), anchor_node_id: z.string().max(64).nullable().optional(),
    brain_bet_ref: z.string().min(1).max(120).nullable().optional(), offering_ref: z.string().uuid().nullable().optional(),
    revision: z.union([z.string().min(1).max(128), z.number().int().min(0)]),
  }).strict()).max(500),
}).strict();

const B1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FOREIGN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const node = (id: string, type: string, extra: Record<string, unknown> = {}) => ({
  id, type, family: type === 'Bet' ? 'bet' : type === 'Verdict' ? 'verdict' : type === 'Learning' ? 'learned' : 'market',
  label: `${type} ${id}`, summary: 's', state: 'proposed', provenance: 'inferred', mentions: 0, created_at: null,
  type_label: type, stage: null, confidence: null, verification: 'PROPOSED', valid_from: null, learned_at: null,
  superseded_by: null, scope: null, evidence_count: null, outcome: null, ...extra,
});
const edge = (source: string, target: string, type: string) => ({source, target, type, fact: 'f', provenance: 'inferred', valid_at: null, invalid_at: null});
const graph = (businessId: string, nodes: unknown[], edges: unknown[] = [], facts: unknown[] = []) => ({
  business_id: businessId, nodes, edges, stats: {nodes: nodes.length, edges: edges.length},
  sections: {my_business: [], active_bets: [], learned: [], did_not_work: [], your_corrections: [], to_confirm: [], history: []},
  facts,
});
const fact = (path: string, value: string, revision: string, provenance = 'owner_said') => ({
  path, offering_ref: null, value, provenance, revision_id: revision, version: 1, observed_at: '2027-08-16T10:00:00+00:00',
  recorded_at: '2027-08-16T10:00:01+00:00',
});
const snap = (...businesses: unknown[]) => ({schema: 'saleads-explorer-snapshot/3', generated_at: '2027-08-16T09:00:00+00:00', businesses});

class MemoryStorage implements SnapshotStorage {
  readonly objects = new Map<string, Buffer>();
  async signedPutUrl(object: string, now: Date, ttl: number): Promise<string> {
    const date = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    return `https://storage.googleapis.com/b/${object}?X-Goog-Date=${date}&X-Goog-Expires=${ttl}&X-Goog-Signature=SIG`;
  }
  async download(object: string): Promise<Buffer | null> {return this.objects.get(object) ?? null;}
  async upload(object: string, body: Buffer): Promise<void> {this.objects.set(object, body);}
}

interface Call {url: string; headers: Record<string, string>; body: z.infer<typeof KnowledgeSyncV1>}

describe('knowledge-sync del cerebro a BI (AAB-013)', () => {
  let db: TestDatabase;
  let storage: MemoryStorage;
  let instances: FakeInstances;
  let graphSha: string | null;
  let snapshots: BrainSnapshotService;
  let sync: KnowledgeSyncService;
  let calls: Call[];
  let status: number;
  let events: AssistantEvent[];
  const cipher = new FieldCipher(Buffer.alloc(32, 7));
  const row = {user_id: USER_ID, status: 'ready', instance_name: INSTANCE, api_server_key_enc: cipher.seal('assistants.api_server_key_enc', USER_ID, 'k'.repeat(32))} as unknown as AssistantRow;

  beforeAll(async () => {db = await startTestDatabase();});
  afterAll(async () => {await db.close();});

  const build = (options: {enabled?: boolean} = {}) => {
    sync = new KnowledgeSyncService({enabled: options.enabled ?? true, biUrl: 'http://bi:4011/', internalToken: 't'.repeat(40)}, {
      source: {latestVersions: userId => snapshots.latestVersions(userId), syncSource: (u, b, v) => snapshots.syncSource(u, b, v)},
      cursors: new KnowledgeSyncStore(db.database),
      fetcher: async (input, init) => {
        const headers = Object.fromEntries(Object.entries(init?.headers as Record<string, string>));
        calls.push({url: String(input), headers, body: KnowledgeSyncV1.parse(JSON.parse(String(init?.body)))});
        return new Response(JSON.stringify({success: true, data: {summary: {applied: 2}}}), {status});
      },
      repository: {appendEvent: async event => {events.push(event);}},
    });
  };

  beforeEach(async () => {
    await db.database.pool.query('TRUNCATE assistant.brain_snapshots, assistant.brain_snapshot_uploads, assistant.brain_knowledge_sync', []);
    storage = new MemoryStorage();
    instances = new FakeInstances();
    graphSha = null;
    calls = [];
    events = [];
    status = 200;
    const guest = instances.guestAttribute.bind(instances);
    instances.guestAttribute = async (name, key) => key === 'hermes/graph-snapshot' ? graphSha : guest(name, key);
    snapshots = new BrainSnapshotService({uploadTtlSeconds: 7 * 86_400, rotateAfterMs: 6 * 86_400_000, debounceMs: 60_000}, {
      repository: {findActive: async () => row, appendEvent: async () => undefined},
      instances, storage, store: new BrainSnapshotStore(db.database), ownedBusinesses: async () => new Set([B1, B2]),
    });
    build();
  });

  const upload = (body: unknown) => {
    const gz = gzipSync(Buffer.from(JSON.stringify(body)));
    storage.objects.set(uploadObjectName(USER_ID), gz);
    graphSha = createHash('sha256').update(gz).digest('hex');
  };
  const ingestAndPush = async (body: unknown) => {
    upload(body);
    await snapshots.sync(USER_ID);
    await sync.syncUser(USER_ID);
  };

  const loopGraph = (extraNodes: unknown[] = []) => graph(B1, [
    node('seed1', 'Producto', {provenance: 'saleads_seed'}),
    node('bet1', 'Bet', {outcome: 'gana', stage: 'ganadora'}),
    node('av1', 'Avatar'),
    node('v1', 'Verdict', {outcome: 'gana'}),
    node('l1', 'Learning', {summary: 'Escribir a ana@correo.com o al 300 123 4567'}),
    ...extraNodes,
  ], [edge('bet1', 'av1', 'TARGETS'), edge('v1', 'bet1', 'ABOUT'), edge('v1', 'l1', 'TEACHES')],
  [fact('audiencia.ideal_client', 'Mamás de 30 a 45', 'r1')]);

  it('D10/MAN-012: un único knowledge-sync por versión con nodos nuevos, hechos nuevos, ligas del loop y sin semilla', async () => {
    await ingestAndPush(snap(loopGraph()));
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe(`http://bi:4011/api/business-intelligence/internal/businesses/${B1}/knowledge-sync`);
    expect(call!.headers['x-user-id']).toBe(USER_ID);
    expect(call!.headers['idempotency-key']).toBe(`brain:${USER_ID}:${B1}:1`);
    expect(call!.headers['x-internal-token']).toHaveLength(40);
    expect(call!.body.snapshot_version).toBe(1);
    expect(call!.body.items.map(i => i.node_id).sort()).toEqual(['av1', 'bet1', 'l1', 'v1']);
    const byId = Object.fromEntries(call!.body.items.map(i => [i.node_id, i]));
    expect(byId.v1).toMatchObject({bet_node_id: 'bet1', anchor_node_id: null});
    expect(byId.l1).toMatchObject({bet_node_id: 'bet1', anchor_node_id: 'v1'});
    expect(byId.av1?.winner).toBe(true);
    expect(byId.l1?.summary).not.toMatch(/ana@correo|300 123 4567/);
    expect(call!.body.facts.map(f => f.revision_id)).toEqual(['r1']);
    const {rows} = await db.database.pool.query('SELECT last_synced_version, status FROM assistant.brain_knowledge_sync', []);
    expect(rows).toEqual([{last_synced_version: 1, status: 'ok'}]);
    expect(events.map(e => e.kind)).toEqual(['orqa.knowledge_synced']);
    expect(events[0]!.detail).toContain('redacted=2');
    expect(events[0]!.detail).not.toContain('ana@');
  });

  it('idempotente: la misma versión otra vez no llama; la versión siguiente manda solo lo cambiado y nunca lo quitado', async () => {
    await ingestAndPush(snap(loopGraph()));
    await sync.syncUser(USER_ID);
    expect(calls).toHaveLength(1);
    const next = loopGraph([node('n9', 'Observation')]);
    next.nodes = next.nodes.filter(n => (n as {id: string}).id !== 'av1');
    (next.nodes.find(n => (n as {id: string}).id === 'bet1') as {label: string}).label = 'Apuesta renombrada';
    next.facts = [...next.facts, fact('voz.voice_tones', 'close', 'r2', 'agent_inferred')];
    await ingestAndPush(snap(next));
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.snapshot_version).toBe(2);
    expect(calls[1]!.body.items.map(i => i.node_id).sort()).toEqual(['bet1', 'n9']);
    expect(calls[1]!.body.facts.map(f => f.revision_id)).toEqual(['r2']);
  });

  it('un 5xx deja failed y el próximo intento reenvía la misma Idempotency-Key y el mismo cuerpo', async () => {
    status = 503;
    await ingestAndPush(snap(loopGraph()));
    const {rows} = await db.database.pool.query('SELECT last_synced_version, status, attempts, last_error_code FROM assistant.brain_knowledge_sync', []);
    expect(rows).toEqual([{last_synced_version: 0, status: 'failed', attempts: 1, last_error_code: 'http_503'}]);
    status = 200;
    await sync.syncUser(USER_ID);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers['idempotency-key']).toBe(calls[0]!.headers['idempotency-key']);
    expect({...calls[1]!.body, generated_at: ''}).toEqual({...calls[0]!.body, generated_at: ''});
    const after = await db.database.pool.query('SELECT last_synced_version, status FROM assistant.brain_knowledge_sync', []);
    expect(after.rows).toEqual([{last_synced_version: 1, status: 'ok'}]);
  });

  it('ADR0020: dos negocios propios y uno ajeno → dos llamadas, una por negocio, ninguna para el ajeno', async () => {
    await ingestAndPush(snap(loopGraph(), graph(B2, [node('x1', 'Bet')]), graph(FOREIGN, [node('z1', 'Bet')])));
    expect(calls.map(c => c.url.split('/businesses/')[1]!.split('/')[0]).sort()).toEqual([B1, B2]);
    for (const call of calls) {
      const businessId = call.url.split('/businesses/')[1]!.split('/')[0];
      expect(call.body.items.every(i => businessId === B1 ? i.node_id !== 'x1' : i.node_id === 'x1')).toBe(true);
    }
  });

  it('no bloquea: con BI caído la ingesta guarda la versión y responde stored', async () => {
    build();
    sync = new KnowledgeSyncService({enabled: true, biUrl: 'http://bi:4011', internalToken: 't'.repeat(40)}, {
      source: snapshots, cursors: new KnowledgeSyncStore(db.database),
      fetcher: async () => {throw new TypeError('fetch failed');}, repository: {appendEvent: async () => undefined},
    });
    const withHook = new BrainSnapshotService({uploadTtlSeconds: 7 * 86_400, rotateAfterMs: 6 * 86_400_000, debounceMs: 60_000}, {
      repository: {findActive: async () => row, appendEvent: async () => undefined},
      instances, storage, store: new BrainSnapshotStore(db.database), ownedBusinesses: async () => new Set([B1]),
      onStored: (userId, ids) => sync.onStored(userId, ids),
    });
    upload(snap(loopGraph()));
    expect(await withHook.sync(USER_ID)).toBe('stored');
    await sync.syncUser(USER_ID);
    const {rows} = await db.database.pool.query('SELECT status, last_error_code FROM assistant.brain_knowledge_sync', []);
    expect(rows).toEqual([{status: 'failed', last_error_code: 'network'}]);
  });

  it('flag: KNOWLEDGE_SYNC_ENABLED=false no llama a BI', async () => {
    build({enabled: false});
    await ingestAndPush(snap(loopGraph()));
    expect(calls).toHaveLength(0);
  });

  it('una versión sin nodos ni hechos nuevos avanza el cursor sin llamar', async () => {
    await ingestAndPush(snap(loopGraph()));
    const same = loopGraph();
    same.edges = [...same.edges, edge('av1', 'bet1', 'RELATES_TO')];
    await ingestAndPush(snap(same));
    expect(calls).toHaveLength(1);
    const {rows} = await db.database.pool.query('SELECT last_synced_version FROM assistant.brain_knowledge_sync', []);
    expect(rows).toEqual([{last_synced_version: 2}]);
  });

  it('privacidad: correos, teléfonos y direcciones se tapan; precios y uuids se conservan', () => {
    expect(redactPii('Escribe a ana@x.co o al +57 300 123 4567, Calle 10 # 5 - 20').count).toBe(3);
    expect(redactPii('Kit a $45.000 COP, id aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').count).toBe(0);
  });
});

describe('sondeo de la foto (AAB-013, D27)', () => {
  it('por cada usuario listo ingiere la foto y reintenta el empuje; un fallo no corta el lote', async () => {
    const seen: string[] = [];
    const poller = new BrainSnapshotPoller({
      users: {readyUsers: async () => ['u1', 'u2']},
      sync: async userId => {seen.push(`sync:${userId}`); if (userId === 'u1') throw new Error('x');},
      pushPending: async userId => {seen.push(`push:${userId}`);},
    }, {intervalMs: 60_000, batchSize: 500});
    await poller.tick();
    expect(seen).toEqual(['sync:u1', 'push:u1', 'sync:u2', 'push:u2']);
    poller.start();
    await poller.stop();
  });
});
