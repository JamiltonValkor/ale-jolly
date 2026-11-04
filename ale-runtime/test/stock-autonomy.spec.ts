import {randomUUID} from 'node:crypto';
import {STOCK_SAY_TEXT_MAX, STOCK_TOOLS, type StockProposalV1} from '../src/contracts/stock-v1';
import {areaOf, LEVEL_CAPABILITIES} from '../src/stock/autonomy';
import {buildStock, stockSettings} from '../src/stock/module';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';
import {approve, count, createWorld, key, pgliteStockDb, propose, say, seedDocument, seedVariant, stockIn, type World} from './support/stock-world';

const REQUEST = {area: 'reposicion', nivel_pedido: 3, monto_tope: '500000'};

describe('escalera de autonomía', () => {
  let db: TestDatabase;
  let world: World;

  beforeAll(async () => {db = await startTestDatabase();});
  afterAll(async () => {await db.close();});
  beforeEach(async () => {world = await createWorld(db);});

  const rows = async <T>(sql: string, params: unknown[]) => (await world.db.query<T>(sql, params)).rows;
  const proposalCount = async (target = world) => (await target.db.query<{n: number}>(`SELECT count(*)::int AS n FROM assistant.stock_proposals WHERE business_id = $1 AND kind = 'autonomia'`, [target.businessId])).rows[0]!.n;
  const requests = () => rows<{from_level: number; to_level: number; proposal_id: string | null; evidence: Record<string, unknown>}>(
    'SELECT from_level, to_level, proposal_id, evidence FROM assistant.stock_autonomy_requests WHERE business_id = $1 ORDER BY recorded_at', [world.businessId]);
  const stored = async (area: string) => (await rows<{level: number; revision: number}>('SELECT level, revision FROM assistant.stock_autonomy WHERE business_id = $1 AND area = $2', [world.businessId, area]))[0]!;
  const level = (area: string) => world.stock.autonomy.levels(world.businessId, area as 'inventario');
  const lower = (area: string, revision = 1, chosen = key(), nivel = 1, motivo?: string, target = world) =>
    target.stock.autonomy.lower({userId: target.userId}, target.businessId, area as 'inventario', revision, chosen, nivel, motivo);
  const ask = (detalle: unknown = REQUEST, target = world, chosen = key()) => target.stock.proposals.create(target.userId, target.businessId, 'stock', {idempotency_key: chosen, kind: 'autonomia', detalle});
  const asked = async (detalle: unknown = REQUEST, target = world) => {
    const result = await ask(detalle, target);
    if (result.estado !== 'creada' || result.propuesta.tipo !== 'autonomia') throw new Error(`esperaba propuesta: ${result.estado}`);
    return result.propuesta;
  };
  const decide = (proposal: StockProposalV1, target = world) => approve(target, proposal);

  /** Mismo negocio y mismo libro, con otro tope: así se ve un despliegue que sube `STOCK_MAX_AUTONOMY_LEVEL`. */
  const withMax = async (max: number, target = world): Promise<World> => {
    const settings = stockSettings({STOCK_ENABLED: true, STOCK_USER_IDS: [target.userId], STOCK_BUSINESS_SEEDS: [`${target.businessId}:${target.userId}:COP`], STOCK_WEB_BASE_URL: '',
      STOCK_BENCH_ENABLED: false, STOCK_MAX_AUTONOMY_LEVEL: max});
    const stock = (await buildStock(settings, {pool: db.database.pool, db: target.db, offerings: target.offerings, now: () => target.now.value}))!;
    return {...target, stock};
  };

  /** Pedido por el camino real de la recepción. `saving_confirmed` lo escribirá IVB-015: aquí se siembra. */
  const receiveOrder = async (target = world, options: {quantity?: number; entered?: number; contado?: number; saving?: string | null; runId?: string | null} = {}) => {
    const {quantity = 10, entered = quantity, contado = quantity, saving = '58000.00', runId = null} = options;
    const variantId = await seedVariant(target, undefined, {runId});
    const [supplierId, proposalId, orderId] = [randomUUID(), randomUUID(), randomUUID()];
    await target.db.query(`INSERT INTO assistant.stock_suppliers(id,business_id,user_id,name,occurred_at,simulated,run_id) VALUES ($1,$2,$3,'Proveedor',now(),$4,$5)`, [supplierId, target.businessId, target.userId, Boolean(runId), runId]);
    await target.db.query(
      `INSERT INTO assistant.stock_proposals(id,business_id,user_id,kind,title,reason,payload,status,effects_yes,effects_no,expires_at,idempotency_key,request_hash,trace_id,created_by,occurred_at,simulated,run_id)
       VALUES ($1,$2,$3,'pedido','t','r','{}','aprobada','["a"]','["b"]',now()+interval '1 day',$4,$5,$6,'stock',now(),$7,$8)`, [proposalId, target.businessId, target.userId, key(), 'a'.repeat(64), randomUUID(), Boolean(runId), runId]);
    await target.db.query(
      `INSERT INTO assistant.stock_orders(id,business_id,user_id,variant_id,supplier_id,quantity,status,currency,proposal_id,occurred_at,simulated,run_id) VALUES ($1,$2,$3,$4,$5,$6,'acordado','COP',$7,now(),$8,$9)`,
      [orderId, target.businessId, target.userId, variantId, supplierId, quantity, proposalId, Boolean(runId), runId]);
    const {documentId, lineas} = await seedDocument(target, [{variantId, quantity: entered, unitCost: '17000'}], 'Proveedor', runId);
    const proposal = await propose(target, 'conteo', {variante_id: variantId, contado, origen: 'voz', order_id: orderId});
    await approve(target, proposal, contado === quantity ? undefined : 'otra');
    await approve(target, await propose(target, 'entrada', {document_id: documentId, order_id: orderId, lineas}));
    await target.db.query('UPDATE assistant.stock_orders SET saving_confirmed = $2 WHERE id = $1', [orderId, saving]);
    return orderId;
  };

  describe('R33: niveles por área', () => {
    it('un negocio habilitado sin filas igual lee las 4 áreas en 2', async () => {
      await world.db.query('DELETE FROM assistant.stock_autonomy WHERE business_id = $1', [world.businessId]);
      const {areas} = await world.stock.autonomy.read(world.businessId);
      expect(areas).toEqual(['inventario', 'reposicion', 'negociacion', 'ofertas'].map(area => ({area, nivel: 2, nivel_efectivo: 2, revision: 1})));
      expect(await rows('SELECT 1 FROM assistant.stock_autonomy WHERE business_id = $1', [world.businessId])).toEqual([]);
    });

    it('el nivel se guarda por área: bajar una no mueve las otras', async () => {
      await lower('inventario');
      expect(await stored('inventario')).toEqual({level: 1, revision: 2});
      expect(await stored('reposicion')).toEqual({level: 2, revision: 1});
      expect((await world.stock.autonomy.read(world.businessId)).areas.map(area => area.nivel)).toEqual([1, 2, 2, 2]);
    });

    it('en nivel 1 propose de esa área responde bloqueado y no crea propuesta; en otra área sí crea', async () => {
      const variantId = await seedVariant(world);
      await stockIn(world, variantId, 5);
      const bet = {variante_id: variantId, presupuesto_diario: '10', tope: '100', duracion_dias: 7, unidades_semana_previstas: null, fuente_prevision: 'supuesto'};
      expect((await propose(world, 'venta', {variante_id: variantId, cantidad: 1})).tipo).toBe('venta');
      await lower('inventario');
      const before = (await rows('SELECT 1 FROM assistant.stock_proposals WHERE business_id = $1', [world.businessId])).length;
      for (const [kind, detalle] of [['conteo', {variante_id: variantId, contado: 1, origen: 'voz'}], ['venta', {variante_id: variantId, cantidad: 1}]] as const) {
        const result = await world.stock.proposals.create(world.userId, world.businessId, 'stock', {idempotency_key: key(), kind, detalle});
        expect(result).toMatchObject({estado: 'bloqueado', bloqueo: {codigo: 'nivel_autonomia', area: 'inventario', nivel_efectivo: 1}});
      }
      expect((await rows('SELECT 1 FROM assistant.stock_proposals WHERE business_id = $1', [world.businessId])).length).toBe(before);
      expect((await propose(world, 'apuesta', bet)).tipo).toBe('apuesta');
      await lower('ofertas');
      await expect(world.stock.proposals.create(world.userId, world.businessId, 'stock', {idempotency_key: key(), kind: 'apuesta', detalle: bet})).resolves.toMatchObject({estado: 'bloqueado'});
    });

    it('cada tipo cae en su área: pedido en reposición, kit y apuesta en ofertas, autonomía donde pide', () => {
      const area = (kind: string, detalle: object = {}) => areaOf({kind, detalle} as never);
      expect(['conteo', 'entrada', 'venta', 'catalogo', 'union_catalogo'].map(kind => area(kind))).toEqual(Array(5).fill('inventario'));
      expect([area('pedido'), area('kit'), area('apuesta'), area('autonomia', {area: 'negociacion'})]).toEqual(['reposicion', 'ofertas', 'ofertas', 'negociacion']);
    });

    it('un tope de 1 en el servidor bloquea aunque la fila diga 2', async () => {
      const capped = await withMax(1);
      const variantId = await seedVariant(world);
      await expect(capped.stock.proposals.create(world.userId, world.businessId, 'stock', {idempotency_key: key(), kind: 'venta', detalle: {variante_id: variantId, cantidad: 1}})).resolves.toMatchObject({estado: 'bloqueado'});
      expect((await capped.stock.autonomy.levels(world.businessId, 'inventario')).nivel_efectivo).toBe(1);
    });

    it('un área bloqueada tampoco pide subir', async () => {
      await receiveOrder();
      await lower('reposicion');
      await expect(ask({...REQUEST, nivel_pedido: 2})).resolves.toMatchObject({estado: 'bloqueado'});
      expect(await proposalCount()).toBe(0);
    });
  });

  describe('R34: subir solo con el dueño, bajo el tope del servidor', () => {
    it('las tres ramas: tope 3 sin aprobación, tope 3 con aprobación, y tope 2 aprobado o no', async () => {
      const three = await createWorld(db, {maxAutonomy: 3});
      await receiveOrder(three);
      const orders = async (target: World) => (await target.db.query<{n: number}>('SELECT count(*)::int AS n FROM assistant.stock_orders WHERE business_id = $1', [target.businessId])).rows[0]!.n;

      // Tope 3 sin aprobación: el tope solo no sube a nadie.
      await expect(three.stock.autonomy.orderWithoutProposal(three.businessId)).rejects.toMatchObject({code: 'FORBIDDEN'});
      await expect(three.stock.autonomy.assert(three.businessId, 'reposicion', 3)).rejects.toMatchObject({code: 'FORBIDDEN'});
      const proposal = await asked(REQUEST, three);
      await expect(three.stock.autonomy.assert(three.businessId, 'reposicion', 3)).rejects.toMatchObject({code: 'FORBIDDEN'}); // Pedir tampoco.
      expect(await orders(three)).toBe(1);

      // Tope 3 con aprobación: pasa la barrera, y operar sigue fuera de esta ola.
      await decide(proposal, three);
      await expect(three.stock.autonomy.assert(three.businessId, 'reposicion', 3)).resolves.toBeUndefined();
      expect((await three.stock.autonomy.levels(three.businessId, 'reposicion')).nivel_efectivo).toBe(3);
      await expect(three.stock.autonomy.orderWithoutProposal(three.businessId)).rejects.toMatchObject({code: 'SERVICE_UNAVAILABLE'});
      expect(await orders(three)).toBe(1);

      // Tope 2: da igual lo aprobado.
      const capped = await withMax(2, three);
      await expect(capped.stock.autonomy.assert(three.businessId, 'reposicion', 3)).rejects.toMatchObject({code: 'FORBIDDEN'});
      await expect(capped.stock.autonomy.orderWithoutProposal(three.businessId)).rejects.toMatchObject({code: 'FORBIDDEN'});
      await expect(world.stock.autonomy.assert(world.businessId, 'reposicion', 3)).rejects.toMatchObject({code: 'FORBIDDEN'});
      await expect(world.stock.autonomy.assert(world.businessId, 'reposicion', 2)).resolves.toBeUndefined();
    });

    it('subir el tope no activa un permiso viejo: exige una aprobación nueva', async () => {
      await receiveOrder();
      await decide(await asked());
      const raised = await withMax(3);
      await expect(raised.stock.autonomy.assert(world.businessId, 'reposicion', 3)).rejects.toMatchObject({code: 'FORBIDDEN'});
      const fresh = await asked(REQUEST, raised);
      expect(await proposalCount()).toBe(2);
      await decide(fresh, raised);
      await expect(raised.stock.autonomy.assert(world.businessId, 'reposicion', 3)).resolves.toBeUndefined();
    });

    it('bajar de nivel anula un permiso ya aprobado', async () => {
      const three = await createWorld(db, {maxAutonomy: 3});
      await receiveOrder(three);
      await decide(await asked(REQUEST, three), three);
      await lower('reposicion', 1, key(), 1, undefined, three);
      await expect(three.stock.autonomy.assert(three.businessId, 'reposicion', 3)).rejects.toMatchObject({code: 'FORBIDDEN'});
      expect((await three.stock.autonomy.levels(three.businessId, 'reposicion')).nivel_efectivo).toBe(1);
    });

    it('un permiso de una corrida simulada no vale fuera de esa corrida', async () => {
      const three = await createWorld(db, {maxAutonomy: 3});
      const runId = randomUUID();
      await three.db.query(`INSERT INTO assistant.stock_runs(id,business_id,name,seed,status) VALUES ($1,$2,'r','s','activo')`, [runId, three.businessId]);
      await receiveOrder(three, {runId});
      const proposal = await asked(REQUEST, three);
      expect(proposal.simulado).toBe(true);
      await decide(proposal, three);
      await expect(three.stock.autonomy.assert(three.businessId, 'reposicion', 3)).resolves.toBeUndefined();
      await three.db.query(`UPDATE assistant.stock_runs SET status = 'cerrado' WHERE id = $1`, [runId]);
      await expect(three.stock.autonomy.assert(three.businessId, 'reposicion', 3)).rejects.toMatchObject({code: 'FORBIDDEN'});
    });

    it('nadie aprueba fuera de la web: ni voz, ni canal, ni semilla del banco', async () => {
      const bench = await createWorld(db, {bench: true});
      const runId = randomUUID();
      await bench.db.query(`INSERT INTO assistant.stock_runs(id,business_id,name,seed,status) VALUES ($1,$2,'r','s','activo')`, [runId, bench.businessId]);
      await receiveOrder(bench, {runId});
      const proposal = await asked(REQUEST, bench);
      await say(bench, 'sí');
      const {proposals} = bench.stock;
      await expect(proposals.confirmByVoice(bench.userId, bench.businessId, proposal.id, proposal.revision)).rejects.toMatchObject({code: 'FORBIDDEN'});
      await expect(proposals.confirmByChannel(bench.userId, bench.businessId, proposal.id, proposal.revision, 'sí', 's')).rejects.toMatchObject({code: 'FORBIDDEN'});
      await expect(proposals.confirmSeed(bench.businessId, proposal.id, proposal.revision, runId)).rejects.toMatchObject({code: 'FORBIDDEN'});
      expect((await bench.db.query('SELECT 1 FROM assistant.stock_autonomy_requests WHERE business_id = $1', [bench.businessId])).rows).toEqual([]);
    });

    it('el modelo no puede dictar evidencia: `detalle.evidencia` es un error de esquema', async () => {
      await receiveOrder();
      await expect(ask({...REQUEST, evidencia: [{dato: 'Ahorro', valor: '999999999', fuente: 'yo', simulado: false}]})).rejects.toMatchObject({name: 'ZodError'});
      expect(await proposalCount()).toBe(0);
    });

    it('las cifras las calcula el servidor, cada una con fuente y marca de simulado', async () => {
      await receiveOrder(world, {quantity: 58, saving: '58000.00'});
      await receiveOrder(world, {quantity: 2, saving: '1500.50'});
      const proposal = await asked();
      expect(proposal.detalle).toMatchObject({area: 'reposicion', nivel_actual: 2, nivel_pedido: 3, nivel_efectivo: 2, monto_tope: '500000.00'});
      if (proposal.tipo !== 'autonomia') throw new Error('tipo');
      expect(proposal.detalle.evidencia).toEqual([
        {dato: 'Pedidos recibidos sin diferencia', valor: '2', fuente: 'pedidos', simulado: false},
        {dato: 'Unidades recibidas y confirmadas', valor: '60', fuente: 'movimientos', simulado: false},
        {dato: 'Ahorro confirmado', valor: '59500.50', fuente: 'pedidos', simulado: false},
      ]);
    });

    it('en una corrida simulada la evidencia sale marcada', async () => {
      const runId = randomUUID();
      await world.db.query(`INSERT INTO assistant.stock_runs(id,business_id,name,seed,status) VALUES ($1,$2,'r','s','activo')`, [runId, world.businessId]);
      await receiveOrder(world, {runId});
      const proposal = await asked();
      if (proposal.tipo !== 'autonomia') throw new Error('tipo');
      expect(proposal.detalle.evidencia.map(item => item.simulado)).toEqual([true, true, true]);
    });

    it.each([
      ['sin pedidos', null],
      ['pedido sin ahorro', {saving: null}],
      ['ahorro en cero', {saving: '0'}],
      ['recibido con diferencia', {contado: 9, entered: 10}],
      ['entrada incompleta', {entered: 9, contado: 10}],
    ])('sin la condición del servidor da 409 CONFLICT: %s', async (_name, options) => {
      if (options) await receiveOrder(world, options);
      await expect(ask()).rejects.toMatchObject({code: 'CONFLICT', status: 409});
      expect(await proposalCount()).toBe(0);
    });

    it('un pedido sin recibir tampoco cuenta, aunque traiga cantidad y ahorro', async () => {
      const orderId = await receiveOrder();
      await world.db.query(`UPDATE assistant.stock_orders SET status = 'acordado' WHERE id = $1`, [orderId]);
      await expect(ask()).rejects.toMatchObject({code: 'CONFLICT'});
    });

    it('un pedido de una corrida simulada no sirve de evidencia real', async () => {
      const runId = randomUUID();
      await world.db.query(`INSERT INTO assistant.stock_runs(id,business_id,name,seed,status) VALUES ($1,$2,'r','s','activo')`, [runId, world.businessId]);
      await receiveOrder(world, {runId});
      await world.db.query(`UPDATE assistant.stock_runs SET status = 'cerrado' WHERE id = $1`, [runId]);
      await expect(ask()).rejects.toMatchObject({code: 'CONFLICT'});
    });

    it('solo el peldaño siguiente y con un monto mayor a cero', async () => {
      await receiveOrder();
      await expect(ask({...REQUEST, nivel_pedido: 4})).rejects.toMatchObject({code: 'INVALID_REQUEST'});
      await expect(ask({...REQUEST, nivel_pedido: 2})).rejects.toMatchObject({code: 'INVALID_REQUEST'});
      await expect(ask({...REQUEST, monto_tope: '0'})).rejects.toMatchObject({code: 'INVALID_REQUEST'});
      expect(await proposalCount()).toBe(0);
    });

    it('el dueño regresa de 1 a 2, nunca más arriba, sin revivir un permiso, y con historial', async () => {
      const three = await createWorld(db, {maxAutonomy: 3});
      await receiveOrder(three);
      await decide(await asked(REQUEST, three), three);
      expect((await three.stock.autonomy.levels(three.businessId, 'reposicion')).nivel_efectivo).toBe(3);
      await lower('reposicion', 1, key(), 1, undefined, three);
      await expect(lower('reposicion', 2, key(), 3, undefined, three)).rejects.toMatchObject({code: 'INVALID_REQUEST'});
      await expect(lower('reposicion', 2, key(), 4, undefined, three)).rejects.toMatchObject({code: 'INVALID_REQUEST'});
      await expect(lower('reposicion', 9, key(), 2, undefined, three)).rejects.toMatchObject({code: 'CONFLICT'});
      const chosen = key();
      expect(await lower('reposicion', 2, chosen, 2, undefined, three)).toEqual({area: 'reposicion', nivel: 2, nivel_efectivo: 2, revision: 3});
      expect(await lower('reposicion', 2, chosen, 2, undefined, three)).toEqual({area: 'reposicion', nivel: 2, nivel_efectivo: 2, revision: 3});
      await expect(lower('reposicion', 3, key(), 2, undefined, three)).rejects.toMatchObject({code: 'INVALID_REQUEST'});
      const {rows} = await three.db.query<{action: string}>(`SELECT action FROM assistant.stock_audit WHERE business_id = $1 AND entity = 'stock_autonomy_requests' ORDER BY recorded_at, action`, [three.businessId]);
      expect(rows.map(row => row.action).sort()).toEqual(['bajar_nivel', 'regresar_nivel']);
      await expect(three.stock.proposals.create(three.userId, three.businessId, 'stock', {idempotency_key: key(), kind: 'venta', detalle: {variante_id: randomUUID(), cantidad: 1}})).rejects.toMatchObject({code: 'NOT_FOUND'});
    });

    it('el dueño baja con revisión e idempotencia, y no sube por esa ruta sin estar en 1', async () => {
      const chosen = key();
      await expect(lower('inventario', 1, key(), 2)).rejects.toMatchObject({code: 'INVALID_REQUEST'});
      await expect(lower('inventario', 1, key(), 3)).rejects.toMatchObject({code: 'INVALID_REQUEST'});
      await expect(lower('inventario', 9)).rejects.toMatchObject({code: 'CONFLICT'});
      expect(await lower('inventario', 1, chosen, 1, 'muy pronto')).toEqual({area: 'inventario', nivel: 1, nivel_efectivo: 1, revision: 2});
      expect(await lower('inventario', 1, chosen, 1, 'muy pronto')).toEqual({area: 'inventario', nivel: 1, nivel_efectivo: 1, revision: 2});
      await expect(lower('inventario', 2, chosen, 1, 'otro motivo')).rejects.toMatchObject({code: 'CONFLICT'});
      const history = await requests();
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({from_level: 2, to_level: 1, proposal_id: null, evidence: {motivo: 'muy pronto', actor: world.userId}});
      await expect(world.db.query(`SELECT 1 FROM assistant.stock_audit WHERE business_id = $1 AND action = 'bajar_nivel'`, [world.businessId])).resolves.toMatchObject({rows: [expect.anything()]});
    });
  });

  describe('R35: el nivel real sigue en 2', () => {
    it('aprobar en web registra el permiso y no cambia ni el nivel ni lo efectivo', async () => {
      await receiveOrder();
      const proposal = await asked();
      const approved = await decide(proposal);
      expect(approved).toMatchObject({estado: 'aprobada', detalle: {nivel_actual: 2, nivel_pedido: 3, nivel_efectivo: 2}});
      expect(await stored('reposicion')).toEqual({level: 2, revision: 1});
      expect(await level('reposicion')).toEqual({area: 'reposicion', nivel: 2, nivel_efectivo: 2, revision: 1});
      expect(await requests()).toEqual([expect.objectContaining({
        from_level: 2, to_level: 3, proposal_id: proposal.id,
        evidence: expect.objectContaining({tope_al_aprobar: 2, revision_nivel: 1, monto_tope: '500000.00', evidencia: expect.arrayContaining([expect.objectContaining({dato: 'Ahorro confirmado'})])}),
      })]);
    });

    it('rechazar guarda el motivo y no deja permiso', async () => {
      await receiveOrder();
      const proposal = await asked();
      await world.stock.proposals.reject({userId: world.userId}, world.businessId, proposal.id, proposal.revision, key(), 'todavía no');
      expect(await requests()).toEqual([]);
      expect(await rows('SELECT reason, decision FROM assistant.stock_confirmations WHERE proposal_id = $1', [proposal.id])).toEqual([{reason: 'todavía no', decision: 'rechazada'}]);
    });

    it('si bajaron el nivel mientras estaba pendiente, aprobar da CONFLICT', async () => {
      await receiveOrder();
      const proposal = await asked();
      await lower('reposicion');
      await expect(decide(proposal)).rejects.toMatchObject({code: 'CONFLICT'});
      expect((await requests()).filter(item => item.proposal_id)).toEqual([]);
    });

    it('si la evidencia ya no se sostiene al aprobar, da CONFLICT', async () => {
      const orderId = await receiveOrder();
      const proposal = await asked();
      await world.db.query(`UPDATE assistant.stock_orders SET saving_confirmed = NULL WHERE id = $1`, [orderId]);
      await expect(decide(proposal)).rejects.toMatchObject({code: 'CONFLICT'});
      expect(await requests()).toEqual([]);
    });
  });

  describe('R36: pagar no existe', () => {
    it('ninguna capacidad de ningún nivel paga, y las herramientas son la lista cerrada', () => {
      expect(LEVEL_CAPABILITIES).toEqual({
        1: ['aprender'], 2: ['aprender', 'proponer'], 3: ['aprender', 'proponer', 'operar_con_limites'], 4: ['aprender', 'proponer', 'operar_con_limites', 'operar_negocio'],
      });
      expect(Object.keys(STOCK_TOOLS).sort()).toEqual([
        'saleads_stock_confirm_count', 'saleads_stock_document_extract', 'saleads_stock_document_register', 'saleads_stock_get_bet_signal', 'saleads_stock_get_item', 'saleads_stock_get_overview',
        'saleads_stock_get_photo', 'saleads_stock_list_orders', 'saleads_stock_list_proposals', 'saleads_stock_list_suppliers', 'saleads_stock_propose', 'saleads_stock_robot_say',
        'saleads_stock_supplier_send', 'saleads_stock_supplier_wait', 'saleads_stock_take_photo',
      ]);
    });
  });

  describe('solicitud repetida', () => {
    const later = (days: number) => {world.now.value = new Date(world.now.value.getTime() + days * 86_400_000);};

    it('en 7 días con el mismo nivel no crea otra; con otra clave devuelve la misma', async () => {
      await receiveOrder();
      const first = await asked();
      later(6.9);
      expect((await asked()).id).toBe(first.id);
      expect(await proposalCount()).toBe(1);
      later(0.2);
      expect((await asked()).id).not.toBe(first.id);
      expect(await proposalCount()).toBe(2);
    });

    it('una rechazada tampoco se repite en 7 días, y otra área sí pide', async () => {
      await receiveOrder();
      const first = await asked();
      await world.stock.proposals.reject({userId: world.userId}, world.businessId, first.id, first.revision, key(), 'no');
      expect((await asked()).id).toBe(first.id);
      expect((await asked({...REQUEST, area: 'ofertas'})).id).not.toBe(first.id);
      expect(await proposalCount()).toBe(2);
    });

    it('una aprobada no se vuelve a pedir, ni pasados los 7 días', async () => {
      await receiveOrder();
      const first = await asked();
      await decide(first);
      later(30);
      expect((await asked()).id).toBe(first.id);
      expect(await proposalCount()).toBe(1);
    });
  });

  describe('cadena de voz', () => {
    const events = () => rows<{kind: string; status: string; proposal_id: string; payload: {texto: string; pregunta: boolean; plantilla: string}}>(
      'SELECT kind, status, proposal_id, payload FROM assistant.stock_robot_events WHERE business_id = $1', [world.businessId]);

    it('al pedir queda un único aviso de plantilla con cifras del servidor, sin texto del modelo', async () => {
      await receiveOrder();
      const proposal = await asked();
      await asked();
      const list = await events();
      expect(list).toEqual([{kind: 'decir', status: 'pendiente', proposal_id: proposal.id, payload: expect.objectContaining({plantilla: 'autonomia', pregunta: false})}]);
      expect(list[0]!.payload.texto).toBe('Ya recibimos un pedido completo y ahorramos 58.000 COP. ¿Me das permiso para reponer hasta 500.000 COP? Decídelo en la pantalla de Stock.');
      expect(list[0]!.payload.texto.length).toBeLessThanOrEqual(STOCK_SAY_TEXT_MAX);
    });

    it('sin propuesta no hay aviso, y el aviso no se confunde con la pregunta de un conteo', async () => {
      await expect(ask()).rejects.toMatchObject({code: 'CONFLICT'});
      expect(await events()).toEqual([]);
      await receiveOrder();
      const variantId = await seedVariant(world);
      await stockIn(world, variantId, 4);
      const [first, second] = [await count(world, variantId, 4), await count(world, variantId, 4)];
      await world.db.query(`INSERT INTO assistant.stock_robot_events(business_id,user_id,kind,payload,proposal_id) VALUES ($1,$2,'decir','{"pregunta":"true"}',$3)`, [world.businessId, world.userId, first.id]);
      await asked();
      await say(world, 'sí');
      await expect(world.stock.proposals.confirmByVoice(world.userId, world.businessId, first.id, first.revision)).resolves.toMatchObject({estado: 'aprobada'});
      expect(second.estado).toBe('pendiente');
    });
  });

  it('bandera apagada: no hay runtime y no toca la base', async () => {
    const pool = {query: jest.fn()};
    const settings = stockSettings({STOCK_ENABLED: false, STOCK_USER_IDS: ['u'], STOCK_BUSINESS_SEEDS: [`${randomUUID()}:u:COP`], STOCK_WEB_BASE_URL: '', STOCK_BENCH_ENABLED: false, STOCK_MAX_AUTONOMY_LEVEL: 3});
    await expect(buildStock(settings, {pool: pool as never, db: pgliteStockDb(db)})).resolves.toBeUndefined();
    expect(pool.query).not.toHaveBeenCalled();
  });
});
