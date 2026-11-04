import {gzipSync, gunzipSync} from 'node:zlib';
import {loadAgentBundle} from '../src/activation/hermes-files';
import {metadataTar} from '../src/activation/metadata-archive';
import {META_EXTENSION_FILES} from '../src/activation/vm-extensions';
import {ManagedMetaBootstrap, ManagedMetaStateReader} from '../src/ai/managed-meta';
import {META_MODEL_ID, META_PROVIDER_ID} from '../src/ai/meta-model';
import {withMetadataValues} from '../src/compute/metadata';
import {ReadinessStateReader} from '../src/lifecycle/readiness-state-reader';
import {RenewalAwareStateReader} from '../src/renewal/renewal-state-reader';
import {readySyncCallback} from '../src/orqa/orqa-sync';
import {setup, USER} from './support/orqa-fakes';
import {INSTANCE, VM_IP} from './support/hermes-fakes';

const bundle = loadAgentBundle('distribution/saleads-sales-agent/1.5.13', 'saleads-sales-agent@1.5.13');
type Mode = {deferred?: boolean; flagDenied?: boolean; renewal?: boolean; classic?: boolean; disabled?: boolean};
async function harness(mode: Mode = {}) {
  const scope = {enabled: !mode.classic, allUsers: true, userId: USER};
  const ctx = setup({managedMeta: scope, ...(mode.disabled ? {brainImage: null} : {})}, bundle,
    user => mode.classic || meta.isReady(user, {configured: true, provider: META_PROVIDER_ID, model: META_MODEL_ID}));
  Object.assign(ctx.row, {status: 'ready', ai_configured: true, ai_provider: META_PROVIDER_ID, ai_model: META_MODEL_ID,
    private_ip: VM_IP, bundle_version: 'saleads-sales-agent@1.5.9', ready_since: new Date('2026-10-29T10:00:00Z')});
  ctx.instances.view!.generation = 'same-existing-generation';
  const guest = ctx.instances.guestAttribute.bind(ctx.instances);
  ctx.instances.guestAttribute = async (name, key) => key === 'hermes/watcher-version' ? '11' : guest(name, key);
  const legacyFiles = Object.keys(META_EXTENSION_FILES).filter(name => !name.includes('role-catalog') && !name.includes('landing_experience') && !name.startsWith('runtime/landing-pilot/'));
  expect(legacyFiles).toHaveLength(27);
  await ctx.instances.setMetadata(INSTANCE, ctx.instances.view!.fingerprint, withMetadataValues(ctx.instances.view!.items, {
    'hermes-bundle-version': 'saleads-sales-agent@1.5.12',
    'hermes-extensions': gzipSync(metadataTar(Object.fromEntries(legacyFiles.map(name => [name, '# synthetic old asset'])))).toString('base64'),
  }));
  await ctx.instances.guestAttribute(INSTANCE, 'hermes/applied-version');
  ctx.instances.sets.length = 0;
  const configure = jest.fn(async () => ({result: 'ok' as const}));
  const reconcile = jest.fn(async () => mode.deferred ? 'deferred' as const : 'ready' as const);
  const meta = new ManagedMetaBootstrap({...scope, apiKey: 'synthetic-platform-key'}, {
    read: async () => ctx.row, configure, reconcile,
    credentialForUser: async () => mode.flagDenied ? null : 'synthetic-account-relay-key',
  });
  const orqa = ctx.make(), seeded = jest.fn(async () => undefined), pending: Promise<unknown>[] = [];
  const callback = readySyncCallback(orqa, () => seeded(), !mode.classic);
  const onReady = (user: string, name: string | null, since: Date | null) => {
    const task = callback(user, name, since);
    if (task) pending.push(task);
  };
  const inner = new ReadinessStateReader({healthTimeoutMs: 10, budgetMs: 20, cacheTtlMs: 0, graceMs: 0}, {
    repository: ctx.repository as never, readiness: {apply: jest.fn()} as never,
    instances: ctx.instances, hermes: ctx.hermes, cipher: ctx.cipher, onReady,
  });
  const renewal = new RenewalAwareStateReader(inner, {onStateRead: async () => ({needsSso: !!mode.renewal})} as never);
  let postReadyCalls = 0;
  const reader = new ManagedMetaStateReader(renewal, meta, (user: string) => {
    postReadyCalls++;
    return inner.notifyReady(user);
  });
  const flush = async () => {await meta.idle(); await new Promise(setImmediate); await Promise.all(pending); await new Promise(setImmediate);};
  return {...ctx, reader, meta, seeded, configure, reconcile, flush, postCalls: () => postReadyCalls};
}

