import 'reflect-metadata';
import {Logger, type LoggerService} from '@nestjs/common';
import {ActivationService} from '../src/activation/activation.service';
import {loadAgentBundle} from '../src/activation/hermes-files';
import {Provisioner} from '../src/activation/provisioner';
import {ComputeError} from '../src/compute/compute-client';
import {instanceNameFor} from '../src/compute/instance-name';
import type {MetadataItem} from '../src/compute/metadata';
import {configuration} from '../src/config';
import type {AssistantStateV1} from '../src/contracts/v1';
import {OAuthFlowSecrets} from '../src/oauth/authorize';
import {KeycloakRevocationClient, type OAuthRevocationApi} from '../src/oauth/revoke-client';
import {OAuthTokenError, type AssistantTokenSet} from '../src/oauth/token-client';
import {outboundFetch} from '../src/outbound/http-client';
import {AssistantRepository} from '../src/persistence/assistant-repository';
import {CredentialRenewal} from '../src/renewal/credential-renewal';
import {CredentialStore} from '../src/renewal/credential-store';
import {RestInstanceMetadata, type InstanceMetadata, type InstanceMetadataApi} from '../src/renewal/instance-metadata';
import {RenewalScheduler} from '../src/renewal/renewal-scheduler';
import {RenewalAwareStateReader} from '../src/renewal/renewal-state-reader';
import {FieldCipher} from '../src/security/field-cipher';
import {IdentityVerifier} from '../src/security/identity';
import {RowAssistantStateReader} from '../src/state/assistant-state';
import {FakeCompute, FakeTokens, TEMPLATE_ITEMS} from './support/fakes';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';
import {ISSUER, testKeys, USER_ID, type TestKeys} from './support/tokens';

const CLIENT_ID = 'mcp-saleads-assistant-dev';
const MCP_URL = 'https://dev.saleads.ai/mcp';
const SCOPE = 'openid offline_access saleads-mcp saleads:read saleads:strategy saleads:campaigns saleads:launch saleads:events';
const OTHER_USER = '0a0b0c0d-2222-4333-8444-955566667777';
const THIRD_USER = '7a7b7c7d-3333-4444-8555-a66677778888';
const MASTER_KEY = Buffer.alloc(32, 9);
const DAY = 86_400_000;
const STORED_REFRESH = 'eyJstored-refresh-SECRET';

class CaptureLogger implements LoggerService {
  readonly lines: string[] = [];
  log(...args: unknown[]) {this.lines.push(args.map(String).join(' '));}
  warn(...args: unknown[]) {this.lines.push(args.map(String).join(' '));}
  error(...args: unknown[]) {this.lines.push(args.map(String).join(' '));}
  debug(...args: unknown[]) {this.lines.push(args.map(String).join(' '));}
  verbose(...args: unknown[]) {this.lines.push(args.map(String).join(' '));}
}

/** Compute simulado para la metadata de instancias (encendidas o apagadas). */
class FakeMetadata implements InstanceMetadataApi {
  readonly store = new Map<string, InstanceMetadata>();
  readonly writes: Array<{instance: string; zone: string; items: MetadataItem[]}> = [];
  /** Guion de respuestas de write: 'conflict' simula 412; un Error se lanza. */
  script: Array<'conflict' | Error> = [];
  private version = 0;

  seed(instance: string, items: MetadataItem[]) {
    this.store.set(instance, {fingerprint: `fp-${this.version++}`, items: items.map(item => ({...item}))});
  }

  async read(instance: string): Promise<InstanceMetadata> {
    const current = this.store.get(instance);
    if (!current) throw new ComputeError(404, 'notFound');
    return {fingerprint: current.fingerprint, items: current.items.map(item => ({...item}))};
  }

  async write(instance: string, zone: string, metadata: InstanceMetadata): Promise<'ok' | 'conflict'> {
    const step = this.script.shift();
    if (step instanceof Error) throw step;
    if (step === 'conflict') {this.seed(instance, this.store.get(instance)!.items); return 'conflict';}
    if (this.store.get(instance)?.fingerprint !== metadata.fingerprint) return 'conflict';
    this.writes.push({instance, zone, items: metadata.items});
    this.seed(instance, metadata.items);
    return 'ok';
  }

  value(instance: string, key: string): string | undefined {
    return this.store.get(instance)?.items.find(item => item.key === key)?.value;
  }
}

