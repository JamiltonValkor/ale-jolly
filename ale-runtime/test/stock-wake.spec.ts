import type {JobUpdateOutcome} from '../src/hermes/hermes-client';
import {StockUsage} from '../src/stock/usage';
import {NativeManagedJobsClient, type NativeManagedJob, type NativeManagedJobsOutcome} from '../src/notifications/native-jobs';
import type {AssistantRow} from '../src/persistence/assistant-repository';
import {STOCK_LIMITS} from '../src/stock/config';
import {StockWake, type WakeVm} from '../src/stock/wake';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';
import {createWorld, type World} from './support/stock-world';

const TARGET = {ip: '10.0.0.5', apiServerKey: 'k'};
const job = (business: string, over: Partial<NativeManagedJob> = {}): NativeManagedJob => ({
  id: 'aaaaaaaaaaaa', name: `saleads:stock-tick:${business}`, prompt: 'p', skills: [], enabled: true, schedule: '30 */3 * * *',
  deliver: 'saleads_home:current', paused_reason: null, origin: {platform: 'api_server', chatId: 'api'}, ...over,
});

describe('despertar a Ale', () => {
  let db: TestDatabase;
  let world: World;
  let now: Date;
  let jobs: NativeManagedJob[];
  let listed: NativeManagedJobsOutcome | null;
  let outcome: JobUpdateOutcome;
  let run: jest.Mock;
  let row: Partial<AssistantRow> | null;

  beforeAll(async () => {db = await startTestDatabase();});
  afterAll(async () => {await db.close();});
  beforeEach(async () => {
    world = await createWorld(db);
    now = new Date('2027-08-27T10:00:00.000Z');
    jobs = [job(world.businessId)];
    listed = null;
    outcome = {kind: 'updated'};
    run = jest.fn(async () => outcome);
    row = {status: 'ready', instance_name: 'vm', api_server_key_enc: Buffer.from('x')};
  });

  const vm = (): WakeVm => ({
    jobs: {list: async () => listed ?? {kind: 'ok', jobs}, run},
    repository: {findActive: async () => row as AssistantRow | null},
    instances: {getInstance: async () => ({status: 'RUNNING', privateIp: TARGET.ip, fingerprint: 'f', items: []})},
    cipher: {open: () => TARGET.apiServerKey},
  });
  const subject = () => new StockWake({db: world.db, now: () => now, usage: new StockUsage({db: world.db, clock: world.stock.clock, now: () => now, benchEnabled: false}), vm: vm()});
  const used = async () => (await world.db.query<{value: string}>(
    `SELECT value FROM assistant.stock_usage WHERE business_id = $1 AND metric = 'despertares_ale'`, [world.businessId])).rows[0]?.value;

  it('corre el trabajo propio de Stock del negocio, no el loop-tick', async () => {
    jobs.push(job(world.businessId, {id: 'bbbbbbbbbbbb', name: `saleads:loop-tick:${world.businessId}`}));
    expect(await subject().wake(world.userId, world.businessId, 'pedido_aprobado')).toBe('solicitado');
    expect(run).toHaveBeenCalledWith(TARGET, 'aaaaaaaaaaaa', expect.any(Number));
    expect(Number(await used())).toBe(1);
  });

  it.each([
    ['pausado por el dueño', {enabled: false, paused_reason: 'owner'}],
    ['con razón de pausa aunque enabled', {enabled: true, paused_reason: 'x'}],
    ['estado desconocido', {enabled: null}],
  ])('%s: no llama run, porque trigger_job borraría la pausa', async (_name, over) => {
    jobs = [job(world.businessId, over)];
    expect(await subject().wake(world.userId, world.businessId, 'banco')).toBe('sin_job');
    expect(run).not.toHaveBeenCalled();
  });

  it('sin trabajo responde sin_job, y el trabajo de otro negocio no cuenta', async () => {
    jobs = [job('otro')];
    expect(await subject().wake(world.userId, world.businessId, 'banco')).toBe('sin_job');
    expect(run).not.toHaveBeenCalled();
  });

  it('diez solicitudes en 120 s corren una vez, juntas o seguidas, y pasado el plazo vuelve a correr', async () => {
    const wake = subject();
    const together = await Promise.all(Array.from({length: 10}, () => wake.wake(world.userId, world.businessId, 'respuesta_proveedor')));
    expect(together.filter(result => result === 'solicitado')).toHaveLength(1);
    expect(together.filter(result => result === 'antirrebote')).toHaveLength(9);
    now = new Date(now.getTime() + 119_000);
    expect(await wake.wake(world.userId, world.businessId, 'banco')).toBe('antirrebote');
    expect(run).toHaveBeenCalledTimes(1);
    expect(Number(await used())).toBe(1);
    now = new Date(now.getTime() + 2_000);
    expect(await wake.wake(world.userId, world.businessId, 'banco')).toBe('solicitado');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('el antirrebote es por negocio', async () => {
    const other = await createWorld(db);
    jobs.push(job(other.businessId, {id: 'cccccccccccc'}));
    const wake = subject();
    await wake.wake(world.userId, world.businessId, 'banco');
    expect(await wake.wake(world.userId, other.businessId, 'banco')).toBe('solicitado');
  });

  it('excedido el tope responde tope sin llamar a la VM, y el antirrebote no gasta tope', async () => {
    await world.db.query(`INSERT INTO assistant.stock_usage(business_id, day, metric, value) VALUES ($1, $2, 'despertares_ale', $3)`,
      [world.businessId, '2027-08-27', STOCK_LIMITS.wakesPerDay - 1]);
    const list = jest.fn(async () => ({kind: 'ok', jobs}) as NativeManagedJobsOutcome);
    const wake = new StockWake({db: world.db, now: () => now, usage: new StockUsage({db: world.db, clock: world.stock.clock, now: () => now, benchEnabled: false}), vm: {...vm(), jobs: {list, run}}});
    expect(await wake.wake(world.userId, world.businessId, 'banco')).toBe('solicitado');
    list.mockClear();
    now = new Date(now.getTime() + 300_000);
    expect(await wake.wake(world.userId, world.businessId, 'banco')).toBe('tope');
    expect(list).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
    now = new Date('2027-08-28T05:10:00.000Z'); // Medianoche y diez en Bogotá: el día es el del negocio.
    expect(await wake.wake(world.userId, world.businessId, 'banco')).toBe('solicitado');
  });

  it('VM caída no lanza: lo que el dueño aprobó sigue bien', async () => {
    listed = {kind: 'unreachable', reason: 'network'};
    await expect(subject().wake(world.userId, world.businessId, 'pedido_aprobado')).resolves.toBe('no_disponible');
    listed = null;
    outcome = {kind: 'unreachable', reason: 'network'};
    await expect(subject().wake(world.userId, world.businessId, 'pedido_aprobado')).resolves.toBe('no_disponible');
    const broken = {...vm(), repository: {findActive: async () => {throw new Error('db');}}};
    await expect(new StockWake({db: world.db, now: () => now, usage: new StockUsage({db: world.db, clock: world.stock.clock, now: () => now, benchEnabled: false}), vm: broken}).wake(world.userId, world.businessId, 'banco')).resolves.toBe('no_disponible');
    await expect(new StockWake({db: world.db, now: () => now, usage: new StockUsage({db: world.db, clock: world.stock.clock, now: () => now, benchEnabled: false})}).wake(world.userId, world.businessId, 'banco')).resolves.toBe('no_disponible');
  });

  it('un intento fallido no bloquea el siguiente con antirrebote', async () => {
    listed = {kind: 'unreachable', reason: 'network'};
    const wake = subject();
    await wake.wake(world.userId, world.businessId, 'banco');
    listed = null;
    expect(await wake.wake(world.userId, world.businessId, 'banco')).toBe('solicitado');
  });

  it('VM sin lista responde vm_no_lista', async () => {
    row = {status: 'stopped'};
    expect(await subject().wake(world.userId, world.businessId, 'banco')).toBe('vm_no_lista');
  });
});

describe('NativeManagedJobsClient.run', () => {
  const client = (status = 200) => {
    const fetcher = jest.fn(async () => new Response('{}', {status}));
    return {fetcher, jobs: new NativeManagedJobsClient(fetcher as never, 8642)};
  };

  it('hace POST a la lista cerrada y conserva pause y resume', async () => {
    const {fetcher, jobs} = client();
    expect(await jobs.run(TARGET, 'abcdef012345', 100)).toEqual({kind: 'updated'});
    await jobs.pause(TARGET, 'abcdef012345', 100);
    await jobs.resume(TARGET, 'abcdef012345', 100);
    expect((fetcher.mock.calls as unknown as Array<[string, {method: string}]>).map(([url, init]) => [url, init.method])).toEqual([
      ['http://10.0.0.5:8642/api/jobs/abcdef012345/run', 'POST'], ['http://10.0.0.5:8642/api/jobs/abcdef012345/pause', 'POST'],
      ['http://10.0.0.5:8642/api/jobs/abcdef012345/resume', 'POST'],
    ]);
  });

  it('updateText hace PATCH solo con prompt y skills (IVB-023)', async () => {
    const {fetcher, jobs} = client();
    expect(await jobs.updateText(TARGET, 'abcdef012345', {prompt: 'nuevo', skills: ['saleads-stock-orchestration']}, 100)).toEqual({kind: 'updated'});
    const [url, init] = (fetcher.mock.calls as unknown as Array<[string, {method: string; body: string}]>)[0]!;
    expect([url, init.method, JSON.parse(init.body)]).toEqual(['http://10.0.0.5:8642/api/jobs/abcdef012345', 'PATCH', {prompt: 'nuevo', skills: ['saleads-stock-orchestration']}]);
    expect(await jobs.updateText(TARGET, 'abcdef012345', {}, 100)).toEqual({kind: 'rejected', status: 0});
    expect(await jobs.updateText(TARGET, '../x', {prompt: 'x'}, 100)).toEqual({kind: 'rejected', status: 0});
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await client(404).jobs.updateText(TARGET, 'abcdef012345', {prompt: 'x'}, 100)).toEqual({kind: 'not_found'});
  });

  it.each(['../x', 'ABCDEF012345', 'abcdef01234', 'abcdef0123456'])('rechaza el id %s sin llamar', async id => {
    const {fetcher, jobs} = client();
    expect(await jobs.run(TARGET, id, 100)).toEqual({kind: 'rejected', status: 0});
    expect(fetcher).not.toHaveBeenCalled();
  });
});
