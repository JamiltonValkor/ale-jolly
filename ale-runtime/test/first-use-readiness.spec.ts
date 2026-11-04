import {loadAgentBundle} from '../src/activation/hermes-files';
import {FirstLoopService} from '../src/first-loop/service';
import {FirstLoopRepository} from '../src/first-loop/repository';
import {LanguagePreferences} from '../src/locale/preferences';
import {gunzipSync} from 'node:zlib';
import type {AssistantRow} from '../src/persistence/assistant-repository';
import {setup, USER} from './support/orqa-fakes';
import {INSTANCE, VM_IP, HEALTHY, NO_MODEL} from './support/hermes-fakes';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';

const BUSINESS = '11111111-1111-4111-8111-111111111111';
const OTHER_BUSINESS = '22222222-2222-4222-8222-222222222222';
const OTHER_OWNER = 'existing-owner';
const bundle = loadAgentBundle('distribution/saleads-sales-agent/1.5.12', 'saleads-sales-agent@1.5.12');
const deferred = () => {let resolve!: () => void; const promise = new Promise<void>(done => {resolve = done;}); return {promise, resolve};};

function runtime() {
  const ctx = setup({managedMeta: {enabled: true, userId: USER, allUsers: true}, ackTimeoutMs: 10, retryAfterMs: 600_000}, bundle);
  Object.assign(ctx.row, {ai_configured: true, private_ip: VM_IP, ready_since: new Date('2026-11-02T10:00:00Z')});
  ctx.instances.view!.generation = 'new-instance-generation';
  const guest = ctx.instances.guestAttribute.bind(ctx.instances);
  let ack = true;
  ctx.instances.guestAttribute = async (name, key) => key === 'hermes/watcher-version' ? '10' : key === 'hermes/applied-version' && !ack ? null : guest(name, key);
  return {...ctx, sync: ctx.make(), allowAck: (value: boolean) => {ack = value;}};
}

