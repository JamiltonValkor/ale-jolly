import 'reflect-metadata';
import {Logger, type INestApplication, type LoggerService} from '@nestjs/common';
import {Test} from '@nestjs/testing';
import request from 'supertest';
import {AppModule} from '../src/app.module';
import {ComputeError, type OperationStatus} from '../src/compute/compute-client';
import {instanceNameFor} from '../src/compute/instance-name';
import type {MetadataItem} from '../src/compute/metadata';
import {AssistantStateV1, ErrorResponseV1} from '../src/contracts/v1';
import {configureApp} from '../src/http/configure-app';
import {OAuthTokenError} from '../src/oauth/token-client';
import type {OAuthRevocationApi} from '../src/oauth/revoke-client';
import {CredentialRenewal} from '../src/renewal/credential-renewal';
import {CredentialStore} from '../src/renewal/credential-store';
import {FakeTokens} from './support/fakes';
import type {InstanceInfo, LifecycleComputeApi} from '../src/lifecycle/lifecycle-compute';
import {LifecycleStore} from '../src/lifecycle/lifecycle-store';
import {archiveUrlHash, LifecycleService} from '../src/lifecycle/lifecycle.service';
import {ArchiveError, type MemoryArchiver} from '../src/lifecycle/memory-archive';
import {AssistantRepository} from '../src/persistence/assistant-repository';
import {FieldCipher} from '../src/security/field-cipher';
import {IdentityVerifier} from '../src/security/identity';
import {RowAssistantStateReader} from '../src/state/assistant-state';
import {TEMPLATE_ITEMS} from './support/fakes';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';
import {ISSUER, testKeys, USER_ID, type TestKeys} from './support/tokens';

const BUCKET = 'saleads-dev-assistant-memories';
const NAME = instanceNameFor(USER_ID);
const REFRESH = 'refresh-SECRET-7d1c';
const URL_SECRET = 'SIGNED-SECRET-91af'; // gitleaks:allow -- synthetic test credential
const T0 = Date.parse('2026-10-29T04:42:13.000Z');

class CaptureLogger implements LoggerService {
  readonly lines: string[] = [];
  log(...args: unknown[]) {this.lines.push(args.map(String).join(' '));}
  warn(...args: unknown[]) {this.lines.push(args.map(String).join(' '));}
  error(...args: unknown[]) {this.lines.push(args.map(String).join(' '));}
  debug(...args: unknown[]) {this.lines.push(args.map(String).join(' '));}
  verbose(...args: unknown[]) {this.lines.push(args.map(String).join(' '));}
}

/** Bucket simulado + firma: la URL lleva un "secreto" para comprobar que nunca sale a logs ni eventos. */
class FakeArchiver implements MemoryArchiver {
  readonly objects = new Set<string>();
  readonly signed: Array<{bucket: string; object: string; ttlSeconds: number}> = [];
  signError: Error | null = null;

  async signedUploadUrl(input: {bucket: string; object: string; now: Date; ttlSeconds: number}): Promise<string> {
    if (this.signError) throw this.signError;
    this.signed.push({bucket: input.bucket, object: input.object, ttlSeconds: input.ttlSeconds});
    const path = input.object.split('/').map(encodeURIComponent).join('/');
    return `https://storage.googleapis.com/${input.bucket}/${path}?X-Goog-Signature=${URL_SECRET}-${this.signed.length}`;
  }

  async objectExists(bucket: string, object: string): Promise<boolean> {
    return this.objects.has(`${bucket}/${object}`);
  }

  /** Lo que hace el PUT del watcher. */
  upload(url: string): void {
    const parsed = new URL(url);
    this.objects.add(decodeURIComponent(parsed.pathname.slice(1)));
  }
}

/**
 * Compute simulado con una sola VM y un watcher: cuando la VM está RUNNING y
 * aparece una hermes-archive-url nueva, "sube" el archivo y publica
 * hermes/archive-status (vm/README.md paso 5).
 */
