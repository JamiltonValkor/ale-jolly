import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {STOCK_TOOLS} from '../src/contracts/stock-v1';
import {BenchSupplierChannel} from '../src/stock/supplier-channel';
import {buildStock, stockSettings} from '../src/stock/module';
import {STOCK_TOKENS, STOCK_TOPES, STOCK_TOPES_POR_UNIDAD} from '../src/stock/usage';
import {StockMaintenance} from '../src/stock/maintenance';
import {FakeHermesServer} from './support/hermes-sse-server';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';
import {approve, count, createWorld, key, propose, seedDocument, seedVariant, type World} from './support/stock-world';

const usageRow = async (world: World, metric: string, day?: string) => {
  const {rows} = await world.db.query<{value: number; day: string}>(
    `SELECT value::int AS value, day::text AS day FROM assistant.stock_usage WHERE business_id = $1 AND metric = $2 ${day ? 'AND day = $3' : ''}`, day ? [world.businessId, metric, day] : [world.businessId, metric]);
  return rows;
};
const startRun = async (world: World, runId = randomUUID()) => {
  await world.db.query(`INSERT INTO assistant.stock_runs(id,business_id,name,seed,status) VALUES ($1,$2,'n',1,'activo')`, [runId, world.businessId]);
  return runId;
};
const jump = (world: World, runId: string, seconds: number) => world.db.query(
  `INSERT INTO assistant.stock_clock_offsets(business_id,offset_seconds,updated_by) VALUES ($1,$2,'banco') ON CONFLICT (business_id) DO UPDATE SET offset_seconds = $2`, [world.businessId, seconds]);
const budget = (runId: string, metric: string, limit: number, world: World) => world.db.query('INSERT INTO assistant.stock_run_budgets(run_id,metric,limit_value) VALUES ($1,$2,$3)', [runId, metric, limit]);

