import 'reflect-metadata';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {BrainExplorerSnapshotV3, BrainSnapshotResponseV1, BrainSnapshotResponseV2} from '../src/contracts/v1';
import {BrainSnapshotService, BrainSnapshotStore, uploadObjectName, type SnapshotStorage} from '../src/orqa/brain-snapshots';
import type {AssistantEvent, AssistantRow} from '../src/persistence/assistant-repository';
import {FieldCipher} from '../src/security/field-cipher';
import {FakeInstances, INSTANCE} from './support/hermes-fakes';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';
import {USER_ID} from './support/tokens';

const B1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const node2 = (id: string, extra: Record<string, unknown> = {}) => ({
  id, type: 'Bet', family: 'bet', label: `Apuesta ${id}`, summary: 's', state: 'proposed', provenance: 'inferred', mentions: 0, created_at: null,
  type_label: 'Apuesta', stage: 'en_prueba', confidence: null, verification: 'PROPOSED', valid_from: null, learned_at: null,
  superseded_by: null, scope: null, evidence_count: null, outcome: null, ...extra,
});
const graph2 = (nodes: unknown[]) => ({
  business_id: B1, nodes, edges: [], stats: {nodes: nodes.length, edges: 0},
  sections: {my_business: [], active_bets: [], learned: [], did_not_work: [], your_corrections: [], to_confirm: [], history: []},
});

class MemoryStorage implements SnapshotStorage {
  readonly objects = new Map<string, Buffer>();
  async signedPutUrl(object: string, now: Date, ttl: number): Promise<string> {
    const date = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    return `https://storage.googleapis.com/b/${object}?X-Goog-Date=${date}&X-Goog-Expires=${ttl}&X-Goog-Signature=SIG`;
  }
  async download(object: string): Promise<Buffer | null> {return this.objects.get(object) ?? null;}
  async upload(object: string, body: Buffer): Promise<void> {this.objects.set(object, body);}
}


const fact = (path: string, value: string | string[], provenance = 'owner_said') => ({
  path, offering_ref: null, value, provenance, revision_id: `r-${path}`, version: 1, observed_at: '2026-10-30T07:07:51+00:00',
  recorded_at: '2026-10-29T11:53:05+00:00',
});
const snap3 = (...businesses: unknown[]) => ({schema: 'saleads-explorer-snapshot/3', generated_at: '2026-10-28T15:14:49+00:00', businesses});

describe('fotos v3 con hechos tipados (AAB-019)', () => {
  let db: TestDatabase;
  let storage: MemoryStorage;
  let instances: FakeInstances;
  let graphSha: string | null;
  let service: BrainSnapshotService;
  const cipher = new FieldCipher(Buffer.alloc(32, 7));
  const row = {user_id: USER_ID, status: 'ready', instance_name: INSTANCE, api_server_key_enc: cipher.seal('assistants.api_server_key_enc', USER_ID, 'k'.repeat(32))} as unknown as AssistantRow;
  const events: AssistantEvent[] = [];

  beforeAll(async () => {db = await startTestDatabase();});
  afterAll(async () => {await db.close();});
  beforeEach(async () => {
    await db.database.pool.query('TRUNCATE assistant.brain_snapshots, assistant.brain_snapshot_uploads', []);
    storage = new MemoryStorage();
    instances = new FakeInstances();
    graphSha = null;
    const guest = instances.guestAttribute.bind(instances);
    instances.guestAttribute = async (name, key) => key === 'hermes/graph-snapshot' ? graphSha : guest(name, key);
    service = new BrainSnapshotService({uploadTtlSeconds: 7 * 86_400, rotateAfterMs: 6 * 86_400_000, debounceMs: 60_000}, {
      repository: {findActive: async () => row, appendEvent: async event => {events.push(event);}},
      instances, storage, store: new BrainSnapshotStore(db.database), ownedBusinesses: async () => new Set([B1]),
    });
  });
  const upload = (body: unknown) => {
    const gz = gzipSync(Buffer.from(JSON.stringify(body)));
    storage.objects.set(uploadObjectName(USER_ID), gz);
    graphSha = createHash('sha256').update(gz).digest('hex');
  };

  it('una v3 se guarda con schema_version 3; el front sigue viendo v1 y v2 sin facts; factsOf devuelve los hechos', async () => {
    const snapshot = snap3({...graph2([node2('n1')]), facts: [fact('audiencia.ideal_client', 'Mamás de 30 a 45'), fact('voz.voice_tones', ['close', 'fun'], 'agent_inferred')]});
    expect(BrainExplorerSnapshotV3.safeParse(snapshot).success).toBe(true);
    upload(snapshot);
    expect(await service.sync(USER_ID)).toBe('stored');
    const {rows} = await db.database.pool.query('SELECT schema_version FROM assistant.brain_snapshots', []);
    expect(rows).toEqual([{schema_version: 3}]);
    const v1 = BrainSnapshotResponseV1.parse(await service.version(USER_ID, B1, 1));
    expect(v1.graph.nodes).toHaveLength(1);
    const v2 = BrainSnapshotResponseV2.parse(await service.versionV2(USER_ID, B1, 1));
    expect(v2.graph).not.toHaveProperty('facts');
    const facts = await service.factsOf(USER_ID, B1);
    expect(facts?.facts.map(f => [f.path, f.provenance])).toEqual([['audiencia.ideal_client', 'owner_said'], ['voz.voice_tones', 'agent_inferred']]);
  });

  it('una v3 con un hecho de procedencia desconocida es inválida y no se guarda', async () => {
    upload(snap3({...graph2([node2('n1')]), facts: [fact('audiencia.ideal_client', 'x', 'conversation')]}));
    expect(await service.sync(USER_ID)).toBe('invalid');
  });

  it('una versión v2 no tiene hechos (factsOf → [])', async () => {
    upload({schema: 'saleads-explorer-snapshot/2', generated_at: '2026-11-02T14:29:15+00:00', businesses: [graph2([node2('n1')])]});
    expect(await service.sync(USER_ID)).toBe('stored');
    expect(await service.factsOf(USER_ID, B1)).toEqual({version: 1, facts: []});
  });
});