class FakeRevocation implements OAuthRevocationApi {
  readonly calls: Array<{token: string; hint?: string}> = [];
  error: OAuthTokenError | null = null;
  async revoke(token: string, hint?: 'refresh_token' | 'access_token'): Promise<void> {
    this.calls.push({token, hint});
    if (this.error) throw this.error;
  }
}

describe('renovación de la credencial del asistente (OCB-009)', () => {
  let db: TestDatabase;
  let keys: TestKeys;
  let repository: AssistantRepository;
  let store: CredentialStore;
  let tokens: FakeTokens;
  let metadata: FakeMetadata;
  let revocation: FakeRevocation;
  let renewal: CredentialRenewal;
  let logger: CaptureLogger;
  let nowMs: number;
  const now = () => new Date(nowMs);
  const cipher = new FieldCipher(MASTER_KEY);
  const instance = instanceNameFor(USER_ID);
  const baseItems: MetadataItem[] = [
    ...TEMPLATE_ITEMS,
    {key: 'hermes-api-key', value: 'api-key-SECRET'},
    {key: 'hermes-env', value: 'OPENROUTER_API_KEY=sk-or-SECRET'},
    {key: 'hermes-mcp-tokens', value: '{"tokens.json":{"access_token":"eyJold"}}'},
  ];

  beforeAll(async () => {
    [db, keys] = await Promise.all([startTestDatabase(), testKeys()]);
  });
  afterAll(async () => {await db.close();});

  beforeEach(async () => {
    await db.database.pool.query('TRUNCATE assistant.assistants, assistant.assistant_credentials, assistant.oauth_flows, assistant.assistant_events', []);
    nowMs = Date.parse('2026-11-01T09:19:35.000Z');
    repository = new AssistantRepository(db.database);
    store = new CredentialStore(db.database);
    tokens = new FakeTokens();
    metadata = new FakeMetadata();
    revocation = new FakeRevocation();
    renewal = new CredentialRenewal({
      repository, store, cipher, tokens, revocation, metadata, issuer: ISSUER, zone: 'us-central1-a', retryDebounceMs: 60_000, now,
    });
    logger = new CaptureLogger();
    Logger.overrideLogger(logger);
  });
  afterEach(async () => {await renewal.idle();});

  const rows = async (sql: string, params: unknown[] = []) => (await db.database.pool.query(sql, params)).rows as Array<Record<string, unknown>>;
  const events = async (userId = USER_ID) =>
    rows('SELECT kind, phase, cause_code, detail_safe FROM assistant.assistant_events WHERE user_id = $1 ORDER BY id', [userId]);
  const storedRefresh = async (userId = USER_ID) => {
    const [row] = await rows('SELECT refresh_token_enc FROM assistant.assistant_credentials WHERE user_id = $1', [userId]);
    return row ? cipher.open('assistant_credentials.refresh_token_enc', userId, row.refresh_token_enc as Buffer) : null;
  };
  const tokenSet = async (refresh = `eyJnew-refresh-SECRET-${Math.random().toString(36).slice(2)}`): Promise<AssistantTokenSet> => ({
    accessToken: await keys.sign({azp: CLIENT_ID, aud: [MCP_URL, 'account'], sub: USER_ID}),
    refreshToken: refresh, tokenType: 'Bearer', scope: SCOPE, expiresIn: 300,
  });

  /** Asistente con VM y credencial guardada hace `ageMs`. */
  async function seedAssistant(input: {userId?: string; status?: string; ageMs?: number; deleted?: boolean; withInstance?: boolean} = {}) {
    const userId = input.userId ?? USER_ID;
    const name = input.withInstance === false ? null : instanceNameFor(userId);
    const obtained = new Date(nowMs - (input.ageMs ?? 8 * DAY));
    await rows(`INSERT INTO assistant.assistants (user_id, status, step, instance_name, zone, activation_started_at, deleted_at)
      VALUES ($1, $2, NULL, $3, 'us-central1-a', $4, $5)`,
    [userId, input.status ?? 'ready', name, obtained, input.deleted ? now() : null]);
    await store.upsertCredential(userId, cipher.seal('assistant_credentials.refresh_token_enc', userId, STORED_REFRESH), obtained, obtained);
    await repository.appendEvent({userId, kind: 'oauth.completed', phase: 'callback'});
    if (name) metadata.seed(name, baseItems);
    return name;
  }

  const noSecretsAnywhere = async (secrets: string[]) => {
    const all = JSON.stringify(await rows('SELECT kind, phase, cause_code, detail_safe FROM assistant.assistant_events'));
    expect(all).not.toContain('eyJ');
    for (const line of logger.lines) expect(line).not.toContain('eyJ');
    for (const secret of secrets) {
      expect(all).not.toContain(secret);
      for (const line of logger.lines) expect(line).not.toContain(secret);
    }
  };

  describe('access token del servicio para la semilla (OSB-007)', () => {
    it('refresca por el flujo único, persiste el refresh rotado, no resiembra y reutiliza el token hasta que vence', async () => {
      await seedAssistant();
      const fresh = await tokenSet();
      tokens.refreshed = fresh;
      const writesBefore = metadata.writes.length;

      await expect(renewal.accessToken(USER_ID)).resolves.toBe(fresh.accessToken);
      await expect(renewal.accessToken(USER_ID)).resolves.toBe(fresh.accessToken);

      expect(tokens.refreshes).toEqual([STORED_REFRESH]);
      expect(await storedRefresh()).toBe(fresh.refreshToken);
      expect(metadata.writes.length).toBe(writesBefore);
      nowMs += 290_000;
      tokens.refreshed = await tokenSet();
      await renewal.accessToken(USER_ID);
      expect(tokens.refreshes).toHaveLength(2);
      await noSecretsAnywhere([fresh.refreshToken, STORED_REFRESH]);
    });

    it('un refresh rechazado devuelve null y deja el salto SSO pendiente, sin tokens en eventos', async () => {
      await seedAssistant();
      tokens.refreshed = new OAuthTokenError('rejected', 'invalid_grant');
      await expect(renewal.accessToken(USER_ID)).resolves.toBeNull();
      expect(await renewal.needsSso(USER_ID)).toBe(true);
      await expect(renewal.accessToken(USER_ID)).resolves.toBeNull();
      expect(tokens.refreshes).toHaveLength(1);
      await noSecretsAnywhere([STORED_REFRESH]);
    });
  });

  describe('renovar y resembrar', () => {
    it('refresca con el refresh guardado, lo reemplaza cifrado y resiembra solo hermes-mcp-tokens', async () => {
      await seedAssistant();
      const fresh = await tokenSet();
      tokens.refreshed = fresh;

      await expect(renewal.renew(USER_ID, 'sweep')).resolves.toEqual({result: 'renewed'});

      expect(tokens.refreshes).toEqual([STORED_REFRESH]);
      expect(await storedRefresh()).toBe(fresh.refreshToken);
      const [credential] = await rows('SELECT obtained_at, access_expires_at FROM assistant.assistant_credentials');
      expect((credential!.obtained_at as Date).getTime()).toBe(nowMs);
      expect((credential!.access_expires_at as Date).getTime()).toBe(nowMs + 300_000);

      const written = JSON.parse(metadata.value(instance, 'hermes-mcp-tokens')!);
      expect(written).toEqual({'tokens.json': {
        access_token: fresh.accessToken, token_type: 'Bearer', refresh_token: fresh.refreshToken, scope: SCOPE,
        expires_at: Math.floor(nowMs / 1000) + 300, hermes_issuer: ISSUER,
      }});
      // El resto de la metadata (plantilla, key de IA, API_SERVER_KEY) queda intacto.
      const keysAfter = metadata.store.get(instance)!.items.filter(item => item.key !== 'hermes-mcp-tokens');
      expect(keysAfter).toEqual(baseItems.filter(item => item.key !== 'hermes-mcp-tokens'));
      expect(metadata.writes).toHaveLength(1);
      expect((await events()).map(event => event.kind)).toEqual(['oauth.completed', 'credential.renewed']);
      expect((await events()).at(-1)).toMatchObject({detail_safe: 'trigger=sweep', cause_code: null});
      await noSecretsAnywhere([STORED_REFRESH, fresh.refreshToken]);
    });

    it('funciona con la VM apagada (stopped): la resiembra queda lista para el próximo arranque', async () => {
      await seedAssistant({status: 'stopped'});
      tokens.refreshed = await tokenSet();
      await expect(renewal.renewBeforeStart(USER_ID)).resolves.toEqual({result: 'renewed'});
      expect((await events()).at(-1)).toMatchObject({kind: 'credential.renewed', detail_safe: 'trigger=before_start'});
    });

    it('un 412 del fingerprint relee y reintenta una vez; dos seguidos dejan metadata_write_failed', async () => {
      await seedAssistant();
      tokens.refreshed = await tokenSet();
      metadata.script = ['conflict'];
      await expect(renewal.renew(USER_ID, 'sweep')).resolves.toEqual({result: 'renewed'});
      expect(metadata.writes).toHaveLength(1);

      metadata.script = ['conflict', 'conflict'];
      tokens.refreshed = await tokenSet();
      await expect(renewal.renew(USER_ID, 'sweep')).resolves.toEqual({result: 'retry_later', cause: 'metadata_write_failed'});
      expect((await events()).at(-1)).toEqual({
        kind: 'credential_renewal_failed', phase: 'renewal', cause_code: 'config_apply_failed',
        detail_safe: 'cause=metadata_write_failed trigger=sweep status=412 reason=conditionNotMet',
      });
    });

    it('invalid_grant: registra refresh_invalid_grant y sso_silent_required, y queda esperando el SSO', async () => {
      await seedAssistant();
      tokens.refreshed = new OAuthTokenError('rejected', 'invalid_grant');
      await expect(renewal.renew(USER_ID, 'mcp_failure')).resolves.toEqual({result: 'sso_required'});
      expect((await events()).slice(-2)).toEqual([
        {kind: 'credential_renewal_failed', phase: 'renewal', cause_code: 'refresh_failed',
          detail_safe: 'cause=refresh_invalid_grant trigger=mcp_failure reason=invalid_grant'},
        {kind: 'credential_renewal_failed', phase: 'renewal', cause_code: 'login_required',
          detail_safe: 'cause=sso_silent_required trigger=mcp_failure'},
      ]);
      expect(await renewal.needsSso(USER_ID)).toBe(true);
      expect(metadata.writes).toHaveLength(0);
      // No se vuelve a golpear a Keycloak mientras espera el SSO.
      await expect(renewal.renew(USER_ID, 'sweep')).resolves.toEqual({result: 'skipped', reason: 'awaiting_sso'});
      expect(tokens.refreshes).toHaveLength(1);
    });

    it('sin red hacia Keycloak: refresh_network y se reintenta luego (sin pedir SSO)', async () => {
      await seedAssistant();
      tokens.refreshed = new OAuthTokenError('unavailable', 'network');
      await expect(renewal.renew(USER_ID, 'sweep')).resolves.toEqual({result: 'retry_later', cause: 'refresh_network'});
      expect((await events()).at(-1)).toMatchObject({cause_code: 'refresh_failed', detail_safe: 'cause=refresh_network trigger=sweep reason=network'});
      expect(await renewal.needsSso(USER_ID)).toBe(false);
    });

    it('sin VM, borrado o en deleting/failed no hace nada', async () => {
      await seedAssistant({withInstance: false});
      await expect(renewal.renew(USER_ID, 'sweep')).resolves.toEqual({result: 'skipped', reason: 'no_instance'});
      await seedAssistant({userId: OTHER_USER, status: 'deleting'});
      await expect(renewal.renew(OTHER_USER, 'sweep')).resolves.toEqual({result: 'skipped', reason: 'not_renewable'});
      await expect(renewal.renew(THIRD_USER, 'sweep')).resolves.toEqual({result: 'skipped', reason: 'no_assistant'});
      expect(tokens.refreshes).toHaveLength(0);
    });

    it('llamadas concurrentes del mismo usuario comparten un solo refresh', async () => {
      await seedAssistant();
      tokens.refreshed = await tokenSet();
      const [a, b] = await Promise.all([renewal.renew(USER_ID, 'sweep'), renewal.renew(USER_ID, 'state_read')]);
      expect(a).toEqual({result: 'renewed'});
      expect(b).toEqual({result: 'renewed'});
      expect(tokens.refreshes).toHaveLength(1);
    });
  });

  describe('barrido periódico', () => {
    it('renueva solo credenciales de más de 7 días de asistentes con VM, encendidos o apagados', async () => {
      await seedAssistant({ageMs: 8 * DAY});
      await seedAssistant({userId: OTHER_USER, ageMs: 1 * DAY});
      await seedAssistant({userId: THIRD_USER, ageMs: 20 * DAY, status: 'stopped'});
      await seedAssistant({userId: 'u-deleted-1', ageMs: 20 * DAY, deleted: true});
      await seedAssistant({userId: 'u-failed-1', ageMs: 20 * DAY, status: 'failed'});
      await seedAssistant({userId: 'u-novm-1', ageMs: 20 * DAY, withInstance: false});
      tokens.refreshed = await tokenSet();
      const scheduler = new RenewalScheduler(renewal, store, {sweepIntervalMs: 6 * 3_600_000, maxAgeMs: 7 * DAY, batchSize: 25}, now);

      await expect(scheduler.sweep()).resolves.toEqual({due: 2, renewed: 2, failed: 0, skipped: 0});
      expect(metadata.writes.map(write => write.instance).sort()).toEqual([instanceNameFor(USER_ID), instanceNameFor(THIRD_USER)].sort());
      // Ya renovadas: el siguiente barrido no tiene nada que hacer.
      await expect(scheduler.sweep()).resolves.toEqual({due: 0, renewed: 0, failed: 0, skipped: 0});
      expect(logger.lines.some(line => line.includes('credential sweep due=2 renewed=2'))).toBe(true);
    });

    it('excluye a quien espera el SSO silencioso y respeta el tamaño del lote', async () => {
      await seedAssistant({ageMs: 9 * DAY});
      await seedAssistant({userId: OTHER_USER, ageMs: 8 * DAY});
      await seedAssistant({userId: THIRD_USER, ageMs: 10 * DAY});
      await repository.appendEvent({userId: THIRD_USER, kind: 'credential_renewal_failed', cause: 'login_required'});
      expect(await store.dueForRenewal(new Date(nowMs - 7 * DAY), 25)).toEqual([USER_ID, OTHER_USER]);
      expect(await store.dueForRenewal(new Date(nowMs - 7 * DAY), 1)).toEqual([USER_ID]);
    });

    it('start/stop programan el barrido sin mantener vivo el proceso', async () => {
      const scheduler = new RenewalScheduler(renewal, store, {sweepIntervalMs: 60_000, maxAgeMs: 7 * DAY, batchSize: 5, initialDelayMs: 10});
      const spy = jest.spyOn(scheduler, 'sweep');
      scheduler.start();
      await new Promise(resolve => setTimeout(resolve, 50));
      await scheduler.stop();
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe('disparadores: chat (OCB-011) y GET /assistants/me', () => {
    it('una tool mcp__saleads__* fallida resiembra en segundo plano; las nativas y repetidas se ignoran', async () => {
      await seedAssistant({ageMs: 1 * DAY});
      tokens.refreshed = await tokenSet();
      await renewal.reportMcpToolFailure(USER_ID, 'terminal');
      await renewal.reportMcpToolFailure(USER_ID, 'mcp__saleads__saleads_get_account_overview');
      await renewal.reportMcpToolFailure(USER_ID, 'mcp__saleads__saleads_get_business_profile');
      await renewal.idle();
      expect(tokens.refreshes).toHaveLength(1);
      expect((await events()).slice(1)).toEqual([
        {kind: 'credential.reseed_requested', phase: 'chat', cause_code: 'mcp_unavailable', detail_safe: 'tool=mcp__saleads__saleads_get_account_overview'},
        {kind: 'credential.renewed', phase: 'reseed', cause_code: null, detail_safe: 'trigger=mcp_failure'},
      ]);
      // Pasado el debounce vuelve a disparar.
      nowMs += 61_000;
      await renewal.reportMcpToolFailure(USER_ID, 'mcp__saleads__saleads_get_account_overview');
      await renewal.idle();
      expect(tokens.refreshes).toHaveLength(2);
    });

    it('GET /me con un fallo previo reintenta la resiembra (refresh del archivo borrado en la VM)', async () => {
      await seedAssistant({ageMs: 1 * DAY});
      // Fallo de MCP registrado por otro componente (p. ej. el proxy de chat).
      await repository.appendEvent({userId: USER_ID, kind: 'chat.mcp_unavailable', cause: 'mcp_unavailable'});
      tokens.refreshed = await tokenSet();
      const reader = new RenewalAwareStateReader(new RowAssistantStateReader(repository, now), renewal);
      const state = await reader.read(USER_ID);
      await renewal.idle();
      expect(state).toMatchObject({status: 'ready', step: null});
      expect(metadata.writes).toHaveLength(1);
      expect((await events()).at(-1)).toMatchObject({kind: 'credential.renewed', detail_safe: 'trigger=state_read'});
      // Sana: otra lectura no vuelve a refrescar.
      nowMs += 120_000;
      await reader.read(USER_ID);
      await renewal.idle();
      expect(tokens.refreshes).toHaveLength(1);
    });

    it('con el refresh muerto expone «Preparando tu acceso»; apagado conserva su estado', async () => {
      await seedAssistant({ageMs: 1 * DAY});
      await seedAssistant({userId: OTHER_USER, ageMs: 1 * DAY, status: 'stopped'});
      for (const userId of [USER_ID, OTHER_USER]) {
        await repository.appendEvent({userId, kind: 'credential_renewal_failed', cause: 'login_required'});
      }
      const reader = new RenewalAwareStateReader(new RowAssistantStateReader(repository, now), renewal);
      expect(await reader.read(USER_ID)).toMatchObject<Partial<AssistantStateV1>>({status: 'activating', step: 'preparing_access', slow: false});
      expect(await reader.read(OTHER_USER)).toMatchObject<Partial<AssistantStateV1>>({status: 'stopped', step: null});
      expect(tokens.refreshes).toHaveLength(0);
    });
  });

  describe('recuperación por SSO silencioso (activación de OCB-007)', () => {
    let activation: ActivationService;
    const secrets = new OAuthFlowSecrets(MASTER_KEY);

    beforeEach(() => {
      const provisioner = new Provisioner({
        zone: 'us-central1-a', issuer: ISSUER, mcp: {mcpUrl: MCP_URL, clientId: CLIENT_ID, scope: SCOPE},
        bundle: loadAgentBundle('distribution/saleads-sales-agent/1.1.0', 'saleads-sales-agent@1.1.0'),
        operationTimeoutMs: 0, retryDelayMs: 0,
      }, {repository, compute: new FakeCompute(), tokens, cipher, now});
      activation = new ActivationService({
        repository, cipher, secrets, tokens, provisioner, now, flowTtlMs: 600_000, recovery: renewal,
        assistantTokens: new IdentityVerifier({issuer: ISSUER, audience: MCP_URL, clients: [CLIENT_ID]}, keys.jwks),
        authorize: {authorizeUrl: `${ISSUER}/protocol/openid-connect/auth`, clientId: CLIENT_ID,
          redirectUri: 'https://dev.saleads.ai/api/sales-assistant/oauth/callback', scope: SCOPE},
      });
    });

    it('activation devuelve la authorize_url (prompt=none) y el callback recupera y resiembra sin crear VM', async () => {
      await seedAssistant({ageMs: 1 * DAY});
      tokens.refreshed = new OAuthTokenError('rejected', 'invalid_grant');
      await renewal.renew(USER_ID, 'mcp_failure');

      const response = await activation.activate(USER_ID, 'recover-0001') as {authorize_url: string};
      const url = new URL(response.authorize_url);
      expect(url.searchParams.get('prompt')).toBe('none');

      const fresh = await tokenSet('eyJrecovered-refresh-SECRET');
      tokens.next = fresh;
      await expect(activation.callback(USER_ID, {code: 'code-SECRET', state: url.searchParams.get('state')!})).resolves.toEqual({ok: true});

      expect(await storedRefresh()).toBe(fresh.refreshToken);
      expect(JSON.parse(metadata.value(instance, 'hermes-mcp-tokens')!)['tokens.json'].refresh_token).toBe(fresh.refreshToken);
      expect((await events()).slice(-2).map(event => event.kind)).toEqual(['credential.recovered', 'credential.renewed']);
      expect(await renewal.needsSso(USER_ID)).toBe(false);
      const [row] = await rows('SELECT status, instance_name FROM assistant.assistants WHERE user_id = $1', [USER_ID]);
      expect(row).toEqual({status: 'ready', instance_name: instance});
      // Ya sana: otra activación devuelve el estado, no otra URL.
      expect(await activation.activate(USER_ID, 'recover-0002')).toMatchObject({status: 'ready'});
      await noSecretsAnywhere(['eyJrecovered-refresh-SECRET', 'code-SECRET']);
    });

    it('sin necesidad de SSO, un callback tardío sobre un asistente listo no pisa la credencial', async () => {
      await seedAssistant({ageMs: 1 * DAY});
      expect(await activation.activate(USER_ID, 'click-0001')).toMatchObject({status: 'ready'});
      expect(await renewal.acceptRecoveredGrant(USER_ID, await tokenSet())).toBe(false);
      expect(await storedRefresh()).toBe(STORED_REFRESH);
      expect(metadata.writes).toHaveLength(0);
    });
  });

  describe('revocación RFC 7009 (para OCB-012)', () => {
    it('revoca el refresh guardado y borra la credencial', async () => {
      await seedAssistant();
      await expect(renewal.revokeStoredCredential(USER_ID)).resolves.toEqual({result: 'revoked'});
      expect(revocation.calls).toEqual([{token: STORED_REFRESH, hint: 'refresh_token'}]);
      expect(await storedRefresh()).toBeNull();
      expect((await events()).at(-1)).toMatchObject({kind: 'credential.revoked', cause_code: null});
      await expect(renewal.revokeStoredCredential(USER_ID)).resolves.toEqual({result: 'no_credential'});
    });

    it('si falla conserva la credencial y deja revoke_failed, sin lanzar', async () => {
      await seedAssistant();
      revocation.error = new OAuthTokenError('unavailable', 'http_503');
      await expect(renewal.revokeStoredCredential(USER_ID)).resolves.toEqual({result: 'failed', reason: 'unavailable:http_503'});
      expect(await storedRefresh()).toBe(STORED_REFRESH);
      expect((await events()).at(-1)).toEqual({kind: 'credential.revoke_failed', phase: 'revoke', cause_code: 'revoke_failed', detail_safe: 'reason=unavailable:http_503'});
      await noSecretsAnywhere([STORED_REFRESH]);
    });
  });
});

describe('KeycloakRevocationClient', () => {
  const calls: Array<{url: string; init: RequestInit}> = [];
  let reply: () => Response | Promise<Response> = () => new Response(null, {status: 200});
  const base = (async (url: string | URL, init?: RequestInit) => {calls.push({url: String(url), init: init ?? {}}); return reply();}) as typeof fetch;
  const client = new KeycloakRevocationClient(
    {revokeUrl: 'http://keycloak.keycloak.svc.cluster.local:8080/realms/sale-ads/protocol/openid-connect/revoke', clientId: CLIENT_ID},
    outboundFetch({userAgent: 'SaleADS-Assistant-Service/0.1 (+https://saleads.ai)', timeoutMs: 1000}, base),
  );
  beforeEach(() => {calls.length = 0; reply = () => new Response(null, {status: 200});});

  it('POST form con token, hint y client_id por el Keycloak interno, con User-Agent explícito', async () => {
    await client.revoke('eyJrefresh-SECRET');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://keycloak.keycloak.svc.cluster.local:8080/realms/sale-ads/protocol/openid-connect/revoke');
    expect(calls[0]!.init.method).toBe('POST');
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get('user-agent')).toBe('SaleADS-Assistant-Service/0.1 (+https://saleads.ai)');
    expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]!.init.body)))).toEqual({
      token: 'eyJrefresh-SECRET', token_type_hint: 'refresh_token', client_id: CLIENT_ID,
    });
  });

  it('400 → rejected con el código saneado; 5xx y red → unavailable; nunca cita el token', async () => {
    reply = () => Response.json({error: 'invalid_client', error_description: 'eyJ...'}, {status: 400});
    const rejected = await client.revoke('eyJrefresh-SECRET').catch(error => error);
    expect(rejected).toMatchObject({kind: 'rejected', reason: 'invalid_client'});
    expect(String(rejected.message)).not.toContain('eyJ');
    reply = () => new Response('down', {status: 503});
    await expect(client.revoke('x')).rejects.toMatchObject({kind: 'unavailable', reason: 'http_503'});
    reply = () => {throw new TypeError('fetch failed');};
    await expect(client.revoke('x')).rejects.toMatchObject({kind: 'unavailable', reason: 'network'});
  });
});

