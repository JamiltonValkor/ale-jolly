import {OrqaSweep, type OrqaSweepOptions} from '../src/orqa/orqa-sweep';
import type {OrqaSyncResult} from '../src/orqa/orqa-sync';
import {AssistantRepository, type AssistantEvent} from '../src/persistence/assistant-repository';
import {INSTANCE} from './support/hermes-fakes';
import {setup, USER} from './support/orqa-fakes';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';

const OPTIONS: OrqaSweepOptions = {enabled: true, delayMs: 120_000, intervalMs: 6 * 3_600_000, pauseMs: 20_000, includeLab: false};
const vm = (n: number) => `sa-assistant-${String(n).repeat(32).slice(0, 32)}`;
const ready = (userId: string, instance: string) => ({user_id: userId, instance_name: instance, ready_since: new Date('2027-10-20T00:00:00Z')});

/** OrqaSync falso: registra cada llamada (y el orden contra las pausas) y responde lo que se le pida por usuario. */
function fakes(rows: Array<ReturnType<typeof ready>>, results: Record<string, OrqaSyncResult | Error> = {}) {
  const log: string[] = [];
  const events: AssistantEvent[] = [];
  let active = 0;
  let overlapped = false;
  const orqa = {
    enabled: true,
    onReady: async (userId: string, instanceName: string | null): Promise<OrqaSyncResult> => {
      if (++active > 1) overlapped = true;
      log.push(`sync ${userId} ${instanceName}`);
      await Promise.resolve();
      active--;
      const result = results[userId] ?? 'synced';
      if (result instanceof Error) throw result;
      return result;
    },
  };
  const repository = {listReady: async () => rows, appendEvent: async (event: AssistantEvent) => {events.push(event);}};
  const sleep = async (ms: number) => {log.push(`pause ${ms}`);};
  return {log, events, orqa, repository, sleep, overlapped: () => overlapped};
}