class FakeCompute implements LifecycleComputeApi {
  instance: InstanceInfo | null = {status: 'RUNNING', fingerprint: 'fp-1', items: [...TEMPLATE_ITEMS, {key: 'hermes-api-key', value: 'k'}], privateIp: '10.10.0.5'};
  readonly guest = new Map<string, string>();
  readonly calls: string[] = [];
  readonly metadataWrites: Array<{fingerprint: string; items: MetadataItem[]}> = [];
  stopError: ComputeError | null = null;
  startError: ComputeError | null = null;
  deleteError: ComputeError | null = null;
  stopResult: OperationStatus = {done: true, errorReason: null};
  startResult: OperationStatus = {done: true, errorReason: null};
  /** Respuesta del watcher: 'upload' sube; 'fail:<http>' publica failed. */
  watcher: 'upload' | `fail:${number}` = 'upload';
  conflictOnce = false;
  /** Cuántas lecturas sigue existiendo la VM tras instances.delete. */
  deleteLag = 1;
  infoError: ComputeError | null = null;
  private lastArchived: string | null = null;
  private deletedAt: number | null = null;
  private readonly ops = new Map<string, OperationStatus>();

  constructor(private readonly archiver: FakeArchiver) {}

  async instanceInfo(name: string): Promise<InstanceInfo | null> {
    this.calls.push(`get ${name}`);
    if (this.infoError) throw this.infoError;
    if (this.deletedAt !== null) {
      if (this.deletedAt-- > 0) return this.instance && {...this.instance, status: 'STOPPING'};
      this.instance = null;
    }
    return this.instance && {...this.instance, items: this.instance.items.map(item => ({...item}))};
  }

  async replaceMetadata(name: string, fingerprint: string, items: MetadataItem[]): Promise<string> {
    this.calls.push(`setMetadata ${name}`);
    if (!this.instance) throw new ComputeError(404, 'notFound');
    if (this.conflictOnce || fingerprint !== this.instance.fingerprint) {
      this.conflictOnce = false;
      this.instance.fingerprint = 'fp-2';
      throw new ComputeError(412, 'conditionNotMet');
    }
    this.metadataWrites.push({fingerprint, items});
    this.instance.items = items;
    this.instance.fingerprint = `${fingerprint}+`;
    this.runWatcher();
    return this.op({done: true, errorReason: null});
  }

  async stopInstance(name: string): Promise<string> {
    this.calls.push(`stop ${name}`);
    if (this.stopError) throw this.stopError;
    if (!this.stopResult.errorReason && this.instance) this.instance.status = 'TERMINATED';
    return this.op(this.stopResult);
  }

  async startInstance(name: string): Promise<string> {
    this.calls.push(`start ${name}`);
    if (this.startError) throw this.startError;
    if (!this.startResult.errorReason && this.instance) {
      this.instance.status = 'RUNNING';
      this.instance.privateIp = '10.10.0.9';
      this.runWatcher();
    }
    return this.op(this.startResult);
  }

  async deleteInstance(name: string): Promise<string | null> {
    this.calls.push(`delete ${name}`);
    if (this.deleteError) throw this.deleteError;
    if (!this.instance) return null;
    this.deletedAt = this.deleteLag;
    return this.op({done: true, errorReason: null});
  }

  async guestAttribute(name: string, namespace: string, key: string): Promise<string | null> {
    return this.guest.get(`${namespace}/${key}`) ?? null;
  }

  async operationStatus(operation: string): Promise<OperationStatus> {
    return this.ops.get(operation) ?? {done: true, errorReason: 'NOT_FOUND'};
  }

  archiveUrl(): string | undefined {
    return this.instance?.items.find(item => item.key === 'hermes-archive-url')?.value;
  }

  private runWatcher(): void {
    const url = this.archiveUrl();
    if (!url || url === this.lastArchived || this.instance?.status !== 'RUNNING') return;
    if (this.watcher === 'upload') {
      this.archiver.upload(url);
      this.lastArchived = url;
      this.guest.set('hermes/archive-status', `uploaded:${archiveUrlHash(url)}`);
    } else {
      this.guest.set('hermes/archive-status', `failed:${this.watcher.slice(5)}`);
    }
  }

  private op(status: OperationStatus): string {
    const name = `operation-${this.ops.size + 1}`;
    this.ops.set(name, status);
    return name;
  }
}

/** Revocación simulada detrás del CredentialRenewal REAL de OCB-009. */
class FakeRevoker implements OAuthRevocationApi {
  readonly revoked: string[] = [];
  error: Error | null = null;
  async revoke(token: string): Promise<void> {
    if (this.error) throw this.error;
    this.revoked.push(token);
  }
}

