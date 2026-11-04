import {scopedJobPrompt, type ManagedBusinessJobs} from '../src/notifications/jobs';
import {jobTextHash} from '../src/activation/hermes-files';
import {readySyncCallback} from '../src/orqa/orqa-sync';
import type {AssistantRow} from '../src/persistence/assistant-repository';
import {stockJobsBundle, stockJobSync} from '../src/stock/jobs';
import {buildStock, stockSettings} from '../src/stock/module';
import {ManagedMetaBootstrap} from '../src/ai/managed-meta';
import {META_MODEL_ID, META_PROVIDER_ID} from '../src/ai/meta-model';
import {managedMetaPrepare, StockSyncDriver} from '../src/stock/sync-driver';
import {STOCK_TICK_JOB} from '../src/stock/wake';
import {INSTANCE} from './support/hermes-fakes';
import {addonFor} from './support/stock-addon';
import {realBundle, realSetup, USER} from './support/stock-desired';

const A = 'user-a', B = 'user-b';
const ready = (user: string) => ({user_id: user, status: 'ready', instance_name: `vm-${user}`, ready_since: new Date(0)}) as unknown as AssistantRow;

function driver(users: string[], rows: Record<string, AssistantRow | null>, onReady: (user: string, instance: string | null) => Promise<void> | undefined) {
  const events: Array<{userId: string; kind: string}> = [];
  const now = {value: 0};
  const sync = new StockSyncDriver({intervalMs: 300_000}, {
    userIds: new Set(users),
    repository: {findActive: async user => rows[user] ?? null, appendEvent: async event => {events.push(event);}},
    onReady, now: () => new Date(now.value),
  });
  return {sync, events, now};
}

describe('driver de sincronización', () => {
  it('solo toca a los usuarios de STOCK_USER_IDS, y lee por usuario', async () => {
    const onReady = jest.fn(async () => undefined);
    const {sync, events} = driver([A], {[A]: ready(A), [B]: ready(B)}, onReady);
    expect(await sync.tick()).toEqual({requested: 1, notReady: 0, failed: 0});
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith(A, `vm-${A}`, new Date(0));
    expect(events).toEqual([{userId: A, kind: 'stock.sync_requested', phase: 'orqa'}]);
  });

  it('usuario no listo se salta sin error', async () => {
    const onReady = jest.fn(async () => undefined);
    const {sync} = driver([A, B], {[A]: {...ready(A), status: 'activating'} as AssistantRow, [B]: null}, onReady);
    expect(await sync.tick()).toEqual({requested: 0, notReady: 2, failed: 0});
    expect(onReady).not.toHaveBeenCalled();
  });

  it('una falla en A no impide a B ni el siguiente tick', async () => {
    const seen: string[] = [];
    const {sync} = driver([A, B], {[A]: ready(A), [B]: ready(B)}, async user => {
      seen.push(user);
      if (user === A) throw new Error('falla');
    });
    expect(await sync.tick()).toEqual({requested: 1, notReady: 0, failed: 1});
    expect(await sync.tick()).toEqual({requested: 1, notReady: 0, failed: 1});
    expect(seen).toEqual([A, B, A, B]);
  });

  it('kick: 10 veces en 60 s hacen una llamada; pasado el plazo, otra; un usuario ajeno ninguna', async () => {
    const onReady = jest.fn(async () => undefined);
    const {sync, now} = driver([A], {[A]: ready(A)}, onReady);
    for (let index = 0; index < 10; index++) sync.kick(A);
    sync.kick(B);
    await new Promise(resolve => setImmediate(resolve));
    expect(onReady).toHaveBeenCalledTimes(1);
    now.value = 60_000;
    sync.kick(A);
    await new Promise(resolve => setImmediate(resolve));
    expect(onReady).toHaveBeenCalledTimes(2);
  });

  it('stop espera la corrida en curso', async () => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => {finish = resolve;});
    const {sync} = driver([A], {[A]: ready(A)}, () => pending);
    const tick = sync.tick();
    await new Promise(resolve => setImmediate(resolve));
    let stopped = false;
    const stop = sync.stop().then(() => {stopped = true;});
    await new Promise(resolve => setImmediate(resolve));
    expect(stopped).toBe(false);
    finish();
    await Promise.all([tick, stop]);
    expect(stopped).toBe(true);
  });

  it('el temporizador corre solo con start, y start no duplica', () => {
    jest.useFakeTimers();
    try {
      const onReady = jest.fn(async () => undefined);
      const {sync} = driver([A], {[A]: ready(A)}, onReady);
      expect(jest.getTimerCount()).toBe(0);
      sync.start();
      sync.start();
      expect(jest.getTimerCount()).toBe(1);
      void sync.stop();
      expect(jest.getTimerCount()).toBe(0);
    } finally {jest.useRealTimers();}
  });

  it('STOCK_ENABLED=false no crea temporizador; sin inferencia gestionada, buildStock no arma el driver', async () => {
    const query = jest.fn(async () => ({rows: []}));
    const sync = {intervalMs: 300_000, repository: {} as never, onReady: () => undefined};
    jest.useFakeTimers();
    try {
      const off = stockSettings({STOCK_ENABLED: false, STOCK_USER_IDS: [], STOCK_BUSINESS_SEEDS: [], STOCK_WEB_BASE_URL: '', STOCK_BENCH_ENABLED: false, STOCK_MAX_AUTONOMY_LEVEL: 2});
      expect(await buildStock(off, {pool: {query} as never, sync})).toBeUndefined();
      expect(jest.getTimerCount()).toBe(0);
      const on = {...off, enabled: true};
      expect((await buildStock(on, {pool: {query} as never}))?.syncDriver).toBeUndefined();
      expect((await buildStock(on, {pool: {query} as never, sync}))?.syncDriver).toBeInstanceOf(StockSyncDriver);
    } finally {jest.useRealTimers();}
  });
});

