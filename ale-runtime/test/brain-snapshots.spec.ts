import 'reflect-metadata';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
import type {INestApplication} from '@nestjs/common';
import {Test} from '@nestjs/testing';
import request from 'supertest';
import {AppModule} from '../src/app.module';
import {z} from 'zod';
import {BrainExplorerSnapshotV1, BrainSnapshotResponseV1, BrainSnapshotsResponseV1, ErrorResponseV1} from '../src/contracts/v1';
import {configureApp} from '../src/http/configure-app';
import {BrainSnapshotService, BrainSnapshotStore, uploadObjectName, type SnapshotStorage} from '../src/orqa/brain-snapshots';
import type {AssistantEvent, AssistantRow} from '../src/persistence/assistant-repository';
import {FieldCipher} from '../src/security/field-cipher';
import {IdentityVerifier} from '../src/security/identity';
import {FakeInstances, INSTANCE} from './support/hermes-fakes';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';
import {ISSUER, testKeys, USER_ID, type TestKeys} from './support/tokens';

const OTHER_USER = 'other-user-2';
const B1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FOREIGN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DAY = 86_400_000;

const graph = (businessId: string, label = 'Example Beauty') => ({
  business_id: businessId,
  nodes: [{id: 'n1', type: 'Business', family: 'identity', label, summary: 'salón', state: 'validated', provenance: 'saleads_seed', mentions: 2, created_at: null}],
  edges: [{source: 'n1', target: 'n1', type: 'SELLS', fact: 'vende', provenance: 'saleads_seed', valid_at: null, invalid_at: null}],
  stats: {nodes: 1, edges: 1},
});
const snapshot = (...businesses: unknown[]) => ({schema: 'saleads-explorer-snapshot/1', generated_at: '2027-08-11T09:00:00+00:00', businesses});

class MemoryStorage implements SnapshotStorage {
  readonly objects = new Map<string, Buffer>();
  readonly signed: Array<{object: string; ttlSeconds: number}> = [];
  async signedPutUrl(object: string, now: Date, ttlSeconds: number): Promise<string> {
    this.signed.push({object, ttlSeconds});
    const date = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    return `https://storage.googleapis.com/bucket/${object}?X-Goog-Date=${date}&X-Goog-Expires=${ttlSeconds}&X-Goog-Signature=SIG-SECRET`;
  }
  async download(object: string): Promise<Buffer | null> {return this.objects.get(object) ?? null;}
  async upload(object: string, body: Buffer): Promise<void> {this.objects.set(object, body);}
}

