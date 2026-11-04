import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {buildStock, stockSettings, type StockRuntime} from '../src/stock/module';
import {BenchSupplierChannel} from '../src/stock/supplier-channel';

/**
 * Corre solo con Postgres real (`scripts/stock-postgres-real.sh`, trabajo `stock-postgres`). PGlite usa una sola
 * conexión: ahí estas pruebas pasarían solas. `STOCK_PG_RUNTIME_URL` es el rol `assistant`, no el dueño del schema.
 */
const runtimeUrl = process.env.STOCK_PG_RUNTIME_URL;
const suite = runtimeUrl ? describe : describe.skip;
const BUSINESS = '7e88bd4a-0000-4000-8000-0000000000aa';

suite('Stock sobre Postgres real con el rol de runtime', () => {
  let pool: Pool;

  beforeAll(() => {pool = new Pool({connectionString: runtimeUrl, max: 5, options: '-c search_path=assistant'});});
  afterAll(async () => {await pool.end();});

  const graph = async () => {
    const [product, variant, proposal, confirmation] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await pool.query(`INSERT INTO assistant.stock_products(id,business_id,user_id,name,normalized_name,offering_type,offering_id,occurred_at) VALUES ($1,$2,'u','P','${product}','product','o',now())`, [product, BUSINESS]);
    await pool.query(`INSERT INTO assistant.stock_variants(id,product_id,name,currency) VALUES ($1,$2,'v','COP')`, [variant, product]);
    await pool.query(`INSERT INTO assistant.stock_proposals(id,business_id,user_id,kind,title,reason,payload,effects_yes,effects_no,expires_at,idempotency_key,request_hash,trace_id,created_by,occurred_at)
      VALUES ($1,$2,'u','venta','t','r','{}','[]','[]',now(),$3,$4,$5,'stock',now())`, [proposal, BUSINESS, randomUUID(), 'a'.repeat(64), randomUUID()]);
    await pool.query(`INSERT INTO assistant.stock_confirmations(id,proposal_id,business_id,method,actor,decision) VALUES ($1,$2,$3,'web','u','aprobada')`, [confirmation, proposal, BUSINESS]);
    const movement = randomUUID();
    await pool.query(`INSERT INTO assistant.stock_movements(id,business_id,variant_id,kind,delta,origin,confirmation_id,proposal_id,trace_id,occurred_at)
      VALUES ($1,$2,$3,'entrada',5,'t',$4,$5,$6,now())`, [movement, BUSINESS, variant, confirmation, proposal, randomUUID()]);
    return {movement, confirmation};
  };

  describe('concurrencia del libro: PGlite usa una conexión y aquí pasaría sola', () => {
    let stock: StockRuntime;
    let businessId: string;
    let n = 0;
    const user = 'u-real';
    const key = () => randomUUID();

    beforeAll(async () => {
      businessId = randomUUID();
      stock = (await buildStock(stockSettings({STOCK_ENABLED: true, STOCK_USER_IDS: [user], STOCK_BUSINESS_SEEDS: [`${businessId}:${user}:COP`], STOCK_WEB_BASE_URL: '',
        STOCK_BENCH_ENABLED: false, STOCK_MAX_AUTONOMY_LEVEL: 2}), {pool, offerings: {find: async () => null}}))!;
    });

    const variant = async (kit = false) => {
      const [productId, variantId] = [randomUUID(), randomUUID()];
      await pool.query(`INSERT INTO assistant.stock_products(id,business_id,user_id,name,normalized_name,offering_type,offering_id,is_kit,occurred_at) VALUES ($1,$2,$3,$4,$4,$5,$6,$7,now())`,
        [productId, businessId, user, `real ${++n}`, kit ? null : 'product', kit ? null : 'o', kit]);
      await pool.query(`INSERT INTO assistant.stock_variants(id,product_id,name,currency,is_kit) VALUES ($1,$2,'v','COP',$3)`, [variantId, productId, kit]);
      return variantId;
    };
    const propose = async (kind: string, detalle: unknown) => {
      const result = await stock.proposals.create(user, businessId, 'stock', {idempotency_key: key(), kind, detalle});
      if (result.estado !== 'creada') throw new Error('sin propuesta');
      return result.propuesta;
    };
    const fill = async (variantId: string, quantity: number) => {
      const proposal = await propose('conteo', {variante_id: variantId, contado: quantity, origen: 'voz'});
      await stock.proposals.approveWeb({userId: user}, businessId, proposal.id, proposal.revision, key(), 'otra');
    };

    it('con 20 ventas concurrentes sobre saldo 10, pasan exactamente 10 y el saldo final es 0', async () => {
      const variantId = await variant();
      await fill(variantId, 10);
      const sales = await Promise.all(Array.from({length: 20}, () => propose('venta', {variante_id: variantId, cantidad: 1})));
      const results = await Promise.allSettled(sales.map(sale => stock.proposals.approveWeb({userId: user}, businessId, sale.id, sale.revision, key())));
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(10);
      const failures = results.flatMap(result => result.status === 'rejected' ? [(result.reason as {code?: string}).code] : []);
      expect(new Set(failures)).toEqual(new Set(['STOCK_NEGATIVE']));
      await expect(stock.ledger.balance(businessId, variantId, null)).resolves.toBe(0);
    }, 60_000);

    it('kits cruzados concurrentes no se bloquean: los candados van ordenados por variante', async () => {
      const [a, b] = [await variant(), await variant()];
      await fill(a, 40);
      await fill(b, 40);
      const [ab, ba] = [await variant(true), await variant(true)];
      for (const [kit, first, second] of [[ab, a, b], [ba, b, a]] as const) {
        await pool.query('INSERT INTO assistant.stock_kit_components VALUES ($1,$2,1), ($1,$3,1)', [kit, first, second]);
      }
      const sales = await Promise.all(Array.from({length: 20}, (_, index) => propose('venta', {variante_id: index % 2 ? ab : ba, cantidad: 1})));
      await Promise.all(sales.map(sale => stock.proposals.approveWeb({userId: user}, businessId, sale.id, sale.revision, key())));
      await expect(stock.ledger.balance(businessId, a, null)).resolves.toBe(20);
      await expect(stock.ledger.balance(businessId, b, null)).resolves.toBe(20);
    }, 60_000);
  });

  it('5 peticiones de autonomía concurrentes crean una sola propuesta y un solo aviso; el candado es del área', async () => {
    const [user, businessId] = ['u-autonomia', randomUUID()];
    const stock = (await buildStock(stockSettings({STOCK_ENABLED: true, STOCK_USER_IDS: [user], STOCK_BUSINESS_SEEDS: [`${businessId}:${user}:COP`], STOCK_WEB_BASE_URL: '',
      STOCK_BENCH_ENABLED: false, STOCK_MAX_AUTONOMY_LEVEL: 2}), {pool, offerings: {find: async () => null}}))!;
    const [product, variant, supplier, proposal, confirmation, order] = Array.from({length: 6}, () => randomUUID());
    await pool.query(`INSERT INTO assistant.stock_products(id,business_id,user_id,name,normalized_name,offering_type,offering_id,occurred_at) VALUES ($1,$2,$3,'A','a','product','o',now())`, [product, businessId, user]);
    await pool.query(`INSERT INTO assistant.stock_variants(id,product_id,name,currency) VALUES ($1,$2,'v','COP')`, [variant, product]);
    await pool.query(`INSERT INTO assistant.stock_suppliers(id,business_id,user_id,name,occurred_at) VALUES ($1,$2,$3,'P',now())`, [supplier, businessId, user]);
    await pool.query(`INSERT INTO assistant.stock_proposals(id,business_id,user_id,kind,title,reason,payload,effects_yes,effects_no,expires_at,idempotency_key,request_hash,trace_id,created_by,occurred_at)
      VALUES ($1,$2,$3,'pedido','t','r','{}','[]','[]',now(),$4,$5,$6,'stock',now())`, [proposal, businessId, user, randomUUID(), 'a'.repeat(64), randomUUID()]);
    await pool.query(`INSERT INTO assistant.stock_orders(id,business_id,user_id,variant_id,supplier_id,quantity,status,currency,proposal_id,occurred_at,received_qty,saving_confirmed)
      VALUES ($1,$2,$3,$4,$5,5,'recibido','COP',$6,now(),5,100)`, [order, businessId, user, variant, supplier, proposal]);
    await pool.query(`INSERT INTO assistant.stock_confirmations(id,proposal_id,business_id,method,actor,decision) VALUES ($1,$2,$3,'web','u','aprobada')`, [confirmation, proposal, businessId]);
    await pool.query(`INSERT INTO assistant.stock_movements(id,business_id,variant_id,kind,delta,origin,confirmation_id,proposal_id,order_id,trace_id,occurred_at)
      VALUES ($1,$2,$3,'entrada',5,'t',$4,$5,$6,$7,now())`, [randomUUID(), businessId, variant, confirmation, proposal, order, randomUUID()]);
    const results = await Promise.all(Array.from({length: 5}, () => stock.proposals.create(user, businessId, 'stock', {idempotency_key: randomUUID(), kind: 'autonomia', detalle: {area: 'reposicion', nivel_pedido: 3, monto_tope: '100'}})));
    expect(new Set(results.map(result => result.estado === 'creada' ? result.propuesta.id : result.estado)).size).toBe(1);
    const {rows} = await pool.query<{n: number; events: number}>(`SELECT (SELECT count(*)::int FROM assistant.stock_proposals WHERE business_id = $1 AND kind = 'autonomia') AS n,
      (SELECT count(*)::int FROM assistant.stock_robot_events WHERE business_id = $1) AS events`, [businessId]);
    expect(rows[0]).toEqual({n: 1, events: 1});
  }, 60_000);

  it('avisos concurrentes: un dedupe_key da una fila, y una ráfaga no pasa de 3 hablados', async () => {
    const [user, businessId, device] = ['u-avisos', randomUUID(), randomUUID()];
    const stock = (await buildStock(stockSettings({STOCK_ENABLED: true, STOCK_USER_IDS: [user], STOCK_BUSINESS_SEEDS: [`${businessId}:${user}:COP`], STOCK_WEB_BASE_URL: '',
      STOCK_BENCH_ENABLED: false, STOCK_MAX_AUTONOMY_LEVEL: 2}), {pool, offerings: {find: async () => null}}))!;
    await pool.query(`INSERT INTO assistant.stock_device_presence(device_id,user_id,device_state,events_seen_at) VALUES ($1,$2,'activo',now())`, [device, user]);
    const say = async (dedupe_key: string) => (await stock.notices.say(user, businessId, {texto: 't', pregunta: false, proposal_id: null, producto_id: null, prioridad: 'normal', dedupe_key})).status;
    await Promise.all(Array.from({length: 5}, () => say('misma')));
    const {rows: one} = await pool.query<{n: number}>(`SELECT count(*)::int AS n FROM assistant.stock_robot_events WHERE business_id = $1`, [businessId]);
    expect(one[0]!.n).toBe(1);
    const results = await Promise.all(Array.from({length: 10}, (_, index) => say(`k${index}`)));
    expect(results.filter(status => status === 'en_cola' || status === 'fuera_de_horario')).toHaveLength(2);
    expect(results.filter(status => status === 'tope_diario')).toHaveLength(8);
  }, 60_000);

  it('negociación: una sola abierta con aprobaciones simultáneas, clave repetida no reenvía, y el reinicio retoma por cursor', async () => {
    const [user, businessId, product, variant, supplier] = ['u-negocia', randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const channel = new BenchSupplierChannel('destino-fijo');
    const build = async () => (await buildStock(stockSettings({STOCK_ENABLED: true, STOCK_USER_IDS: [user], STOCK_BUSINESS_SEEDS: [`${businessId}:${user}:COP`], STOCK_WEB_BASE_URL: '',
      STOCK_BENCH_ENABLED: false, STOCK_MAX_AUTONOMY_LEVEL: 2}), {pool, offerings: {find: async () => null}, supplierChannel: channel, wake: async () => 'solicitado', toolWaitMs: 0}))!;
    const stock = await build();
    await pool.query(`INSERT INTO assistant.stock_products(id,business_id,user_id,name,normalized_name,offering_type,offering_id,occurred_at) VALUES ($1,$2,$3,'N','n','product','o',now())`, [product, businessId, user]);
    await pool.query(`INSERT INTO assistant.stock_variants(id,product_id,name,currency) VALUES ($1,$2,'v','COP')`, [variant, product]);
    await pool.query(`INSERT INTO assistant.stock_suppliers(id,business_id,user_id,name,lead_time_days,occurred_at) VALUES ($1,$2,$3,'P',5,now())`, [supplier, businessId, user]);
    await pool.query(`INSERT INTO assistant.stock_supplier_quotes(id,supplier_id,variant_id,price,currency) VALUES ($1,$2,$3,18000,'COP')`, [randomUUID(), supplier, variant]);
    const proposal = async () => {
      const result = await stock.proposals.create(user, businessId, 'stock', {idempotency_key: randomUUID(), kind: 'pedido', detalle: {variante_id: variant, proveedor_id: supplier, cantidad: 10, mandato: {precio_objetivo: '16000', tope: '18000'}}});
      if (result.estado !== 'creada') throw new Error('sin propuesta');
      return result.propuesta;
    };
    const proposals = await Promise.all(Array.from({length: 5}, proposal));
    const approvals = await Promise.allSettled(proposals.map(item => stock.proposals.approveWeb({userId: user}, businessId, item.id, item.revision, randomUUID())));
    expect(approvals.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    const {rows: orders} = await pool.query<{id: string}>('SELECT id FROM assistant.stock_orders WHERE business_id = $1', [businessId]);
    expect(orders).toHaveLength(1);
    const orderId = orders[0]!.id;
    try {
      const body = {idempotency_key: randomUUID(), order_id: orderId, texto: 'Busco precio.', precio_unitario_ofrecido: null, cantidad: null, cierre: false};
      const sends = await Promise.all(Array.from({length: 5}, () => stock.negotiation.send(user, businessId, body)));
      expect(new Set(sends.map(item => JSON.stringify(item))).size).toBe(1);
      expect(channel.sent).toHaveLength(1);
      channel.reply('uno');
      await stock.negotiation.tick();
      const restarted = await build();
      channel.reply('dos');
      await Promise.all([restarted.negotiation.tick(), stock.negotiation.tick()]);
      const {rows: inbound} = await pool.query<{body: string}>(`SELECT body FROM assistant.stock_supplier_messages WHERE order_id = $1 AND direction = 'entrante' ORDER BY recorded_at`, [orderId]);
      expect(inbound.map(row => row.body)).toEqual(['uno', 'dos']);
      await expect(pool.query('UPDATE assistant.stock_negotiations SET max_price = 99999 WHERE order_id = $1', [orderId])).rejects.toThrow(/immutable/);
    } finally {
      await pool.query(`UPDATE assistant.stock_orders SET status = 'cancelado' WHERE id = $1`, [orderId]);
    }
  }, 60_000);

  it('el runtime inserta en una tabla con BIGSERIAL', async () => {
    const {rows} = await pool.query<{id: string}>(`INSERT INTO assistant.stock_robot_events(business_id,user_id,kind,payload) VALUES ($1,'u','recount','{}') RETURNING id`, [BUSINESS]);
    expect(Number(rows[0]!.id)).toBeGreaterThan(0);
  });

  it('el runtime inserta en el libro, pero UPDATE y DELETE se rechazan por permiso', async () => {
    const {movement, confirmation} = await graph();
    await expect(pool.query('UPDATE assistant.stock_movements SET delta=1 WHERE id=$1', [movement])).rejects.toThrow(/permission denied/);
    await expect(pool.query('DELETE FROM assistant.stock_movements WHERE id=$1', [movement])).rejects.toThrow(/permission denied/);
    await expect(pool.query(`UPDATE assistant.stock_confirmations SET actor='x' WHERE id=$1`, [confirmation])).rejects.toThrow(/permission denied/);
    await expect(pool.query(`DELETE FROM assistant.stock_audit`)).rejects.toThrow(/permission denied/);
  });
});