describe('RestInstanceMetadata', () => {
  const name = instanceNameFor(USER_ID);
  const calls: Array<{method: string; url: string; body: unknown}> = [];
  let replies: Array<() => Response> = [];
  const fetcher = async (url: string | URL, init?: RequestInit) => {
    calls.push({method: init?.method ?? 'GET', url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null});
    const next = replies.shift();
    if (!next) throw new Error('unexpected call');
    return next();
  };
  const client = new RestInstanceMetadata({project: 'saleads-dev', apiBase: 'https://compute.googleapis.com/compute/v1'},
    {token: async () => 'gcp-token'}, fetcher, {operationTimeoutMs: 5_000, pollIntervalMs: 0, sleep: async () => undefined});
  beforeEach(() => {calls.length = 0; replies = [];});

  it('lee fingerprint e items y escribe con setMetadata siguiendo la operación', async () => {
    replies = [
      () => Response.json({metadata: {fingerprint: 'abc=', items: [{key: 'a', value: '1'}, {key: 'bad'}]}}),
      () => Response.json({name: 'operation-1'}),
      () => Response.json({status: 'RUNNING'}),
      () => Response.json({status: 'DONE'}),
    ];
    const current = await client.read(name, 'us-central1-a');
    expect(current).toEqual({fingerprint: 'abc=', items: [{key: 'a', value: '1'}]});
    await expect(client.write(name, 'us-central1-a', current)).resolves.toBe('ok');
    expect(calls.map(call => `${call.method} ${call.url.replace('https://compute.googleapis.com/compute/v1', '')}`)).toEqual([
      `GET /projects/saleads-dev/zones/us-central1-a/instances/${name}`,
      `POST /projects/saleads-dev/zones/us-central1-a/instances/${name}/setMetadata`,
      'GET /projects/saleads-dev/zones/us-central1-a/operations/operation-1',
      'GET /projects/saleads-dev/zones/us-central1-a/operations/operation-1',
    ]);
    expect(calls[1]!.body).toEqual({fingerprint: 'abc=', items: [{key: 'a', value: '1'}]});
  });

  it('412 → conflict; otros errores → ComputeError saneado; nombres ajenos se rechazan sin llamar', async () => {
    replies = [() => Response.json({error: {errors: [{reason: 'conditionNotMet', message: 'eyJ'}]}}, {status: 412})];
    await expect(client.write(name, 'us-central1-a', {fingerprint: 'x', items: []})).resolves.toBe('conflict');
    replies = [() => Response.json({error: {errors: [{reason: 'notFound'}]}}, {status: 404})];
    await expect(client.read(name, 'us-central1-a')).rejects.toMatchObject({status: 404, reason: 'notFound'});
    await expect(client.read('other-vm', 'us-central1-a')).rejects.toMatchObject({status: 0, reason: 'invalid_instance'});
    expect(calls).toHaveLength(2);
  });
});