describe('fotos del cerebro (OSB-010)', () => {
  let db: TestDatabase;
  let keys: TestKeys;
  let nowMs: number;
  let events: AssistantEvent[];
  let instances: FakeInstances;
  let storage: MemoryStorage;
  let owned: Map<string, Set<string> | null>;
  let graphSha: string | null;
  let service: BrainSnapshotService;

  beforeAll(async () => {[db, keys] = await Promise.all([startTestDatabase(), testKeys()]);});
  afterAll(async () => {await db.close();});

  beforeEach(async () => {
    await db.database.pool.query('TRUNCATE assistant.brain_snapshots, assistant.brain_snapshot_uploads', []);
    nowMs = Date.parse('2027-08-11T12:00:00.000Z');
    events = [];
    instances = new FakeInstances();
    storage = new MemoryStorage();
    owned = new Map([[USER_ID, new Set([B1, B2])], [OTHER_USER, new Set([FOREIGN])]]);
    graphSha = null;
    const guest = instances.guestAttribute.bind(instances);
    instances.guestAttribute = async (name, key) => key === 'hermes/graph-snapshot' ? graphSha : guest(name, key);
    service = new BrainSnapshotService({uploadTtlSeconds: 7 * 86_400, rotateAfterMs: 6 * DAY, debounceMs: 60_000}, {
      repository: {
        findActive: async userId => ({user_id: userId, status: 'ready', instance_name: INSTANCE}) as unknown as AssistantRow,
        appendEvent: async event => {events.push(event);},
      },
      instances, storage, store: new BrainSnapshotStore(db.database),
      ownedBusinesses: async userId => owned.get(userId) ?? null,
      now: () => new Date(nowMs),
    });
  });

  /** La VM sube la foto: el objeto del usuario y el guest attribute con su sha256. */
  const vmUploads = (userId: string, body: unknown, raw?: Buffer) => {
    const gz = raw ?? gzipSync(Buffer.from(JSON.stringify(body)));
    storage.objects.set(uploadObjectName(userId), gz);
    graphSha = createHash('sha256').update(gz).digest('hex');
  };

  it('firma la URL de subida (PUT 7 días) y la rota a los 6 días', async () => {
    await service.sync(USER_ID);
    expect(storage.signed).toEqual([{object: uploadObjectName(USER_ID), ttlSeconds: 604_800}]);
    expect(instances.item('hermes-snapshot-url')).toContain(`/brain-uploads/${USER_ID}/snapshot.json.gz?`);
    nowMs += 5 * DAY;
    await service.sync(USER_ID);
    expect(storage.signed).toHaveLength(1);
    nowMs += 2 * DAY;
    await service.sync(USER_ID);
    expect(storage.signed).toHaveLength(2);
  });

  it('una foto con dos negocios se guarda partida; un negocio ajeno se descarta; sin cambios no hay versión nueva', async () => {
    vmUploads(USER_ID, snapshot(graph(B1), graph(B2), graph(FOREIGN)));
    await expect(service.sync(USER_ID)).resolves.toBe('stored');
    expect((await service.timeline(USER_ID, B1, 10)).items.map(item => item.version)).toEqual([1]);
    expect((await service.timeline(USER_ID, B2, 10)).items).toHaveLength(1);
    await expect(service.timeline(USER_ID, FOREIGN, 10)).rejects.toMatchObject({code: 'NOT_FOUND'});
    expect(events.at(-1)).toMatchObject({kind: 'orqa.snapshot_ingested', detail: 'outcome=stored versions=2 foreign=1'});

    await expect(service.sync(USER_ID)).resolves.toBe('unchanged');
    vmUploads(USER_ID, {...snapshot(graph(B1), graph(B2, 'Example Beauty Spa')), generated_at: '2027-08-11T15:00:00+00:00'});
    await service.sync(USER_ID);
    expect((await service.timeline(USER_ID, B1, 10)).items).toHaveLength(1);
    expect((await service.timeline(USER_ID, B2, 10)).items.map(item => item.version)).toEqual([2, 1]);
    expect((await service.version(USER_ID, B2, 2)).graph.nodes[0]!.label).toBe('Example Beauty Spa');
  });

  it('una foto inválida contra el esquema se descarta y deja un evento', async () => {
    vmUploads(USER_ID, snapshot({...graph(B1), embeddings: [0.1]}));
    await expect(service.sync(USER_ID)).resolves.toBe('invalid');
    expect(events.at(-1)).toMatchObject({kind: 'orqa.snapshot_invalid', detail: 'reason=schema'});
    vmUploads(USER_ID, null, Buffer.from('no es gzip'));
    await expect(service.sync(USER_ID)).resolves.toBe('invalid');
    await expect(service.timeline(USER_ID, B1, 10)).rejects.toMatchObject({code: 'NOT_FOUND'});
  });

  it('sin saber los negocios del dueño no guarda nada', async () => {
    owned.set(USER_ID, null);
    vmUploads(USER_ID, snapshot(graph(B1)));
    await expect(service.sync(USER_ID)).resolves.toBe('skipped');
    expect(events.at(-1)).toMatchObject({kind: 'orqa.snapshot_failed', detail: 'reason=ownership_unknown'});
  });

  it('con la VM apagada la API sigue devolviendo la última foto; ningún evento lleva la URL firmada', async () => {
    vmUploads(USER_ID, snapshot(graph(B1)));
    await service.sync(USER_ID);
    instances.setStatus('TERMINATED');
    expect((await service.version(USER_ID, B1, 1)).graph.business_id).toBe(B1);
    expect(JSON.stringify(events)).not.toContain('SIG-SECRET');
  });

  describe('HTTP', () => {
    let app: INestApplication;
    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({imports: [AppModule.register({
        database: db.database,
        identity: new IdentityVerifier({issuer: ISSUER, audience: '', clients: ['front']}, keys.jwks),
        flag: {isEnabled: async () => true},
        cipher: new FieldCipher(Buffer.alloc(32, 7)),
        brainSnapshots: service,
      })]}).compile();
      app = configureApp(moduleRef.createNestApplication({bodyParser: false, logger: false}));
      await app.init();
    });
    afterEach(async () => {await app.close();});

    it('línea de tiempo y versión del negocio del dueño; un negocio ajeno o inválido responde 404 NOT_FOUND', async () => {
      vmUploads(USER_ID, snapshot(graph(B1)));
      await service.sync(USER_ID);
      vmUploads(OTHER_USER, snapshot(graph(FOREIGN)));
      await service.sync(OTHER_USER);
      const auth = `Bearer ${await keys.sign()}`;
      const timeline = await request(app.getHttpServer()).get(`/assistants/me/businesses/${B1}/brain/snapshots?limit=5`).set('Authorization', auth).expect(200);
      expect(BrainSnapshotsResponseV1.parse(timeline.body).items).toHaveLength(1);
      const version = await request(app.getHttpServer()).get(`/assistants/me/businesses/${B1}/brain/snapshots/1`).set('Authorization', auth).expect(200);
      expect(BrainSnapshotResponseV1.parse(version.body).graph.nodes).toHaveLength(1);
      for (const path of [`${FOREIGN}/brain/snapshots`, `${FOREIGN}/brain/snapshots/1`, 'not-a-uuid/brain/snapshots', `${B1}/brain/snapshots/0`]) {
        const response = await request(app.getHttpServer()).get(`/assistants/me/businesses/${path}`).set('Authorization', auth).expect(404);
        expect(ErrorResponseV1.parse(response.body).code).toBe('NOT_FOUND');
      }
    });
  });
});

describe('paridad con el JSON Schema del cerebro (OSB-004/010)', () => {
  type Schema = {required?: string[]; properties?: Record<string, Schema & {enum?: string[]; maxItems?: number; maxLength?: number}>; items?: Schema};
  const brain = JSON.parse(readFileSync('brain/contracts/saleads-explorer-snapshot-1.schema.json', 'utf8')) as Schema;
  const ours = z.toJSONSchema(BrainExplorerSnapshotV1) as Schema;
  const shape = (schema: Schema | undefined): unknown => schema && {
    required: [...(schema.required ?? [])].sort(),
    properties: Object.fromEntries(Object.entries(schema.properties ?? {}).sort().map(([key, value]) => [key, {
      enum: value.enum ? [...value.enum].sort() : undefined, maxItems: value.maxItems, maxLength: value.maxLength,
      nested: shape(value.items ?? (value.properties ? value : undefined)),
    }])),
  };

  it('mismos campos obligatorios, enums y topes en todos los niveles', () => {
    expect(shape(ours)).toEqual(shape(brain));
  });
});