describe('con OrqaSync real sobre fakes', () => {
  const world = (retryAfterMs = 60_000) => {
    const harness = realSetup({retryAfterMs}, {addon: addonFor(USER)});
    const orqa = harness.make();
    const after = jest.fn(async () => undefined);
    const onReady = readySyncCallback(orqa, after, true);
    const now = {value: 0};
    const sync = new StockSyncDriver({intervalMs: 300_000}, {userIds: new Set([USER]), repository: harness.repository, onReady, now: () => new Date(now.value)});
    return {harness, orqa, after, sync, onReady};
  };

  it('sin abrir la web la VM queda sincronizada, y el segundo tick no escribe metadata', async () => {
    const {harness, sync} = world();
    await sync.tick();
    expect(harness.instances.sets).toHaveLength(1);
    expect(harness.instances.sets[0]!.items.find(item => item.key === 'hermes-bundle-version')?.value).toContain('+stock-1.0.8');
    await sync.tick();
    expect(harness.instances.sets).toHaveLength(1);
  });

  it('seed corre una vez; un GET /me posterior no lo repite ni lo omite', async () => {
    const {harness, sync, after, onReady} = world();
    await sync.tick();
    expect(after).toHaveBeenCalledTimes(1);
    await onReady(USER, INSTANCE, harness.row.ready_since ?? null);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('tras un fallo, un tick dentro de retryAfterMs no escribe; pasado el plazo, sí', async () => {
    let clock = 0;
    const {harness, orqa} = world();
    (orqa as unknown as {now: () => Date}).now = () => new Date(clock);
    const setMetadata = harness.instances.setMetadata.bind(harness.instances);
    const calls = jest.fn();
    harness.instances.setMetadata = async (...args) => {
      calls();
      if (calls.mock.calls.length === 1) throw new Error('compute');
      return setMetadata(...args);
    };
    const sync = new StockSyncDriver({intervalMs: 300_000}, {userIds: new Set([USER]), repository: harness.repository,
      onReady: readySyncCallback(orqa, async () => undefined, true), now: () => new Date(clock)});
    expect(await sync.tick()).toMatchObject({requested: 1, failed: 0});
    expect(calls).toHaveBeenCalledTimes(1);
    clock = 59_000;
    await sync.tick();
    expect(calls).toHaveBeenCalledTimes(1);
    clock = 61_000;
    await sync.tick();
    expect(calls).toHaveBeenCalledTimes(2);
    expect(harness.events.map(event => event.kind)).toContain('orqa.synced');
  });
});

describe('saleads:stock-tick con ManagedBusinessJobs', () => {
  const addon = addonFor(USER);
  const input = (owner: string, business: string) => ({context: {owner_id: owner, business_id: business}, target: {}, instance_generation: 'g'}) as never;

  it('el bundle propio solo trae el trabajo de Stock y no toca el de 1.5.13', () => {
    const base = realBundle();
    const jobs = stockJobsBundle(addon, base);
    expect(jobs.jobs.map(job => job.name)).toEqual([STOCK_TICK_JOB]);
    expect(base.jobs.map(job => job.name)).not.toContain(STOCK_TICK_JOB);
    expect(base.jobs.length).toBeGreaterThan(1);
  });

  it('solo corre para usuario y negocio habilitados', async () => {
    const synchronize = jest.fn(async () => ({active: [STOCK_TICK_JOB], preserved: [], pending: []}));
    const sync = stockJobSync(addon, {synchronize} as unknown as ManagedBusinessJobs, async owner => owner === USER ? ['habilitado'] : ['habilitado']);
    expect(await sync(input('otro', 'habilitado'))).toBeNull();
    expect(await sync(input(USER, 'otro-negocio'))).toBeNull();
    expect(synchronize).not.toHaveBeenCalled();
    expect(await sync(input(USER, 'habilitado'))).toMatchObject({active: [STOCK_TICK_JOB]});
    expect(synchronize).toHaveBeenCalledTimes(1);
  });
});

describe('texto de saleads:stock-tick al cambiar el complemento (IVB-023)', () => {
  // dev, 2-nov: con 1.0.1 sincronizado, el trabajo con alcance siguió con el prompt de 1.0.0 (`jobs_updated=0`).
  const addon = addonFor(USER);
  const bundle = stockJobsBundle(addon, realBundle());
  const job = bundle.jobs[0]!;
  const context = {owner_id: USER, business_id: 'habilitado', session_id: 'saleads-flow-s1', actor_role: 'ale'};
  const name = `${job.name}:habilitado`;
  const oldJob = {...job, prompt: 'prompt de 1.0.0'};
  const oldText = scopedJobPrompt(oldJob, context as never);
  const oldHash = jobTextHash(oldText, job.skills);
  const newText = scopedJobPrompt(job, context as never);
  const setup = (over: {live?: string; session?: string; phase?: string; update?: 'updated' | 'rejected'; retext?: boolean} = {}) => {
    let live = {id: 'aaaaaaaaaaaa', name, prompt: over.live ?? oldText, skills: [...job.skills], enabled: true, schedule: job.schedule, deliver: 'saleads_home:current', paused_reason: null, origin: {platform: 'api_server', chatId: 'api'}};
    const native = {
      list: jest.fn(async () => ({kind: 'ok' as const, jobs: [live]})),
      updateText: jest.fn(async (_t: unknown, _id: string, patch: {prompt?: string}) => {
        if ((over.update ?? 'updated') === 'updated') live = {...live, prompt: patch.prompt!};
        return over.update === 'rejected' ? {kind: 'rejected' as const, status: 400} : {kind: 'updated' as const};
      }),
    };
    const intents = {
      find: jest.fn(async () => ({job_name: name, phase: over.phase ?? 'active', native_job_id: live.id, session_id: over.session ?? context.session_id, desired_hash: oldHash}) as never),
      retext: jest.fn(async () => over.retext ?? true),
    };
    const synchronize = jest.fn(async () => ({active: [name], preserved: [], pending: []}));
    const sync = stockJobSync(addon, {synchronize} as unknown as ManagedBusinessJobs, async () => ['habilitado'], {bundle, native, intents});
    return {sync: () => sync({context, target: {}, instance_generation: 'g'} as never), native, intents};
  };

  it('el texto instalado por el servicio pasa al de la versión vigente, sin tocar nombre ni horario', async () => {
    const {sync, native, intents} = setup();
    expect(await sync()).toMatchObject({text_updated: [name], pending: []});
    expect(native.updateText).toHaveBeenCalledWith({}, 'aaaaaaaaaaaa', {prompt: newText, skills: [...job.skills]}, expect.any(Number));
    expect(intents.retext).toHaveBeenCalledWith(expect.objectContaining({base_name: job.name, business_id: 'habilitado'}), oldHash, jobTextHash(newText, job.skills));
  });

  it('ya al día no escribe', async () => {
    const out = setup({live: newText});
    out.intents.find.mockResolvedValue({job_name: name, phase: 'active', native_job_id: 'aaaaaaaaaaaa', session_id: context.session_id, desired_hash: jobTextHash(newText, job.skills)} as never);
    expect(await out.sync()).toMatchObject({text_updated: []});
    expect(out.native.updateText).not.toHaveBeenCalled();
    expect(out.native.list).not.toHaveBeenCalled();
  });

  it('una edición del dueño queda intacta', async () => {
    const {sync, native} = setup({live: 'mi prompt editado'});
    expect(await sync()).toMatchObject({text_updated: [], preserved: [{name, reason: 'text_update_owner_edited'}]});
    expect(native.updateText).not.toHaveBeenCalled();
  });

  it('con otra sesión canónica o intent no activo no toca nada', async () => {
    for (const over of [{session: 'saleads-flow-otra'}, {phase: 'preserved'}]) {
      const {sync, native} = setup(over);
      expect(await sync()).toMatchObject({text_updated: []});
      expect(native.updateText).not.toHaveBeenCalled();
    }
  });

  it('si Hermes rechaza o el intent cambió, queda pendiente', async () => {
    expect(await setup({update: 'rejected'}).sync()).toMatchObject({text_updated: [], pending: [{name, reason: `text_update_failed:rejected:400:len=${newText.length}`}]});
    expect(await setup({retext: false}).sync()).toMatchObject({text_updated: [], pending: [{name, reason: 'text_update_intent_changed'}]});
  });
});

describe('inferencia gestionada tras reiniciar el pod', () => {
  // dev, 2-nov: con el pod recién arrancado nadie abrió la web, Meta no estaba verificado y cada tick quedaba en
  // `stock.sync_requested` sin `orqa.synced`. La VM siguió en 1.5.13.
  const world = (prepare: boolean) => {
    const meta = new ManagedMetaBootstrap({enabled: true, userId: '', allUsers: true, apiKey: ''}, {
      read: async () => ({status: 'ready', step: null, instance_name: INSTANCE}) as never,
      configure: async () => ({result: 'ok'}),
      credentialForUser: async () => 'llave-de-prueba',
      reconcile: async () => 'ready',
    });
    const harness = realSetup({}, {addon: addonFor(USER),
      canSynchronize: userId => meta.isReady(userId, {configured: true, provider: META_PROVIDER_ID, model: META_MODEL_ID} as never)});
    const orqa = harness.make();
    const sync = new StockSyncDriver({intervalMs: 300_000}, {userIds: new Set([USER]), repository: harness.repository,
      onReady: readySyncCallback(orqa, async () => undefined, true), now: () => new Date(0),
      ...(prepare ? {prepare: managedMetaPrepare(meta)} : {})});
    return {harness, sync, meta};
  };

  it('el tick verifica Meta y la VM recibe la variante sin abrir la web', async () => {
    const {harness, sync, meta} = world(true);
    expect(meta.isVerified(USER)).toBe(false);
    await sync.tick();
    expect(meta.isVerified(USER)).toBe(true);
    expect(harness.instances.sets).toHaveLength(1);
    expect(harness.instances.sets[0]!.items.find(item => item.key === 'hermes-bundle-version')?.value).toContain('+stock-1.0.8');
    expect(harness.events.map(event => event.kind)).toContain('orqa.synced');
  });

  it('sin verificar, OrqaSync salta en silencio: por eso el driver lo prepara', async () => {
    const {harness, sync} = world(false);
    await sync.tick();
    expect(harness.instances.sets).toHaveLength(0);
    expect(harness.events.map(event => event.kind)).not.toContain('orqa.synced');
  });

  it('ya verificado o no gestionado, no vuelve a pedir la verificación', async () => {
    const request = jest.fn(), idle = jest.fn(async () => undefined);
    await managedMetaPrepare({manages: () => true, isVerified: () => true, request, idle})(USER);
    await managedMetaPrepare({manages: () => false, isVerified: () => false, request, idle})(USER);
    expect(request).not.toHaveBeenCalled();
    await managedMetaPrepare({manages: () => true, isVerified: () => false, request, idle})(USER);
    expect(request).toHaveBeenCalledWith(USER);
    expect(idle).toHaveBeenCalledTimes(1);
  });
});