describe('configuración de OCB-009', () => {
  const base = {
    DATABASE_URL: 'postgresql://assistant:pw@127.0.0.1:5432/assistant_db',
    KEYCLOAK_ISSUER: 'https://keycloak-dev.saleads.ai/realms/sale-ads',
    KEYCLOAK_JWKS_URL: 'http://keycloak.keycloak.svc.cluster.local:8080/realms/sale-ads/protocol/openid-connect/certs',
    POSTHOG_API_KEY: 'phc_test',
    FIELD_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
  };

  it('por defecto: revoke interno, renovación encendida a los 7 días, barrido cada 6 h', () => {
    expect(configuration(base)).toMatchObject({
      KEYCLOAK_REVOKE_URL: 'http://keycloak.keycloak.svc.cluster.local:8080/realms/sale-ads/protocol/openid-connect/revoke',
      ASSISTANT_RENEWAL_ENABLED: true,
      ASSISTANT_RENEWAL_MAX_AGE_MS: 7 * DAY,
      ASSISTANT_RENEWAL_SWEEP_INTERVAL_MS: 6 * 3_600_000,
      ASSISTANT_RENEWAL_BATCH_SIZE: 25,
      ASSISTANT_RENEWAL_RETRY_DEBOUNCE_MS: 60_000,
    });
    expect(configuration({...base, ASSISTANT_RENEWAL_ENABLED: 'false'}).ASSISTANT_RENEWAL_ENABLED).toBe(false);
  });

  it('no deja una edad de renovación que se acerque al idle offline de 30 días', () => {
    expect(() => configuration({...base, ASSISTANT_RENEWAL_MAX_AGE_MS: String(29 * DAY)})).toThrow(/ASSISTANT_RENEWAL_MAX_AGE_MS/);
    expect(() => configuration({...base, ASSISTANT_RENEWAL_ENABLED: 'yes'})).toThrow(/ASSISTANT_RENEWAL_ENABLED/);
  });
});