describe('ready Meta rows after a control restart', () => {
  it('the first ready read upgrades an existing old bundle after read-only model verification without a second GET', async () => {
    const ctx = await harness();
    expect(ctx.meta.isReady(USER, {configured: true, provider: META_PROVIDER_ID, model: META_MODEL_ID})).toBe(false);
    expect((await ctx.reader.read(USER)).status).toBe('ready');
    await ctx.flush();
    expect(ctx.instances.item('hermes-bundle-version')).toBe('saleads-sales-agent@1.5.13');
    expect(ctx.instances.sets).toHaveLength(1);
    expect(gunzipSync(Buffer.from(ctx.instances.item('hermes-extensions')!, 'base64')).toString('utf8')).toContain('runtime/landing-pilot/cli/landing_cli.py');
    expect(ctx.configure).not.toHaveBeenCalled(); expect(ctx.hermes.probeCalls).toHaveLength(0);
    expect(ctx.seeded).toHaveBeenCalledTimes(1);
    await ctx.reader.read(USER); await ctx.reader.read(USER); await ctx.flush();
    expect(ctx.instances.sets).toHaveLength(1); expect(ctx.seeded).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent first reads and seed work using the same ORQA promise', async () => {
    const ctx = await harness();
    await Promise.all([ctx.reader.read(USER), ctx.reader.read(USER), ctx.reader.read(USER)]); await ctx.flush();
    expect(ctx.instances.sets).toHaveLength(1); expect(ctx.seeded).toHaveBeenCalledTimes(1);
    expect(ctx.configure).not.toHaveBeenCalled(); expect(ctx.reconcile).toHaveBeenCalledTimes(1);
  });

  it.each([{deferred: true}, {flagDenied: true}, {renewal: true}])('retains the verification/flag/renewal guard %j', async mode => {
    const ctx = await harness(mode);
    const state = await ctx.reader.read(USER); await ctx.flush();
    expect(state.status).toBe('activating');
    expect(ctx.instances.sets).toHaveLength(0); expect(ctx.seeded).not.toHaveBeenCalled();
    expect(ctx.configure).not.toHaveBeenCalled(); expect(ctx.postCalls()).toBe(0);
    if (mode.renewal) {expect(state.step).toBe('preparing_access'); expect(ctx.reconcile).not.toHaveBeenCalled();}
  });

  it('does not turn an off synchronizer into a bundle installation', async () => {
    const ctx = await harness({disabled: true});
    expect((await ctx.reader.read(USER)).status).toBe('ready'); await ctx.flush();
    expect(ctx.instances.sets).toHaveLength(0); expect(ctx.seeded).not.toHaveBeenCalled();
    expect(ctx.configure).not.toHaveBeenCalled();
  });

  it('keeps the classic readiness callback and never invokes Meta reconciliation or its replay', async () => {
    const ctx = await harness({classic: true});
    expect((await ctx.reader.read(USER)).status).toBe('ready'); await ctx.flush();
    expect(ctx.instances.sets).toHaveLength(1); expect(ctx.seeded).toHaveBeenCalledTimes(1);
    expect(ctx.postCalls()).toBe(0); expect(ctx.reconcile).not.toHaveBeenCalled(); expect(ctx.configure).not.toHaveBeenCalled();
  });
});
