import 'reflect-metadata';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {z} from 'zod';
import {gzipSync} from 'node:zlib';
import {BrainExplorerSnapshotV2, BrainSnapshotResponseV1, BrainSnapshotResponseV2} from '../src/contracts/v1';
import type {HermesChatApi, HermesTarget, SessionOutcome, StreamOpening} from '../src/hermes/hermes-client';
import {BrainFeedbackService, BrainFeedbackStore, FEEDBACK_SESSION_ID} from '../src/orqa/brain-feedback';
import {BrainSnapshotService, BrainSnapshotStore, uploadObjectName, type SnapshotStorage} from '../src/orqa/brain-snapshots';
import type {AssistantEvent, AssistantRow} from '../src/persistence/assistant-repository';
import {FieldCipher} from '../src/security/field-cipher';
import {FakeInstances, INSTANCE} from './support/hermes-fakes';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';
import {USER_ID} from './support/tokens';

const B1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_TEXT = 'Ese avatar no es: mis clientas tienen más de 45 años';

const node2 = (id: string, extra: Record<string, unknown> = {}) => ({
  id, type: 'Bet', family: 'bet', label: `Apuesta ${id}`, summary: 's', state: 'proposed', provenance: 'inferred', mentions: 0, created_at: null,
  type_label: 'Apuesta', stage: 'en_prueba', confidence: null, verification: 'PROPOSED', valid_from: null, learned_at: null,
  superseded_by: null, scope: null, evidence_count: null, outcome: null, ...extra,
});
const graph2 = (nodes: unknown[]) => ({
  business_id: B1, nodes, edges: [], stats: {nodes: nodes.length, edges: 0},
  sections: {my_business: [], active_bets: [], learned: [], did_not_work: [], your_corrections: [], to_confirm: [], history: []},
});
const snap2 = (...businesses: unknown[]) => ({schema: 'saleads-explorer-snapshot/2', generated_at: '2027-10-19T09:00:00+00:00', businesses});

class MemoryStorage implements SnapshotStorage {
  readonly objects = new Map<string, Buffer>();
  async signedPutUrl(object: string, now: Date, ttl: number): Promise<string> {
    const date = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    return `https://storage.googleapis.com/b/${object}?X-Goog-Date=${date}&X-Goog-Expires=${ttl}&X-Goog-Signature=SIG`;
  }
  async download(object: string): Promise<Buffer | null> {return this.objects.get(object) ?? null;}
  async upload(object: string, body: Buffer): Promise<void> {this.objects.set(object, body);}
}

class FakeChat implements HermesChatApi {
  sent: Array<{session: string; message: string}> = [];
  sessions: Array<{id: string; title?: string}> = [];
  async ensureSession(_t: HermesTarget, id: string, _ms: number, title?: string): Promise<SessionOutcome> {
    this.sessions.push({id, title});
    return {kind: 'ok'};
  }
  async messages(): Promise<never> {throw new Error('unused');}
  async openStream(_t: HermesTarget, session: string, message: string): Promise<StreamOpening> {
    this.sent.push({session, message});
    await new Promise(resolve => setTimeout(resolve, 5));
    return {kind: 'open', body: new Response('data: [DONE]\n\n').body!};
  }
}