describe('topes de gasto', () => {
  let db: TestDatabase;
  beforeAll(async () => {db = await startTestDatabase();});
  afterAll(async () => {await db.close();});

  describe('reloj', () => {
    it('sin run_id cuenta por día de la zona del negocio: las 23:00 en Bogotá ya son mañana en UTC', async () => {
      const world = await createWorld(db);
      world.now.value = new Date('2026-11-03T04:00:00.000Z');
      await world.stock.usage.spend(world.db, world.businessId, 'despertares_ale');
      world.now.value = new Date('2026-11-02T20:00:00.000Z');
      await world.stock.usage.spend(world.db, world.businessId, 'despertares_ale');
      expect(await usageRow(world, 'despertares_ale')).toEqual([{value: 2, day: '2026-11-02'}]);
    });

    it('con el día nuevo vuelve a haber cupo', async () => {
      const world = await createWorld(db);
      for (let index = 0; index < STOCK_TOPES.sam_llamadas; index++) await world.stock.usage.spend(world.db, world.businessId, 'sam_llamadas');
      expect(await world.stock.usage.spend(world.db, world.businessId, 'sam_llamadas')).toBe(false);
      world.now.value = new Date(world.now.value.getTime() + 86_400_000);
      expect(await world.stock.usage.spend(world.db, world.businessId, 'sam_llamadas')).toBe(true);
    });

    it('un salto de reloj no reinicia el tope diario ni el presupuesto de corrida', async () => {
      const real = await createWorld(db);
      const realRun = await startRun(real);
      for (let index = 0; index < STOCK_TOPES.despertares_ale; index++) await real.stock.usage.spend(real.db, real.businessId, 'despertares_ale');
      await jump(real, realRun, 30 * 86_400);
      expect(await real.stock.usage.spend(real.db, real.businessId, 'despertares_ale')).toBe(false); // Sin banco el run no cuenta.

      const bench = await createWorld(db, {bench: true});
      const run = await startRun(bench);
      await budget(run, 'tarjetas_stock', 2, bench);
      expect(await bench.stock.usage.spend(bench.db, bench.businessId, 'tarjetas_stock')).toBe(true);
      expect(await bench.stock.usage.spend(bench.db, bench.businessId, 'tarjetas_stock')).toBe(true);
      await jump(bench, run, 30 * 86_400);
      bench.now.value = new Date(bench.now.value.getTime() + 30 * 86_400_000);
      expect(await bench.stock.usage.spend(bench.db, bench.businessId, 'tarjetas_stock')).toBe(false);
    });

    it('sin banco una corrida activa no abre presupuesto: manda el contador real', async () => {
      const world = await createWorld(db);
      const run = await startRun(world);
      await world.stock.usage.spend(world.db, world.businessId, 'despertares_ale');
      expect((await usageRow(world, 'despertares_ale'))[0]!.value).toBe(1);
      expect(await world.stock.usage.runBudgets(world.db, run)).toEqual([]);
    });

    it('una semana comprimida no toca el contador real, y la semilla manda', async () => {
      const world = await createWorld(db, {bench: true});
      const run = await startRun(world);
      await budget(run, 'tarjetas_stock', 56, world);
      for (let index = 0; index < 56; index++) expect(await world.stock.usage.spend(world.db, world.businessId, 'tarjetas_stock')).toBe(true);
      expect(await world.stock.usage.spend(world.db, world.businessId, 'tarjetas_stock')).toBe(false);
      expect(await usageRow(world, 'tarjetas_stock')).toEqual([]);
    });

    it('una corrida sin esa métrica en la semilla sigue teniendo tope finito', async () => {
      const world = await createWorld(db, {bench: true});
      await startRun(world);
      for (let index = 0; index < STOCK_TOPES.despertares_ale; index++) await world.stock.usage.spend(world.db, world.businessId, 'despertares_ale');
      await jump(world, (await world.db.query<{id: string}>('SELECT id FROM assistant.stock_runs WHERE business_id = $1', [world.businessId])).rows[0]!.id, 86_400);
      expect(await world.stock.usage.spend(world.db, world.businessId, 'despertares_ale')).toBe(false);
    });
  });

  describe('cada tope da su estado', () => {
    const online = (world: World) => world.db.query(
      `INSERT INTO assistant.stock_device_presence(device_id,user_id,device_state,events_seen_at) VALUES ($1,$2,'activo',$3)`, [randomUUID(), world.userId, world.now.value]);
    const store = {signPut: async () => 'https://x', signGet: async () => 'https://x'};
    const photo = (world: World, etiqueta = 'frasco') => world.stock.photos.take(world.userId, world.businessId, {idempotency_key: key(), concepto: 'jar', etiqueta} as never);

    it('sam_llamadas: `tope_diario`, sin foto ni orden al robot', async () => {
      const world = await createWorld(db, {deps: {photoStore: store, toolWaitMs: 0}});
      await online(world);
      await world.db.query(`INSERT INTO assistant.stock_usage(business_id,day,metric,value) VALUES ($1,'2026-11-01','sam_llamadas',59)`, [world.businessId]);
      expect((await photo(world)).status).toBe('pending');
      expect((await photo(world, 'otra')).status).toBe('tope_diario');
      const {rows: photos} = await world.db.query('SELECT 1 FROM assistant.stock_photos WHERE business_id = $1', [world.businessId]);
      const {rows: events} = await world.db.query(`SELECT 1 FROM assistant.stock_robot_events WHERE business_id = $1 AND kind = 'foto'`, [world.businessId]);
      expect([photos.length, events.length]).toEqual([1, 1]);
    });

    it('una repetición idempotente no gasta SAM', async () => {
      const world = await createWorld(db, {deps: {photoStore: store, toolWaitMs: 0}});
      await online(world);
      const input = {idempotency_key: key(), concepto: 'jar', etiqueta: 'frasco'} as never;
      await world.stock.photos.take(world.userId, world.businessId, input);
      await world.stock.photos.take(world.userId, world.businessId, input);
      expect((await usageRow(world, 'sam_llamadas'))[0]!.value).toBe(1);
    });

    it('fotos_por_conteo: la cuarta de lo mismo no sale, aunque no diga `photo_id`', async () => {
      const world = await createWorld(db, {deps: {photoStore: store, toolWaitMs: 0}});
      await online(world);
      expect(STOCK_TOPES_POR_UNIDAD.fotos_por_conteo).toBe(3);
      for (let index = 0; index < 3; index++) expect((await photo(world)).status).toBe('pending');
      expect(await photo(world)).toEqual({status: 'fallida', motivo: 'tope_fotos_conteo'});
      expect((await usageRow(world, 'sam_llamadas'))[0]!.value).toBe(3);
      expect((await photo(world, 'otro')).status).toBe('pending');
    });

    it('extraccion: `tope_diario`, y el documento vuelve a quedar registrado', async () => {
      const extract = jest.fn();
      const world = await createWorld(db, {deps: {documentStore: {exists: async () => true} as never, invoiceModel: {id: 'modelo', extract} as never}});
      await world.db.query(`INSERT INTO assistant.stock_usage(business_id,day,metric,value) VALUES ($1,'2026-11-01','extraccion',$2)`, [world.businessId, STOCK_TOPES.extraccion]);
      const {documentId} = await seedDocument(world, []);
      await world.db.query(`UPDATE assistant.stock_documents SET status = 'registrado', object = 'o', extraction = NULL WHERE id = $1`, [documentId]);
      expect(await world.stock.documents.extract(world.userId, world.businessId, documentId)).toEqual({status: 'tope_diario'});
      const {rows} = await world.db.query<{status: string}>('SELECT status FROM assistant.stock_documents WHERE id = $1', [documentId]);
      expect(rows[0]!.status).toBe('registrado');
      expect(extract).not.toHaveBeenCalled();
    });

    it('tarjetas_stock: al exceder no hay clave, y mañana vuelve', async () => {
      const world = await createWorld(db);
      for (let index = 0; index < STOCK_TOPES.tarjetas_stock; index++) {
        expect(await world.stock.usage.reserveCard(world.businessId, 'negociar', randomUUID())).toMatchObject({permitida: true, nueva: true});
      }
      expect(await world.stock.usage.reserveCard(world.businessId, 'negociar', randomUUID())).toEqual({permitida: false, motivo: 'tope_diario'});
      world.now.value = new Date(world.now.value.getTime() + 86_400_000);
      expect(await world.stock.usage.reserveCard(world.businessId, 'tick')).toMatchObject({permitida: true});
    });

    it('avisos_voz: el cuarto del día queda `tope_diario` con el mismo contador', async () => {
      const world = await createWorld(db);
      await world.db.query(`INSERT INTO assistant.stock_usage(business_id,day,metric,value) VALUES ($1,'2026-11-01','avisos_voz',$2)`, [world.businessId, STOCK_TOPES.avisos_voz]);
      await world.db.query(`INSERT INTO assistant.stock_device_presence(device_id,user_id,device_state,events_seen_at) VALUES ($1,$2,'activo',$3)`, [randomUUID(), world.userId, world.now.value]);
      const said = await world.stock.notices.say(world.userId, world.businessId, {texto: 'Se acaba el shampoo', pregunta: false, prioridad: 'normal', producto_id: null, proposal_id: null} as never);
      expect(said.status).toBe('tope_diario');
    });
  });

  describe('coexistencia con 2 workers, con FakeHermesServer', () => {
    /** Tablero con la semántica de Hermes verificada con `kanban_db` real (evidencia/operacion/kanban-real.txt). */
    class Board {
      readonly cards = new Map<string, 'ready' | 'running' | 'blocked'>();
      create(idempotencyKey: string) {if (!this.cards.has(idempotencyKey)) this.cards.set(idempotencyKey, 'ready');}
      running() {return [...this.cards.values()].filter(state => state === 'running').length;}
      dispatch(max = 2) {for (const [card, state] of this.cards) if (state === 'ready' && this.running() < max) this.cards.set(card, 'running');}
      block(card: string) {this.cards.set(card, 'blocked');}
    }
    const hermes = new FakeHermesServer('llave');
    beforeAll(() => hermes.start());
    afterAll(() => hermes.stop());

    /** Lo que hace Ale en el tick: pide la tarjeta al servidor y crea solo con clave. */
    const tick = async (world: World, board: Board, tipo: 'tick' | 'negociar' = 'tick', orderId?: string) => {
      const {tarjeta} = {tarjeta: await world.stock.usage.reserveCard(world.businessId, tipo, orderId)};
      if (tarjeta.permitida) board.create(tarjeta.clave);
      return tarjeta;
    };

    it('doble tick en la misma ventana: una tarjeta y un solo cupo', async () => {
      const world = await createWorld(db);
      const board = new Board();
      const [first, second] = [await tick(world, board), await tick(world, board)];
      expect(first).toMatchObject({permitida: true, nueva: true});
      expect(second).toMatchObject({permitida: true, nueva: false, clave: (first as {clave: string}).clave, id: (first as {id: string}).id});
      expect(board.cards.size).toBe(1);
      expect((await usageRow(world, 'tarjetas_stock'))[0]!.value).toBe(1);
      world.now.value = new Date(world.now.value.getTime() + 3 * 3_600_000);
      await tick(world, board);
      expect(board.cards.size).toBe(2);
    });

    it('la ventana usa la zona del negocio y el reloj simulado de la corrida', async () => {
      const world = await createWorld(db, {bench: true});
      const run = await startRun(world);
      const before = await world.stock.usage.reserveCard(world.businessId, 'tick');
      await jump(world, run, 3 * 3600);
      const after = await world.stock.usage.reserveCard(world.businessId, 'tick');
      expect(before).toMatchObject({clave: `stock:${world.businessId}:tick:2026110103-1:corrida-${run.slice(0, 8)}`});
      expect(after).toMatchObject({clave: `stock:${world.businessId}:tick:2026110106-2:corrida-${run.slice(0, 8)}`});
    });

    it('dos corridas que simulan la misma ventana no comparten la clave de Hermes', async () => {
      const world = await createWorld(db, {bench: true});
      const first = await startRun(world);
      const a = await world.stock.usage.reserveCard(world.businessId, 'tick');
      await world.db.query(`UPDATE assistant.stock_runs SET status = 'cerrado' WHERE id = $1`, [first]);
      await startRun(world);
      const b = await world.stock.usage.reserveCard(world.businessId, 'tick');
      expect(a).toMatchObject({permitida: true, nueva: true});
      expect(b).toMatchObject({permitida: true, nueva: true});
      expect((a as {clave: string}).clave).not.toBe((b as {clave: string}).clave);
      const sinCorrida = await createWorld(db);
      expect(await sinCorrida.stock.usage.reserveCard(sinCorrida.businessId, 'tick')).toMatchObject({clave: expect.stringMatching(/^stock:[0-9a-f-]+:tick:\d{10}-\d$/)});
    });

    it('tarjeta bloqueada libera su worker: entra la landing y la tarjeta sigue en el tablero', async () => {
      const world = await createWorld(db);
      const board = new Board();
      await tick(world, board);
      board.create('landing');
      board.create('curador');
      board.dispatch();
      expect(board.cards.get('curador')).toBe('ready');
      const stockCard = [...board.cards.keys()].find(card => card.startsWith('stock:'))!;
      board.block(stockCard); // El `kanban_block` que pide `stock-negociacion` tras esperar al proveedor.
      board.dispatch();
      expect(board.cards.get('curador')).toBe('running');
      expect(board.cards.get(stockCard)).toBe('blocked');
      expect(readFileSync('distribution/stock-addon/1.0.8/profiles/stock/skills/stock-negociacion/SKILL.md', 'utf8')).toContain('usa `kanban_block`');
    });

    it('la capacidad no se sube: siguen 2 workers, y la regla de una tarjeta llega al SOUL, a la skill y al trabajo', () => {
      expect(readFileSync('src/activation/hermes-files.ts', 'utf8')).toContain(`'  max_in_progress: 2'`);
      const prompt = (JSON.parse(readFileSync('distribution/stock-addon/1.0.8/jobs.json', 'utf8')) as {jobs: Array<{prompt: string}>}).jobs[0]!.prompt;
      expect(readFileSync('distribution/stock-addon/1.0.8/SOUL.addendum.md', 'utf8')).toContain('Máximo 1 tarjeta Stock en curso por negocio');
      expect(readFileSync('distribution/stock-addon/1.0.8/skills/saleads-stock-orchestration/SKILL.md', 'utf8')).not.toContain('salvo las de negociación');
      expect(prompt).toContain('tarjeta=tick');
      expect(prompt).not.toMatch(/AAAAMMDDHH/);
    });
  });

  describe('cancelar pedido', () => {
    const open = async (options: {bench?: boolean} = {}) => {
      await db.database.pool.query(`UPDATE assistant.stock_orders SET status = 'cancelado'`);
      await db.database.pool.query('DELETE FROM assistant.stock_relay_state');
      const channel = new BenchSupplierChannel('+57-destino');
      const world = await createWorld(db, {...options, deps: {supplierChannel: channel, wake: jest.fn(async () => 'solicitado') as never, toolWaitMs: 0}});
      const variantId = await seedVariant(world, 'Shampoo', {unitCost: '18000'});
      const supplierId = randomUUID();
      await world.db.query(`INSERT INTO assistant.stock_suppliers(id,business_id,user_id,name,lead_time_days,occurred_at) VALUES ($1,$2,$3,'Capilar',5,now())`, [supplierId, world.businessId, world.userId]);
      await world.db.query(`INSERT INTO assistant.stock_supplier_quotes(id,supplier_id,variant_id,price,freight,min_qty,currency) VALUES ($1,$2,$3,18500,20000,1,'COP')`, [randomUUID(), supplierId, variantId]);
      const proposal = async () => propose(world, 'pedido', {variante_id: variantId, proveedor_id: supplierId, cantidad: 60, mandato: {precio_objetivo: '16000', tope: '18000'}});
      await approve(world, await proposal());
      const {rows} = await world.db.query<{id: string}>('SELECT id FROM assistant.stock_orders WHERE business_id = $1', [world.businessId]);
      return {world, channel, orderId: rows[0]!.id, proposal};
    };
    const state = async (world: World, orderId: string) => (await world.db.query<{status: string; state: string; novedad: string | null}>(
      'SELECT o.status, n.state, o.novedad FROM assistant.stock_orders o JOIN assistant.stock_negotiations n ON n.order_id = o.id WHERE o.id = $1', [orderId])).rows[0]!;

    it('el dueño cancela en `negociando`: libera la cola, y repetir no falla', async () => {
      const {world, orderId, proposal} = await open();
      await world.stock.negotiation.cancel(world.userId, world.businessId, orderId);
      await world.stock.negotiation.cancel(world.userId, world.businessId, orderId);
      expect(await state(world, orderId)).toMatchObject({status: 'cancelado', state: 'sin_acuerdo', novedad: null});
      const {rows} = await world.db.query<{actor: string}>(`SELECT actor FROM assistant.stock_audit WHERE business_id = $1 AND action = 'pedido_cancelado'`, [world.businessId]);
      expect(rows).toEqual([{actor: world.userId}]); // Repetir no audita dos veces.
      await approve(world, await proposal());
      expect(await world.stock.negotiation.send(world.userId, world.businessId, {idempotency_key: key(), order_id: orderId, texto: 'Hola', precio_unitario_ofrecido: null, cantidad: null, cierre: false}))
        .toEqual({status: 'bloqueado', motivo: 'pedido_no_negociando'});
    });

    it('no cancela lo acordado, ni un pedido ajeno', async () => {
      const {world, orderId} = await open();
      const stranger = await createWorld(db);
      await expect(stranger.stock.negotiation.cancel(stranger.userId, stranger.businessId, orderId)).rejects.toMatchObject({code: 'NOT_FOUND'});
      await world.db.query(`UPDATE assistant.stock_orders SET status = 'acordado' WHERE id = $1`, [orderId]);
      await expect(world.stock.negotiation.cancel(world.userId, world.businessId, orderId)).rejects.toMatchObject({code: 'CONFLICT'});
    });
  });

  describe('retención', () => {
    const utter = async (world: World, days: number) => {
      const id = randomUUID();
      await world.db.query(`INSERT INTO assistant.stock_owner_utterances(id,user_id,device_id,text,recorded_at) VALUES ($1,$2,$3,'sí',now() - make_interval(days => $4))`, [id, world.userId, randomUUID(), days]);
      return id;
    };
    const left = async (world: World) => (await world.db.query<{id: string}>('SELECT id FROM assistant.stock_owner_utterances WHERE user_id = $1', [world.userId])).rows.map(row => row.id);

    it('borra frases viejas sin usar, y conserva las citadas por una confirmación', async () => {
      const world = await createWorld(db);
      const [old, recent, cited] = [await utter(world, 8), await utter(world, 6), await utter(world, 40)];
      const variantId = await seedVariant(world);
      const proposal = await count(world, variantId, 1);
      await world.db.query(`INSERT INTO assistant.stock_confirmations(id,proposal_id,business_id,method,actor,utterance_id,decision) VALUES ($1,$2,$3,'voz','u',$4,'aprobada')`, [randomUUID(), proposal.id, world.businessId, cited]);
      expect(await world.stock.maintenance.retain()).toBeGreaterThanOrEqual(1);
      expect((await left(world)).sort()).toEqual([recent, cited].sort());
      expect(await left(world)).not.toContain(old);
    });

    it('la tarea corre al arrancar y luego una vez al día, aunque caduque cada hora', async () => {
      const [sweep, query] = [jest.fn(async () => undefined), jest.fn(async () => ({rows: [], rowCount: 0}))];
      let at = 0;
      const task = new StockMaintenance({db: {query} as never, negotiation: {sweep}, now: () => new Date(at)});
      await task.tick();
      at = 3_600_000;
      await task.tick();
      expect([sweep.mock.calls.length, query.mock.calls.length]).toEqual([2, 1]);
      at = 86_400_000;
      await task.tick();
      expect(query.mock.calls.length).toBe(2);
    });

    it('apagado limpio: `stop` espera la pasada en curso y no deja temporizador', async () => {
      let release = () => undefined as void;
      const sweep = jest.fn(() => new Promise<void>(resolve => {release = () => resolve();}));
      const task = new StockMaintenance({db: {query: async () => ({rows: [], rowCount: 0})} as never, negotiation: {sweep}, now: () => new Date()});
      task.start();
      const pass = task.tick();
      let stopped = false;
      const stopping = task.stop().then(() => {stopped = true;});
      await new Promise(resolve => setImmediate(resolve));
      expect(stopped).toBe(false);
      release();
      await Promise.all([pass, stopping]);
      expect(stopped).toBe(true);
    });

    it('con `STOCK_ENABLED=false` no hay tarea', async () => {
      const settings = stockSettings({STOCK_ENABLED: false, STOCK_USER_IDS: [], STOCK_BUSINESS_SEEDS: [], STOCK_WEB_BASE_URL: '', STOCK_BENCH_ENABLED: false, STOCK_MAX_AUTONOMY_LEVEL: 2});
      expect(await buildStock(settings, {pool: {query: jest.fn()} as never})).toBeUndefined();
    });

    it('la operación escribe el bucket de 30 días, y ninguna URL firmada queda en la base', async () => {
      const doc = readFileSync('docs/stock-operacion.md', 'utf8');
      expect(doc).toContain('saleads-dev-meta-assistant-stock-photos');
      expect(doc).toContain('"age": 30');
      const source = readFileSync('src/stock/photos.ts', 'utf8');
      expect(source).not.toMatch(/SET (?:object_original|object_numerada)\s*=\s*\$\d+[^`]*url/);
    });
  });

  describe('presupuesto y medición de tokens', () => {
    it('el presupuesto diario son 16 turnos al máximo medido sin terminal', () => {
      expect(STOCK_TOKENS.diario).toBeGreaterThanOrEqual(16 * STOCK_TOKENS.turnoEsperado);
      expect(STOCK_TOKENS.diario).toBeLessThan(16 * STOCK_TOKENS.turnoConTerminal);
    });

    it('`tokens_ale` mide sin negar, y agotado frena el siguiente despertar', async () => {
      const list = jest.fn(async () => ({kind: 'ok', jobs: []}));
      const world = await createWorld(db, {deps: {vm: {jobs: {list, run: jest.fn()}, repository: {findActive: async () => ({status: 'ready', instance_name: 'i', api_server_key_enc: 'k'})},
        instances: {getInstance: async () => ({status: 'RUNNING', privateIp: '10.0.0.1'})}, cipher: {open: () => 'k'}} as never}});
      await world.stock.usage.record(world.db, world.businessId, 'tokens_ale', STOCK_TOKENS.turnoConTerminal);
      await world.stock.usage.record(world.db, world.businessId, 'tokens_ale', STOCK_TOPES.tokens_ale);
      expect((await usageRow(world, 'tokens_ale'))[0]!.value).toBe(STOCK_TOKENS.turnoConTerminal + STOCK_TOPES.tokens_ale);
      expect(await world.stock.wake(world.userId, world.businessId, 'banco')).toBe('tope');
      expect(list).not.toHaveBeenCalled();
    });

    it('`stock-consumo.py` lee sesiones de Hermes y clasifica contra el presupuesto, sin escribir', () => {
      const dir = mkdtempSync(join(tmpdir(), 'stock-consumo-'));
      const path = join(dir, 'state.db');
      const now = Date.now() / 1000;
      execFileSync('python3', ['-c', `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]); c.execute('CREATE TABLE sessions(id TEXT, source TEXT, model TEXT, started_at REAL, tool_call_count INT, input_tokens INT, output_tokens INT, cache_read_tokens INT)')
n=float(sys.argv[2])
for row in [('a',44000,n),('b',136000,n),('c',503000,n),('d',600000,n),('vieja',900000,n-90000)]: c.execute("INSERT INTO sessions VALUES(?,'cron','m',?,0,?,0,0)",(row[0],row[2],row[1]))
c.commit()`, path, String(now)]);
      const out = JSON.parse(execFileSync('python3', ['scripts/stock-consumo.py', '--db', path, '--horas', '24'], {encoding: 'utf8'})) as {turnos: number; tokens_entrada: number; por_clase: Record<string, number>; excede_presupuesto: boolean; mayores: Array<{id: string}>};
      expect({turnos: out.turnos, total: out.tokens_entrada, clases: out.por_clase, excede: out.excede_presupuesto, primero: out.mayores[0]!.id})
        .toEqual({turnos: 4, total: 1_283_000, clases: {ok: 2, alto: 1, fuera: 1}, excede: false, primero: 'd'});
    });

    it('el catálogo sigue en 15 herramientas', () => expect(Object.keys(STOCK_TOOLS)).toHaveLength(15));
  });
});