describe('initial managed setup completion barrier', () => {
  let pg: TestDatabase;
  beforeAll(async () => {pg = await startTestDatabase();});
  afterAll(async () => {await pg.close();});

  it('keeps the initial guide pending with zero native attempts until the late physical type, ACK and health settle; existing owner chat stays usable', async () => {
    const ctx = runtime();
    const repository = new FirstLoopRepository(pg.database, ctx.cipher);
    const languages = new LanguagePreferences(pg.database);
    await languages.synchronize(USER, {language_code: 'en', source_updated_at: '2026-11-02T10:00:00Z'});
    await languages.synchronize(OTHER_OWNER, {language_code: 'en', source_updated_at: '2026-10-30T10:00:00Z'});
    const start = jest.fn(async () => ({run_id: 'run-initial-guidance', status: 'queued'}));
    const rowA = {...ctx.row, user_id: OTHER_OWNER, instance_name: 'existing-vm', api_server_key_enc: ctx.cipher.seal('assistants.api_server_key_enc', OTHER_OWNER, 'existing-key')};
    let profileStored = false, readinessUnavailable = true;
    const firstUseReady = jest.fn(async (row: AssistantRow) => {
      if (readinessUnavailable) throw new Error('Transient readiness read failure');
      return profileStored && await ctx.sync.readyForFirstUse(row);
    });
    const service = new FirstLoopService({enabled: true, userId: USER, allUsers: true, continuousLearning: true}, {
      repository, languages, cipher: ctx.cipher, assistants: {findActive: async owner => owner === USER ? ctx.row : rowA},
      ownedBusinesses: async owner => new Set([owner === USER ? BUSINESS : OTHER_BUSINESS]),
      bootstrap: async () => ({business: {name: 'Synthetic physical goods business'}}), firstUseReady,
      runs: {start, status: async () => 'completed', capabilities: async () => ({supported: true, durable: true, retention_seconds: 86400})},
      hermes: {ensureSession: async () => ({kind: 'ok'}), messages: async () => ({kind: 'ok', messages: []})} as never,
      instances: ctx.instances, storage: {signedPutUrl: async () => 'https://storage.example.invalid/upload', download: async () => null, upload: async () => undefined},
    });
    // The early readiness sync has no confirmed type yet, as on a new activation.
    await ctx.sync.onReady(USER, INSTANCE, ctx.row.ready_since);
    const initial = await service.state(USER, BUSINESS); await service.idle();
    expect(initial.latest_turn).toMatchObject({status: 'accepted', run_id: null});
    expect((await repository.turns(initial.flow_id))[0]!.dispatch_attempts).toBe(0);
    expect((await repository.turns(initial.flow_id))[0]!.status).toBe('accepted');
    expect(start).not.toHaveBeenCalled();
    readinessUnavailable = false;
    await service.state(USER, BUSINESS); await service.idle(); expect(start).not.toHaveBeenCalled();

    const flowA = await repository.ensureFlow(OTHER_OWNER, OTHER_BUSINESS, 'en');
    await service.message(OTHER_OWNER, OTHER_BUSINESS, {flow_id: flowA.id, client_message_id: '33333333-3333-4333-8333-333333333333', text: 'Continue my current proposal.', response_locale: 'en'});
    await service.idle(); expect(start).toHaveBeenCalledTimes(1);
    expect(firstUseReady.mock.calls.every(([row]) => row.user_id === USER)).toBe(true);

    // The type is persisted before the background resync finishes applying it.
    profileStored = true; ctx.types.push('physical_product'); ctx.allowAck(false);
    await ctx.sync.resync(USER);
    await service.state(USER, BUSINESS); await service.idle();
    expect(start).toHaveBeenCalledTimes(1);
    expect((await repository.turns(initial.flow_id))[0]!.dispatch_attempts).toBe(0);
    expect(gunzipSync(Buffer.from(ctx.instances.item('hermes-profiles')!, 'base64')).toString('utf8')).toContain('saleads-type-physical-product');

    // A late ACK must unblock during the old ten-minute retry backoff, without another write.
    const writes = ctx.instances.sets.length; ctx.allowAck(true);
    await service.state(USER, BUSINESS); await service.idle();
    expect(start).toHaveBeenCalledTimes(2); expect(ctx.instances.sets).toHaveLength(writes);
    const orientation = (await repository.turns(initial.flow_id))[0]!;
    expect(orientation.run_id).toBe('run-initial-guidance'); expect(orientation.dispatch_attempts).toBe(1);
    await service.state(USER, BUSINESS); await service.idle();
    expect(start).toHaveBeenCalledTimes(2);
    // A terminal native failure is retained; opening the chat never invents a replacement owner request.
    await repository.setRun(orientation.id, orientation.run_id, 'failed');
    await service.state(USER, BUSINESS); await service.idle(); expect(start).toHaveBeenCalledTimes(2);
  });

  it('does not accept desired-but-unapplied unchanged metadata after an ACK timeout', async () => {
    const ctx = runtime(); ctx.allowAck(false);
    expect(await ctx.sync.onReady(USER, INSTANCE, ctx.row.ready_since)).toBe('failed');
    const writes = ctx.instances.sets.length;
    expect(await ctx.make().onReady(USER, INSTANCE, ctx.row.ready_since)).toBe('failed');
    expect(ctx.instances.sets).toHaveLength(writes);
    ctx.allowAck(true);
    expect(await ctx.sync.readyForFirstUse(ctx.row)).toBe(true);
    expect(ctx.instances.sets).toHaveLength(writes);
  });

  it('invalidates readiness immediately when a type resync queues behind a running sync', async () => {
    const ctx = runtime();
    await ctx.sync.onReady(USER, INSTANCE, ctx.row.ready_since);
    expect(await ctx.sync.readyForFirstUse(ctx.row)).toBe(true);
    const health = deferred(), observed = deferred();
    ctx.hermes.healthScript.push(async () => {observed.resolve(); await health.promise; return HEALTHY;});
    const checking = ctx.sync.readyForFirstUse(ctx.row); await observed.promise;
    ctx.types.push('physical_product'); const resync = ctx.sync.resync(USER);
    health.resolve();
    expect(await checking).toBe(false); await resync;
    expect(await ctx.sync.readyForFirstUse(ctx.row)).toBe(true);
  });

  it('rechecks the real generation, current desired type and health instead of trusting a previous sync cache', async () => {
    const ctx = runtime(); await ctx.sync.onReady(USER, INSTANCE, ctx.row.ready_since);
    expect(await ctx.sync.readyForFirstUse(ctx.row)).toBe(true);
    // The DB type changes before its asynchronous onTypeChanged notification arrives.
    ctx.types.push('physical_product');
    expect(await ctx.sync.readyForFirstUse(ctx.row)).toBe(false);
    await ctx.sync.onReady(USER, INSTANCE, ctx.row.ready_since);
    expect(await ctx.sync.readyForFirstUse(ctx.row)).toBe(true);
    ctx.hermes.healthDefault = NO_MODEL;
    expect(await ctx.sync.readyForFirstUse(ctx.row)).toBe(false);
    ctx.hermes.healthDefault = HEALTHY;
    // A second type write can land before its event/callback invalidates the sync cache.
    ctx.hermes.healthScript.push(async () => {ctx.types.push('service'); return HEALTHY;});
    expect(await ctx.sync.readyForFirstUse(ctx.row)).toBe(false);
    expect(await ctx.sync.readyForFirstUse(ctx.row)).toBe(false);
    await ctx.sync.onReady(USER, INSTANCE, ctx.row.ready_since);
    const before = ctx.instances.view!.generation;
    const originalHealth = ctx.hermes.health.bind(ctx.hermes);
    ctx.hermes.health = async target => {ctx.instances.view!.generation = 'replacement-generation'; return originalHealth(target);};
    expect(await ctx.sync.readyForFirstUse(ctx.row)).toBe(false);
    expect(ctx.instances.view!.generation).not.toBe(before);
  });
});