describe('fotos v2, comparación y feedback del dueño (MLB-014)', () => {
  let db: TestDatabase;
  let storage: MemoryStorage;
  let instances: FakeInstances;
  let events: AssistantEvent[];
  let graphSha: string | null;
  let service: BrainSnapshotService;
  const cipher = new FieldCipher(Buffer.alloc(32, 7));
  const row = {user_id: USER_ID, status: 'ready', instance_name: INSTANCE, api_server_key_enc: cipher.seal('assistants.api_server_key_enc', USER_ID, 'k'.repeat(32))} as unknown as AssistantRow;

  beforeAll(async () => {db = await startTestDatabase();});
  afterAll(async () => {await db.close();});
  beforeEach(async () => {
    await db.database.pool.query('TRUNCATE assistant.brain_snapshots, assistant.brain_snapshot_uploads, assistant.brain_feedback_queue', []);
    storage = new MemoryStorage();
    instances = new FakeInstances();
    events = [];
    graphSha = null;
    const guest = instances.guestAttribute.bind(instances);
    instances.guestAttribute = async (name, key) => key === 'hermes/graph-snapshot' ? graphSha : guest(name, key);
    service = new BrainSnapshotService({uploadTtlSeconds: 7 * 86_400, rotateAfterMs: 6 * 86_400_000, debounceMs: 60_000}, {
      repository: {findActive: async () => row, appendEvent: async event => {events.push(event);}},
      instances, storage, store: new BrainSnapshotStore(db.database), ownedBusinesses: async () => new Set([B1]),
    });
  });

  const upload = (body: unknown | Buffer) => {
    const gz = Buffer.isBuffer(body) ? body : gzipSync(Buffer.from(JSON.stringify(body)));
    storage.objects.set(uploadObjectName(USER_ID), gz);
    graphSha = createHash('sha256').update(gz).digest('hex');
  };

  it('una v2 guardada se sirve en forma v1 al front estricto y en v2 con ?schema=2', async () => {
    upload(snap2(graph2([node2('n1'), node2('n2', {family: 'verdict', type: 'Verdict', outcome: 'pierde'})])));
    expect(await service.sync(USER_ID)).toBe('stored');
    const v1 = BrainSnapshotResponseV1.parse(await service.version(USER_ID, B1, 1));
    expect(v1.graph.nodes.map(n => n.family)).toEqual(['strategy', 'learning']);
    const v2 = BrainSnapshotResponseV2.parse(await service.versionV2(USER_ID, B1, 1));
    expect(v2.graph.nodes[1]).toMatchObject({family: 'verdict', outcome: 'pierde'});
  });

  it('una v2 marcada inválida antes del despliegue se reprocesa', async () => {
    upload(snap2(graph2([node2('n1')])));
    await db.database.pool.query(
      "INSERT INTO assistant.brain_snapshot_uploads (user_id, sha256, outcome, processed_at) VALUES ($1, $2, 'invalid', now())", [USER_ID, graphSha]);
    expect(await service.sync(USER_ID)).toBe('stored');
  });

  it('una versión corrupta responde 404, nunca 500', async () => {
    upload(snap2(graph2([node2('n1')])));
    await service.sync(USER_ID);
    storage.objects.set(`brain-snapshots/${USER_ID}/${B1}/1.json`, Buffer.from('{no es json'));
    await expect(service.version(USER_ID, B1, 1)).rejects.toMatchObject({code: 'NOT_FOUND', status: 404});
    await expect(service.versionV2(USER_ID, B1, 1)).rejects.toMatchObject({code: 'NOT_FOUND'});
  });

  it('la comparación entre versiones dice qué se agregó, se retiró y cambió', async () => {
    upload(snap2(graph2([node2('n1'), node2('n2')])));
    await service.sync(USER_ID);
    upload(snap2(graph2([node2('n1', {stage: 'perdedora'}), node2('n3')])));
    await service.sync(USER_ID);
    const diff = await service.diff(USER_ID, B1, 2, 1);
    expect(diff.counts).toEqual({added: 1, removed: 1, modified: 1});
    expect(diff.added[0]?.id).toBe('n3');
    expect(diff.removed[0]?.id).toBe('n2');
    expect(diff.modified[0]).toMatchObject({id: 'n1', before: {stage: 'en_prueba'}, after: {stage: 'perdedora'}});
  });

  describe('feedback', () => {
    let chat: FakeChat;
    let feedback: BrainFeedbackService;
    beforeEach(async () => {
      upload(snap2(graph2([node2('n1')])));
      await service.sync(USER_ID);
      chat = new FakeChat();
      feedback = new BrainFeedbackService({
        store: new BrainFeedbackStore(db.database), snapshots: service, instances, hermes: chat, cipher,
        repository: {findActive: async () => row, appendEvent: async event => {events.push(event);}},
        ownedBusinesses: async () => new Set([B1]), timeoutMs: 5_000,
      });
    });

    it('llega a Ale por la sesión aparte, una sola vez aunque haya dos onReady seguidos', async () => {
      const out = await feedback.enqueue(USER_ID, B1, {node_id: 'n1', action: 'correct', text: OWNER_TEXT}, 'feedback-key-0001');
      expect(out.status).toBe('delivered');
      await Promise.all([feedback.deliver(USER_ID), feedback.deliver(USER_ID)]);
      expect(chat.sent).toHaveLength(1);
      expect(chat.sent[0]!.session).toBe(FEEDBACK_SESSION_ID);
      expect(chat.sent[0]!.session).not.toBe('saleads-main');
      expect(chat.sessions[0]!.title).not.toBe('SaleADS');
      expect(chat.sent[0]!.message).toContain(OWNER_TEXT);
      expect(chat.sent[0]!.message).toContain('brain_record_feedback');
    });

    it('la misma Idempotency-Key no encola dos veces; un nodo o negocio ajeno es 404', async () => {
      const a = await feedback.enqueue(USER_ID, B1, {node_id: 'n1', action: 'confirm'}, 'feedback-key-0002');
      const b = await feedback.enqueue(USER_ID, B1, {node_id: 'n1', action: 'confirm'}, 'feedback-key-0002');
      expect(a.id).toBe(b.id);
      expect(chat.sent).toHaveLength(1);
      await expect(feedback.enqueue(USER_ID, B1, {node_id: 'no-existe', action: 'confirm'}, null)).rejects.toMatchObject({code: 'NOT_FOUND'});
      await expect(feedback.enqueue(USER_ID, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', {node_id: 'n1', action: 'confirm'}, null))
        .rejects.toMatchObject({code: 'NOT_FOUND'});
    });

    it('con la VM apagada queda pendiente y se entrega en el siguiente onReady', async () => {
      instances.setStatus('TERMINATED');
      expect((await feedback.enqueue(USER_ID, B1, {node_id: 'n1', action: 'no_longer_applies'}, null)).status).toBe('pending');
      instances.setStatus('RUNNING');
      expect(await feedback.deliver(USER_ID)).toBe(1);
      expect(await feedback.deliver(USER_ID)).toBe(0);
    });

    it('el texto del dueño no aparece en los eventos', async () => {
      await feedback.enqueue(USER_ID, B1, {node_id: 'n1', action: 'correct', text: OWNER_TEXT}, null);
      expect(events.map(e => e.kind)).toEqual(expect.arrayContaining(['orqa.brain_feedback_queued', 'orqa.brain_feedback_delivered']));
      expect(JSON.stringify(events)).not.toContain('45 años');
    });
  });
});

describe('paridad con el JSON Schema v2 del cerebro (MLB-014)', () => {
  type Schema = {required?: string[]; properties?: Record<string, Schema & {enum?: unknown[]; maxItems?: number; anyOf?: Array<{enum?: unknown[]}>}>; items?: Schema};
  const brain = JSON.parse(readFileSync('brain/contracts/saleads-explorer-snapshot-2.schema.json', 'utf8')) as Schema;
  const ours = z.toJSONSchema(BrainExplorerSnapshotV2) as Schema;
  const shape = (schema: Schema | undefined): unknown => schema && {
    required: [...(schema.required ?? [])].sort(),
    properties: Object.fromEntries(Object.entries(schema.properties ?? {}).sort().map(([key, value]) => [key, {
      enum: (value.enum ?? value.anyOf?.find(member => member.enum)?.enum)?.filter(v => v !== null).map(String).sort(), maxItems: value.maxItems,
      nested: shape(value.items ?? (value.properties ? value : undefined)),
    }])),
  };

  it('mismos campos obligatorios, familias y topes', () => {
    expect(shape(ours)).toEqual(shape(brain));
  });
});
