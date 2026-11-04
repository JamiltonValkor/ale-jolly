import {randomUUID} from 'node:crypto';
import {STOCK_TOOLS} from '../src/contracts/stock-v1';
import {alertId} from '../src/stock/alerts';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';
import {approve, createWorld, key, propose, seedDocument, seedVariant, type World} from './support/stock-world';

/**
 * IVB-024, avisos pendientes: qué aviso ya se le dijo a la dueña lo sabe el servidor, no la memoria del modelo
 * (`evidencia/diagnostico-memoria-vieja.md`). El tick sin memoria solo dice lo pendiente, y la sesión larga no lo calla.
 */
const NOW = new Date('2026-10-31T10:23:25.000Z');   // 10:00 en Bogotá: Jolly puede hablar
const DAY = 86_400_000;
const ago = (days: number): Date => new Date(NOW.getTime() - days * DAY);

describe('avisos pendientes calculados por el servidor', () => {
  let db: TestDatabase;
  let world: World;

  beforeAll(async () => {db = await startTestDatabase();});
  afterAll(async () => {await db.close();});
  beforeEach(async () => {world = await createWorld(db, {bench: true});});

  const at = (date: Date) => {world.now.value = date;};
  const online = () => world.db.query(
    `INSERT INTO assistant.stock_device_presence(device_id,user_id,device_state,events_seen_at) VALUES ($1,$2,'activo',$3)`, [randomUUID(), world.userId, world.now.value]);
  const stockUp = async (variantId: string, quantity: number, runId: string | null = null) => {
    const {documentId, lineas} = await seedDocument(world, [{variantId, quantity, unitCost: '17000.00'}], 'Proveedor', runId);
    await approve(world, await propose(world, 'entrada', {document_id: documentId, lineas}));
  };
  const stocked = async (quantity = 40, runId: string | null = null) => {
    at(ago(90));
    const variantId = await seedVariant(world, undefined, {unitCost: '17000.00', runId});
    await stockUp(variantId, quantity, runId);
    return variantId;
  };
  const sell = async (variantId: string, daysAgo: number, cantidad: number) => {
    at(ago(daysAgo));
    await approve(world, await propose(world, 'venta', {variante_id: variantId, cantidad}));
  };
  /** 2 por semana durante 8 semanas y 7 días sin vender: frenazo (R18). */
  const stalled = async (runId: string | null = null) => {
    const variantId = await stocked(40, runId);
    for (let week = 7; week >= 0; week--) await sell(variantId, 8 + week * 7, 2);
    return variantId;
  };
  const pending = async (when = NOW) => {
    at(when);
    return world.stock.alerts.pending(world.businessId);
  };
  const say = async (alertaId: string, when = NOW) => {
    at(when);
    await online();
    return STOCK_TOOLS.saleads_stock_robot_say.output.parse(await world.stock.alerts.say(world.userId, world.businessId, alertaId, 'normal'));
  };
  const events = async () => (await world.db.query<{dedupe_key: string; payload: {texto: string}}>(
    `SELECT dedupe_key, payload FROM assistant.stock_robot_events WHERE business_id = $1 AND kind = 'decir' ORDER BY id`, [world.businessId])).rows;
  const openRun = async () => {
    const run = randomUUID();
    await world.db.query(`UPDATE assistant.stock_runs SET status = 'cerrado' WHERE business_id = $1 AND status = 'activo'`, [world.businessId]);
    await world.db.query(`INSERT INTO assistant.stock_runs(id,business_id,name,seed,status) VALUES ($1,$2,'r',1,'activo')`, [run, world.businessId]);
    return run;
  };

  it('tick sin memoria: solo dice lo pendiente, con texto y cifras del servidor, y lo dicho ya no vuelve', async () => {
    const variantId = await stalled();
    const [alert, ...rest] = await pending();
    expect(rest).toEqual([]);
    expect(alert).toMatchObject({tipo: 'frenazo', variante_id: variantId, siguiente: 'marketing', pregunta: true, simulado: false,
      cifras: {saldo: 24, base_semanal: 2, actual_semanal: 0, dias_sin_venta: 8}, estado_desde: ago(8).toISOString()});
    expect(alert!.texto).toMatch(/vendía 2 por semana y lleva 8 días sin ventas\. Quedan 24\. ¿Se lo paso a marketing para que lo mueva\?$/);
    expect(STOCK_TOOLS.saleads_stock_get_overview.output.shape.avisos_pendientes.parse([alert])).toHaveLength(1);
    expect(await say(alert!.alerta_id)).toEqual({status: 'en_cola'});
    expect((await events()).map(event => event.payload.texto)).toEqual([alert!.texto]);
    // El tick siguiente arranca sin memoria: el servidor ya sabe que se dijo.
    expect(await pending(new Date(NOW.getTime() + 3 * 3_600_000))).toEqual([]);
    expect(await pending(new Date(NOW.getTime() + 2 * DAY))).toEqual([]);   // no se repite a diario
    expect(await say(alert!.alerta_id, new Date(NOW.getTime() + 2 * DAY))).toMatchObject({status: 'ya_dicho', evento_original: {estado: 'en_cola'}});
    expect(await events()).toHaveLength(1);
  });

  it('un aviso viejo de otra corrida no se dice ni da «dicho», y la corrida nueva tiene sus propios avisos', async () => {
    const oldRun = await openRun();
    await stalled(oldRun);
    const [oldAlert] = await pending();
    expect(await say(oldAlert!.alerta_id)).toEqual({status: 'en_cola'});
    const freshRun = await openRun();
    const freshVariant = await stalled(freshRun);
    const fresh = await pending();
    expect(fresh.map(alert => [alert.tipo, alert.variante_id, alert.simulado])).toEqual([['frenazo', freshVariant, true]]);
    expect(fresh[0]!.alerta_id).not.toBe(oldAlert!.alerta_id);
    expect(fresh[0]!.texto.endsWith('Datos simulados.')).toBe(true);
    // El id viejo, copiado del tablero, no habla ni se da por dicho en la corrida nueva.
    expect(await say(oldAlert!.alerta_id)).toEqual({status: 'no_vigente'});
    expect(await events()).toHaveLength(1);
    expect(await say(fresh[0]!.alerta_id)).toEqual({status: 'en_cola'});
    expect((await events()).map(event => event.dedupe_key)).toEqual([
      `alerta:${oldAlert!.alerta_id}@corrida-${oldRun}`, `alerta:${fresh[0]!.alerta_id}@corrida-${freshRun}`]);
  });

  it('una sesión larga no puede callar un pendiente: sigue pendiente hasta que se diga, y el texto libre no lo reemplaza', async () => {
    await stalled();
    const [alert] = await pending();
    for (let tick = 1; tick <= 3; tick++) expect((await pending(new Date(NOW.getTime() + tick * 3 * 3_600_000))).map(item => item.alerta_id)).toEqual([alert!.alerta_id]);
    // Sin robot no se crea evento: el aviso sigue pendiente para el próximo turno.
    at(NOW);
    expect(await world.stock.alerts.say(world.userId, world.businessId, alert!.alerta_id, 'normal')).toEqual({status: 'robot_offline'});
    expect((await pending()).map(item => item.alerta_id)).toEqual([alert!.alerta_id]);
    // Decirlo como texto libre con su línea AVISO: o su clave de alerta no vale: el servidor no sabría que se dijo.
    await online();
    const free = {pregunta: true, proposal_id: null, producto_id: null, prioridad: 'normal' as const};
    await expect(world.stock.notices.say(world.userId, world.businessId, {...free, texto: `AVISO: frenazo | ${alert!.texto}`, dedupe_key: key()}))
      .rejects.toMatchObject({code: 'STOCK_ALERT_ID_REQUIRED', status: 400});
    await expect(world.stock.notices.say(world.userId, world.businessId, {...free, texto: alert!.texto, dedupe_key: `stock-alerta:${alert!.variante_id}`}))
      .rejects.toMatchObject({code: 'STOCK_ALERT_ID_REQUIRED'});
    expect(await events()).toEqual([]);
    expect(await say(alert!.alerta_id)).toEqual({status: 'en_cola'});
    expect(await pending()).toEqual([]);
  });

  it('el estado cambia y vuelve: nace un id nuevo, que vuelve a estar pendiente', async () => {
    const variantId = await stalled();
    const [first] = await pending();
    await say(first!.alerta_id);
    await sell(variantId, 0, 2);                          // una venta limpia el frenazo
    expect(await pending()).toEqual([]);
    expect(await say(first!.alerta_id)).toMatchObject({status: 'ya_dicho'});   // dicho y ya no activo
    const later = new Date(NOW.getTime() + 9 * DAY);
    const [second] = await pending(later);
    expect(second).toMatchObject({tipo: 'frenazo', variante_id: variantId, estado_desde: NOW.toISOString()});
    expect(second!.alerta_id).not.toBe(first!.alerta_id);
    expect(second!.alerta_id).toBe(alertId({businessId: world.businessId, runId: null, variantId, tipo: 'frenazo', desde: NOW}));
    expect(await say(second!.alerta_id, later)).toEqual({status: 'en_cola'});
  });

  it('un pegando nuevo genera su aviso para reponer, una vez por apuesta', async () => {
    const variantId = await stocked(60);
    await sell(variantId, 20, 2);
    at(ago(2.5));
    const bet = await propose(world, 'apuesta', {variante_id: variantId, presupuesto_diario: '50000.00', tope: '350000.00', duracion_dias: 7, unidades_semana_previstas: 20, fuente_prevision: 'supuesto'});
    await approve(world, bet);
    expect((await pending()).filter(alert => alert.tipo === 'pegando')).toEqual([]);
    await sell(variantId, 1.5, 4);
    await sell(variantId, 0.5, 5);
    const hot = (await pending()).filter(alert => alert.tipo === 'pegando');
    expect(hot).toEqual([expect.objectContaining({siguiente: 'pedido', estado_desde: ago(2.5).toISOString(), cifras: expect.objectContaining({ritmo_actual_semana: 31.5, saldo: 49})})]);
    expect(hot[0]!.texto).toMatch(/está pegando con la pauta: vende 31,5 por semana\. Quedan 49, para 10,9 días\. ¿Le pido a Stock que prepare el pedido\?$/);
    expect(await say(hot[0]!.alerta_id)).toEqual({status: 'en_cola'});
    expect((await pending(new Date(NOW.getTime() + DAY))).filter(alert => alert.tipo === 'pegando')).toEqual([]);
  });

  it('cobertura: con la opción elegible más rápida, lo que hay no llega a la entrega más el colchón', async () => {
    const variantId = await stocked(12);
    for (const daysAgo of [6, 4, 2]) await sell(variantId, daysAgo, 2);
    const supplier = randomUUID();
    await world.db.query(`INSERT INTO assistant.stock_suppliers(id,business_id,user_id,name,lead_time_days,occurred_at,simulated) VALUES ($1,$2,$3,'Capilar',10,now(),false)`,
      [supplier, world.businessId, world.userId]);
    await world.db.query(
      `INSERT INTO assistant.stock_supplier_quotes(id,supplier_id,variant_id,price,freight,min_qty,payment_term_days,warranty,equivalent_proof,currency) VALUES ($1,$2,$3,'16000','0',1,30,null,null,'COP')`,
      [randomUUID(), supplier, variantId]);
    const alerts = await pending();
    expect(alerts.map(alert => alert.tipo)).toEqual(['cobertura']);
    expect(alerts[0]).toMatchObject({siguiente: 'pedido', cifras: {saldo: 6, cobertura_dias: 7, punto_pedido_dias: 13}});
  });
});