describe('desactivar, reactivar y borrar (OCB-012)', () => {
  let db: TestDatabase;
  let keys: TestKeys;
  let web: string;
  let app: INestApplication;
  let lifecycle: LifecycleService;
  let compute: FakeCompute;
  let archiver: FakeArchiver;
  let revoker: FakeRevoker;
  let logger: CaptureLogger;
  let nowMs: number;
  let startHook: jest.Mock;
  let configHook: jest.Mock;
  const cipher = new FieldCipher(Buffer.alloc(32, 7));

  beforeAll(async () => {
    [db, keys] = await Promise.all([startTestDatabase(), testKeys()]);
    web = await keys.sign({sub: USER_ID, exp: Math.floor(Date.now() / 1000) + 3600});
  });
  afterAll(async () => {await db.close();});

  beforeEach(async () => {
    await db.database.pool.query('TRUNCATE assistant.assistants, assistant.assistant_credentials, assistant.oauth_flows, assistant.assistant_events', []);
    nowMs = T0;
    const now = () => new Date(nowMs);
    const repository = new AssistantRepository(db.database);
    archiver = new FakeArchiver();
    compute = new FakeCompute(archiver);
    revoker = new FakeRevoker();
    startHook = jest.fn().mockResolvedValue({result: 'renewed'});
    configHook = jest.fn().mockResolvedValue(undefined);
    const renewal = new CredentialRenewal({
      repository, store: new CredentialStore(db.database), cipher, tokens: new FakeTokens(), revocation: revoker,
      metadata: {read: async () => {throw new Error('unused');}, write: async () => 'ok'},
      issuer: ISSUER, zone: 'us-central1-a', retryDebounceMs: 60_000, now,
    });
    lifecycle = new LifecycleService({
      bucket: BUCKET, archiveUrlTtlSeconds: 900, archiveTimeoutMs: 600_000, deleteTimeoutMs: 300_000,
      operationTimeoutMs: 120_000, pollIntervalMs: 5_000,
    }, {
      repository, cipher, archiver, compute, now,
      store: new LifecycleStore(db.database),
      credentials: {revokeStoredCredential: userId => renewal.revokeStoredCredential(userId), renewBeforeStart: startHook},
      config: {syncBeforeStart: configHook},
      renewBeforeStartBudgetMs: 300,
      sleep: async ms => {nowMs += ms;},
    });
    logger = new CaptureLogger();
    const moduleRef = await Test.createTestingModule({imports: [AppModule.register({
      database: db.database,
      identity: new IdentityVerifier({issuer: ISSUER, audience: '', clients: ['front']}, keys.jwks),
      flag: {isEnabled: jest.fn().mockResolvedValue(true)},
      cipher,
      stateReader: new RowAssistantStateReader(repository, now),
      lifecycle,
    })]}).compile();
    app = configureApp(moduleRef.createNestApplication({bodyParser: false, logger}));
    Logger.overrideLogger(logger);
    await app.init();
  });
  afterEach(async () => {
    await lifecycle.idle();
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const auth = (req: request.Test) => req.set('Authorization', `Bearer ${web}`);
  const stop = () => auth(http().post('/assistants/me/stop'));
  const start = () => auth(http().post('/assistants/me/start'));
  const remove = () => auth(http().delete('/assistants/me'));
  const me = () => auth(http().get('/assistants/me'));
  const rows = async (sql: string, params: unknown[] = []) => (await db.database.pool.query(sql, params)).rows as Array<Record<string, unknown>>;
  const row = async () => (await rows('SELECT * FROM assistant.assistants'))[0]!;
  const events = async () => rows('SELECT kind, phase, cause_code, detail_safe FROM assistant.assistant_events ORDER BY id');
  const kinds = async () => (await events()).map(event => event.kind);

  async function seed(fields: Record<string, unknown> = {}, credential = true) {
    const values = {
      status: 'ready', step: null, instance_name: NAME, zone: 'us-central1-a', private_ip: '10.10.0.5',
      api_server_key_enc: cipher.seal('assistants.api_server_key_enc', USER_ID, 'api-key'), ai_configured: true,
      ai_provider: 'openrouter', ai_model: 'openai/gpt-4o-mini', session_id: 'sess-1',
      ready_since: new Date(T0 - 3_600_000), activation_started_at: new Date(T0 - 7_200_000), ...fields,
    };
    const columns = Object.keys(values);
    await rows(`INSERT INTO assistant.assistants (user_id, ${columns.join(', ')}) VALUES ($1, ${columns.map((_, i) => `$${i + 2}`).join(', ')})`,
      [USER_ID, ...Object.values(values)]);
    if (credential) {
      await rows('INSERT INTO assistant.assistant_credentials (user_id, refresh_token_enc) VALUES ($1, $2)',
        [USER_ID, cipher.seal('assistant_credentials.refresh_token_enc', USER_ID, REFRESH)]);
    }
  }

  function expectNoSecrets(texts: string[]) {
    for (const text of texts) {
      expect(text).not.toContain(URL_SECRET);
      expect(text).not.toContain(REFRESH);
      expect(text).not.toContain('X-Goog-Signature');
    }
  }

  describe('POST /assistants/me/stop', () => {
    it('ready → instances.stop → 200 stopped; la VM queda TERMINATED y la IA/sesión se conservan', async () => {
      await seed();
      const response = await stop().expect(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(AssistantStateV1.parse(response.body)).toEqual({
        status: 'stopped', step: null, slow: false, session_id: 'sess-1',
        ai: {configured: true, provider: 'openrouter', model: 'openai/gpt-4o-mini'}, ready_since: new Date(T0 - 3_600_000).toISOString(), timezone: null,
      });
      await lifecycle.idle();
      expect(compute.calls).toEqual([`stop ${NAME}`]);
      expect(compute.instance?.status).toBe('TERMINATED');
      expect(await row()).toMatchObject({status: 'stopped', step: null, private_ip: null, deleted_at: null});
      expect(await kinds()).toEqual(['vm.stop_requested', 'vm.stopped']);
      await me().expect(200).expect(res => expect(res.body.status).toBe('stopped'));
    });

    it('activating en configure_ai también se puede desactivar', async () => {
      await seed({status: 'activating', step: 'configure_ai', ai_configured: false});
      await stop().expect(200).expect(res => expect(res.body.status).toBe('stopped'));
    });

    it('sin VM instalada o ya apagado: 200 con el estado actual y sin llamar a GCP', async () => {
      await seed({status: 'activating', step: 'preparing_access', instance_name: null});
      await stop().expect(200).expect(res => expect(res.body).toMatchObject({status: 'activating', step: 'preparing_access'}));
      await rows("UPDATE assistant.assistants SET status = 'stopped', step = NULL, instance_name = $1", [NAME]);
      await stop().expect(200).expect(res => expect(res.body.status).toBe('stopped'));
      expect(compute.calls).toEqual([]);
    });

    it('sin asistente: 404 NOT_FOUND con el contrato de error', async () => {
      const response = await stop().expect(404);
      expect(ErrorResponseV1.parse(response.body).code).toBe('NOT_FOUND');
      await start().expect(404);
    });

    it('GCP rechaza el stop: 503, el estado no cambia y queda vm_stop_failed', async () => {
      await seed();
      compute.stopError = new ComputeError(403, 'forbidden');
      await stop().expect(503);
      expect(await row()).toMatchObject({status: 'ready'});
      expect(await events()).toEqual([{kind: 'vm.stop_failed', phase: 'stop', cause_code: 'vm_stop_failed', detail_safe: 'status=403 reason=forbidden'}]);
    });

    it('la operación de stop falla: vuelve al estado previo', async () => {
      await seed({status: 'activating', step: 'configure_ai'});
      compute.stopResult = {done: true, errorReason: 'RESOURCE_NOT_READY'};
      await stop().expect(200);
      await lifecycle.idle();
      expect(await row()).toMatchObject({status: 'activating', step: 'configure_ai'});
      expect((await events()).at(-1)).toMatchObject({kind: 'vm.stop_failed', cause_code: 'vm_stop_failed', detail_safe: 'reason=RESOURCE_NOT_READY'});
    });

    it('no requiere nada más que el token web: sin token 401', async () => {
      await http().post('/assistants/me/stop').expect(401);
    });
  });

  describe('POST /assistants/me/start', () => {
    it('stopped → instances.start → 200 activating/preparing_environment; relee la IP y conserva IA y memoria', async () => {
      await seed({status: 'stopped', private_ip: null});
      compute.instance!.status = 'TERMINATED';
      const response = await start().expect(200);
      expect(AssistantStateV1.parse(response.body)).toMatchObject({
        status: 'activating', step: 'preparing_environment', slow: false, session_id: 'sess-1',
        ai: {configured: true, provider: 'openrouter', model: 'openai/gpt-4o-mini'},
      });
      await lifecycle.idle();
      expect(startHook).toHaveBeenCalledWith(USER_ID);
      // La config pendiente (p. ej. una zona cambiada con la VM apagada, OCB-016) se aplica antes del start.
      expect(configHook).toHaveBeenCalledWith(USER_ID);
      expect(compute.calls).toEqual([`start ${NAME}`, `get ${NAME}`]);
      expect(await row()).toMatchObject({status: 'activating', step: 'preparing_environment', private_ip: '10.10.0.9',
        activation_started_at: new Date(T0), ai_configured: true, session_id: 'sess-1'});
      // Nada se borró ni se re-sembró: sin setMetadata y la credencial intacta.
      expect(compute.metadataWrites).toEqual([]);
      expect(await rows('SELECT user_id FROM assistant.assistant_credentials')).toHaveLength(1);
      expect(await kinds()).toEqual(['vm.start_requested', 'vm.started']);
    });

    it('si la renovación previa (OCB-009) falla, enciende igual', async () => {
      await seed({status: 'stopped'});
      startHook.mockRejectedValueOnce(new Error('kc down'));
      await start().expect(200).expect(res => expect(res.body.status).toBe('activating'));
      expect(compute.calls[0]).toBe(`start ${NAME}`);
    });

    it('si la sincronización de config tarda más que el presupuesto, enciende igual (OCB-016)', async () => {
      await seed({status: 'stopped'});
      configHook.mockImplementationOnce(() => new Promise(() => undefined));
      await start().expect(200).expect(res => expect(res.body.status).toBe('activating'));
      expect(configHook).toHaveBeenCalledWith(USER_ID);
      expect(compute.calls[0]).toBe(`start ${NAME}`);
    });

    it('fuera de stopped responde el estado actual sin llamar a GCP', async () => {
      await seed();
      await start().expect(200).expect(res => expect(res.body.status).toBe('ready'));
      expect(compute.calls).toEqual([]);
    });

    it('GCP rechaza el start: 503 y sigue stopped', async () => {
      await seed({status: 'stopped'});
      compute.startError = new ComputeError(503, 'unavailable');
      await start().expect(503);
      expect(await row()).toMatchObject({status: 'stopped'});
      expect((await events()).at(-1)).toMatchObject({kind: 'vm.start_failed', cause_code: 'vm_start_failed'});
    });

    it('la operación de start falla: vuelve a stopped para poder reintentar', async () => {
      await seed({status: 'stopped'});
      compute.startResult = {done: true, errorReason: 'ZONE_RESOURCE_POOL_EXHAUSTED'};
      await start().expect(200);
      await lifecycle.idle();
      expect(await row()).toMatchObject({status: 'stopped', step: null});
      expect((await events()).at(-1)).toMatchObject({kind: 'vm.start_failed', detail_safe: 'reason=ZONE_RESOURCE_POOL_EXHAUSTED'});
    });
  });

  describe('DELETE /assistants/me', () => {
    it('archiva, borra la VM, revoca, borra la credencial y marca deleted_at (GET /me → none)', async () => {
      await seed();
      await rows("INSERT INTO assistant.oauth_flows (state_hash, user_id, verifier_enc, expires_at) VALUES ($1, $2, '\\x00', now())", ['a'.repeat(64), USER_ID]);
      const response = await remove().expect(200);
      expect(AssistantStateV1.parse(response.body)).toMatchObject({status: 'deleting', step: null});
      await me().expect(200).expect(res => expect(res.body.status).toBe('deleting'));
      await lifecycle.idle();

      // 1. signed URL al bucket con <user_id>/<timestamp>.tgz, 15 min.
      const object = `${USER_ID}/20261015T120000Z.tgz`;
      expect(archiver.signed).toEqual([{bucket: BUCKET, object, ttlSeconds: 900}]);
      // 2. setMetadata con fingerprint y TODA la metadata + hermes-archive-url.
      expect(compute.metadataWrites).toHaveLength(1);
      const write = compute.metadataWrites[0]!;
      expect(write.fingerprint).toBe('fp-1');
      for (const item of TEMPLATE_ITEMS) expect(write.items).toContainEqual(item);
      expect(write.items).toContainEqual({key: 'hermes-api-key', value: 'k'});
      expect(write.items.find(item => item.key === 'hermes-archive-url')?.value).toContain(encodeURIComponent(USER_ID));
      // 3. el archivo existe; 4. la VM ya no existe (se esperó el 404).
      expect(archiver.objects.has(`${BUCKET}/${object}`)).toBe(true);
      expect(compute.instance).toBeNull();
      const order = compute.calls.filter(call => !call.startsWith('get'));
      expect(order).toEqual([`setMetadata ${NAME}`, `delete ${NAME}`]);
      // 5. revoke RFC 7009 con el refresh guardado; 6. credencial y flujos borrados; 7. deleted_at.
      expect(revoker.revoked).toEqual([REFRESH]);
      expect(await rows('SELECT * FROM assistant.assistant_credentials')).toHaveLength(0);
      expect(await rows('SELECT * FROM assistant.oauth_flows')).toHaveLength(0);
      const final = await row();
      expect(final.deleted_at).toEqual(new Date(nowMs));
      expect(final.api_server_key_enc).toBeNull();
      await me().expect(200).expect(res => expect(res.body).toEqual({
        status: 'none', step: null, slow: false, session_id: null, ai: {configured: false, provider: null, model: null}, ready_since: null, timezone: null,
      }));
      expect(await events()).toEqual([
        {kind: 'delete.requested', phase: 'delete', cause_code: null, detail_safe: 'from=ready'},
        {kind: 'archive.requested', phase: 'archive', cause_code: null, detail_safe: 'object=20261015T120000Z.tgz'},
        {kind: 'archive.uploaded', phase: 'archive', cause_code: null, detail_safe: 'object=20261015T120000Z.tgz'},
        {kind: 'vm.deleted', phase: 'delete_vm', cause_code: null, detail_safe: null},
        {kind: 'credential.revoked', phase: 'revoke', cause_code: null, detail_safe: null},
        {kind: 'assistant.deleted', phase: 'delete', cause_code: null, detail_safe: 'object=20261015T120000Z.tgz'},
      ]);
      expectNoSecrets([...logger.lines, ...(await events()).map(event => JSON.stringify(event))]);
    });

    it('una VM desactivada se enciende para archivar y luego se borra', async () => {
      await seed({status: 'stopped'});
      compute.instance!.status = 'TERMINATED';
      await remove().expect(200);
      await lifecycle.idle();
      expect(compute.calls.filter(call => !call.startsWith('get'))).toEqual([`setMetadata ${NAME}`, `start ${NAME}`, `delete ${NAME}`]);
      expect(archiver.objects.size).toBe(1);
      expect(await kinds()).toContain('archive.vm_started');
      expect((await row()).deleted_at).not.toBeNull();
    });

    it('sin archivo antes del timeout: archive_failed, status=failed, la VM y la credencial se conservan', async () => {
      await seed();
      compute.watcher = 'fail:403';
      await remove().expect(200);
      await lifecycle.idle();
      expect(nowMs - T0).toBeGreaterThanOrEqual(600_000);
      expect(compute.instance).not.toBeNull();
      expect(compute.calls).not.toContain(`delete ${NAME}`);
      expect(revoker.revoked).toEqual([]);
      expect(await rows('SELECT * FROM assistant.assistant_credentials')).toHaveLength(1);
      expect(await row()).toMatchObject({status: 'failed', deleted_at: null});
      expect((await events()).at(-1)).toEqual({kind: 'archive_failed', phase: 'archive', cause_code: 'archive_failed',
        detail_safe: 'reason=timeout last_status=failed:403'});
      await me().expect(200).expect(res => expect(res.body.status).toBe('failed'));
      expectNoSecrets(logger.lines);

      // No bloquea para siempre: otro DELETE reintenta con una URL nueva y termina.
      compute.watcher = 'upload';
      await remove().expect(200).expect(res => expect(res.body.status).toBe('deleting'));
      await lifecycle.idle();
      expect(archiver.signed).toHaveLength(2);
      expect(archiver.signed[1]!.object).not.toBe(archiver.signed[0]!.object);
      expect(compute.instance).toBeNull();
      expect((await row()).deleted_at).not.toBeNull();
      expect(await kinds()).toContain('assistant.deleted');
    });

    it('si no se puede firmar la URL: archive_failed y la VM se conserva', async () => {
      await seed();
      archiver.signError = new ArchiveError('sign_http_403');
      await remove().expect(200);
      await lifecycle.idle();
      expect(compute.instance).not.toBeNull();
      expect((await events()).at(-1)).toMatchObject({kind: 'archive_failed', detail_safe: 'phase=request reason=sign_http_403'});
    });

    it('un 412 del fingerprint se reintenta una vez releyendo la metadata', async () => {
      await seed();
      compute.conflictOnce = true;
      await remove().expect(200);
      await lifecycle.idle();
      expect(compute.metadataWrites).toHaveLength(1);
      expect(compute.metadataWrites[0]!.fingerprint).toBe('fp-2');
      expect((await row()).deleted_at).not.toBeNull();
    });

    it('un fallo del revoke se registra y no bloquea el borrado', async () => {
      await seed();
      revoker.error = new OAuthTokenError('unavailable', 'http_503');
      await remove().expect(200);
      await lifecycle.idle();
      expect((await row()).deleted_at).not.toBeNull();
      expect(await events()).toContainEqual({kind: 'credential.revoke_failed', phase: 'revoke', cause_code: 'revoke_failed', detail_safe: 'reason=unavailable:http_503'});
      expect(await rows('SELECT * FROM assistant.assistant_credentials')).toHaveLength(0);
    });

    it('instances.delete falla: vm_delete_failed y status=failed (el archivo ya está)', async () => {
      await seed();
      compute.deleteError = new ComputeError(403, 'forbidden');
      await remove().expect(200);
      await lifecycle.idle();
      expect(archiver.objects.size).toBe(1);
      expect(await row()).toMatchObject({status: 'failed', deleted_at: null});
      expect((await events()).at(-1)).toMatchObject({kind: 'vm.delete_failed', cause_code: 'vm_delete_failed'});
      expect(revoker.revoked).toEqual([]);
    });

    it('sin VM (nunca se creó o ya no existe): sin archivo, revoca y borra', async () => {
      await seed({status: 'failed'});
      compute.instance = null;
      await remove().expect(200);
      await lifecycle.idle();
      expect(archiver.signed).toEqual([]);
      expect(revoker.revoked).toEqual([REFRESH]);
      expect((await row()).deleted_at).not.toBeNull();
      expect(await events()).toContainEqual({kind: 'archive.skipped', phase: 'archive', cause_code: null, detail_safe: 'reason=no_instance'});
    });

    it('sin asistente: 200 status=none (idempotente)', async () => {
      await remove().expect(200).expect(res => expect(res.body.status).toBe('none'));
      expect(compute.calls).toEqual([]);
    });

    it('dos DELETE seguidos lanzan un solo borrado', async () => {
      await seed();
      await Promise.all([remove().expect(200), remove().expect(200)]);
      await lifecycle.idle();
      expect(archiver.signed).toHaveLength(1);
      expect((await kinds()).filter(kind => kind === 'delete.requested')).toHaveLength(1);
    });

    it('después de borrar, una activación nueva arranca un asistente nuevo en la misma fila', async () => {
      await seed();
      await remove().expect(200);
      await lifecycle.idle();
      const repository = new AssistantRepository(db.database);
      const {row: fresh, started} = await repository.startActivation(USER_ID, new Date(nowMs + 1000));
      expect(started).toBe(true);
      expect(fresh).toMatchObject({status: 'activating', step: 'preparing_access', instance_name: null, deleted_at: null, ai_configured: false});
    });

    it('un borrado cortado por un reinicio se reanuda al arrancar', async () => {
      await seed({status: 'deleting'});
      expect(await lifecycle.resumePendingDeletions()).toBe(1);
      await lifecycle.idle();
      expect((await row()).deleted_at).not.toBeNull();
    });
  });
});