describe('barrido de sincronización ORQA (MCB-020, D21/D25)', () => {
  afterEach(() => jest.useRealTimers());

  it('flag apagada: start() no programa nada y nunca llama a onReady fuera de GET /me y resync', async () => {
    jest.useFakeTimers();
    const f = fakes([ready('u1', vm(1))]);
    const sweep = new OrqaSweep({...OPTIONS, enabled: false}, {orqa: f.orqa, repository: f.repository, sleep: f.sleep});
    sweep.start();
    await jest.advanceTimersByTimeAsync(7 * 3_600_000);
    expect(f.log).toEqual([]);
    expect(f.events).toEqual([]);
    await sweep.stop();
  });

  it('1 · la versión nueva llega aunque el dueño no abra la web: 3 asistentes listos → 3 sincronizaciones en serie con pausa', async () => {
    const f = fakes([ready('u1', vm(1)), ready('u2', vm(2)), ready('u3', vm(3))]);
    const summary = await new OrqaSweep(OPTIONS, {orqa: f.orqa, repository: f.repository, sleep: f.sleep}).sweep();
    expect(f.log).toEqual([`sync u1 ${vm(1)}`, 'pause 20000', `sync u2 ${vm(2)}`, 'pause 20000', `sync u3 ${vm(3)}`]);
    expect(f.overlapped()).toBe(false);
    expect(summary).toEqual({count: 3, synced: 3, skipped: 0, failed: 0});
    expect(f.events.map(event => [event.kind, event.detail])).toEqual([
      ['orqa.sweep_started', 'count=3'], ['orqa.sweep_done', 'synced=3 skipped=0 failed=0'],
    ]);
  });

  it('arranca a los delayMs y repite cada intervalMs, sin dos barridos a la vez', async () => {
    jest.useFakeTimers();
    const f = fakes([ready('u1', vm(1))]);
    const sweep = new OrqaSweep(OPTIONS, {orqa: f.orqa, repository: f.repository, sleep: f.sleep});
    sweep.start();
    await jest.advanceTimersByTimeAsync(119_000);
    expect(f.log).toEqual([]);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(f.log).toEqual([`sync u1 ${vm(1)}`]);
    await jest.advanceTimersByTimeAsync(6 * 3_600_000);
    expect(f.log).toHaveLength(2);
    await sweep.stop();
    await jest.advanceTimersByTimeAsync(12 * 3_600_000);
    expect(f.log).toHaveLength(2);
  });

  it('2 · no se toca el laboratorio: una sa-assistant-sim-* lista no se sincroniza sin ORQA_SYNC_SWEEP_INCLUDE_LAB', async () => {
    const rows = [ready('lab', 'sa-assistant-sim-sol-hernan'), ready('u1', vm(1))];
    const off = fakes(rows);
    await new OrqaSweep(OPTIONS, {orqa: off.orqa, repository: off.repository, sleep: off.sleep}).sweep();
    expect(off.log).toEqual([`sync u1 ${vm(1)}`]);
    const on = fakes(rows);
    await new OrqaSweep({...OPTIONS, includeLab: true}, {orqa: on.orqa, repository: on.repository, sleep: on.sleep}).sweep();
    expect(on.log).toContain('sync lab sa-assistant-sim-sol-hernan');
  });

  it('3 · un fallo no rompe el resto: failed=1 y las demás VMs se sincronizan', async () => {
    const f = fakes([ready('u1', vm(1)), ready('u2', vm(2)), ready('u3', vm(3))], {u2: 'failed', u3: new Error('boom')});
    const summary = await new OrqaSweep(OPTIONS, {orqa: f.orqa, repository: f.repository, sleep: f.sleep}).sweep();
    expect(f.log.filter(line => line.startsWith('sync'))).toHaveLength(3);
    expect(summary).toEqual({count: 3, synced: 1, skipped: 0, failed: 2});
    expect(f.events.at(-1)).toMatchObject({kind: 'orqa.sweep_done', detail: 'synced=1 skipped=0 failed=2'});
  });

  it('4 · sin trabajo repetido: el segundo barrido con el mismo bundle no escribe metadata ni manda PATCH', async () => {
    const ctx = setup({updateJobs: true});
    const orqa = ctx.make();
    const repository = {listReady: async () => [{user_id: USER, instance_name: INSTANCE, ready_since: ctx.row.ready_since}], appendEvent: async () => undefined};
    const sweep = new OrqaSweep(OPTIONS, {orqa, repository, sleep: async () => undefined});
    expect(await sweep.sweep()).toMatchObject({synced: 1});
    const sets = ctx.instances.sets.length;
    const lists = ctx.hermes.listCalls;
    expect(await sweep.sweep()).toEqual({count: 1, synced: 0, skipped: 1, failed: 0});
    expect(ctx.instances.sets).toHaveLength(sets);
    expect(ctx.hermes.listCalls).toBe(lists);
    expect(ctx.hermes.updates).toHaveLength(0);
  });

  it('5 · no se cruza con el dueño: con un PUT /ai del mismo usuario en curso, el barrido espera el candado', async () => {
    const ctx = setup();
    const orqa = ctx.make();
    let release!: () => void;
    const putAi = ctx.locks.run(USER, () => new Promise<void>(resolve => {release = resolve;}));
    const repository = {listReady: async () => [{user_id: USER, instance_name: INSTANCE, ready_since: null}], appendEvent: async () => undefined};
    const sweeping = new OrqaSweep(OPTIONS, {orqa, repository, sleep: async () => undefined}).sweep();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(ctx.instances.getCalls).toBe(0);
    expect(ctx.hermes.listCalls).toBe(0);
    release();
    await putAi;
    expect(await sweeping).toMatchObject({synced: 1});
    expect(ctx.hermes.listCalls).toBe(1);
  });

  it('los eventos del barrido no llevan prompts, ids de chat ni IPs', async () => {
    const f = fakes([ready('u1', vm(1))]);
    await new OrqaSweep(OPTIONS, {orqa: f.orqa, repository: f.repository, sleep: f.sleep}).sweep();
    for (const event of f.events) expect(event.detail).toMatch(/^(count=\d+|synced=\d+ skipped=\d+ failed=\d+)$/);
  });
});

describe('listReady (MCB-020) en Postgres', () => {
  let db: TestDatabase;
  beforeAll(async () => {db = await startTestDatabase();});
  afterAll(async () => {await db.close();});

  it('solo los asistentes ready, vivos y con VM', async () => {
    const insert = (userId: string, status: string, instance: string | null, deleted = false) => db.database.pool.query(
      `INSERT INTO assistant.assistants (user_id, status, step, instance_name, zone, activation_started_at, ready_since, deleted_at)
       VALUES ($1, $2, NULL, $3, 'us-central1-a', now(), $4, $5)`,
      [userId, status, instance, status === 'ready' ? new Date('2027-10-20T00:00:00Z') : null, deleted ? new Date() : null]);
    await insert('a-ready', 'ready', vm(1));
    await insert('b-stopped', 'stopped', vm(2));
    await insert('c-deleted', 'ready', vm(3), true);
    await insert('d-activating', 'activating', vm(4));
    expect(await new AssistantRepository(db.database).listReady())
      .toEqual([{user_id: 'a-ready', instance_name: vm(1), ready_since: new Date('2027-10-20T00:00:00Z')}]);
  });
});
