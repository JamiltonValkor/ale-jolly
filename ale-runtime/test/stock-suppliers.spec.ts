import {randomUUID} from 'node:crypto';
import {STOCK_TOOLS} from '../src/contracts/stock-v1';
import {compareQuotes, equivalenceOf, reorderPlan, type QuoteOption} from '../src/stock/suppliers';
import {saleRhythm} from '../src/stock/rotation';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';
import {approve, createWorld, key, propose, seedVariant, stockIn, type World} from './support/stock-world';

const quote = (over: Partial<QuoteOption> = {}): QuoteOption => ({
  proveedor_id: randomUUID(), nombre: 'P', dias_entrega: 5, precio: '17000.00', flete: '0.00', minimo: 1, plazo_pago_dias: 30, garantia: '30 días', equivalencia: 'equivalente', moneda: 'COP', ...over,
});

describe('reposición y costo total', () => {
  describe('cuentas sin base', () => {
    const hoy = new Date('2026-10-29T22:11:42.000Z');

    it('R23: saldo 40 a 14 por semana, entrega 5 y colchón 3: cubre 20 días y se pide en 12', () => {
      expect(reorderPlan({saldo: 40, ritmoVigente: 14, ritmoEstable: 14, diasEntrega: 5, horizonteDias: 30, minimo: 1, hoy})).toEqual({
        cobertura_dias: 20, punto_pedido_dias: 8, fecha_pedido: '2026-10-31', cantidad_sugerida: 36}); // 2 × 38 = 76, menos 40.
    });

    it('R23: la pauta prevista adelanta la fecha, y dentro del punto de pedido se pide hoy', () => {
      expect(reorderPlan({saldo: 40, ritmoVigente: 28, ritmoEstable: 14, diasEntrega: 5, horizonteDias: 30, minimo: 1, hoy}).fecha_pedido).toBe('2026-10-27');
      expect(reorderPlan({saldo: 2, ritmoVigente: 14, ritmoEstable: 14, diasEntrega: 5, horizonteDias: 30, minimo: 1, hoy}).fecha_pedido).toBe('2026-10-27');
    });

    it('R23: sin ritmo no hay fecha, y el mínimo sube la cantidad; lo que alcanza no se pide', () => {
      expect(reorderPlan({saldo: 40, ritmoVigente: 0, ritmoEstable: 0, diasEntrega: 5, horizonteDias: 30, minimo: 24, hoy})).toMatchObject({cobertura_dias: null, fecha_pedido: null, cantidad_sugerida: 0});
      expect(reorderPlan({saldo: 70, ritmoVigente: 14, ritmoEstable: 14, diasEntrega: 5, horizonteDias: 30, minimo: 24, hoy}).cantidad_sugerida).toBe(24);
    });

    it('R24: un pico de un día, en cualquier semana, no cambia el ritmo que da la cantidad', () => {
      const now = new Date('2026-10-30T16:00:49.000Z');
      const week = (back: number, units: number) => ({at: new Date(now.getTime() - (back * 7 + 2) * 86_400_000), units});
      const steady = Array.from({length: 9}, (_, back) => week(back, 14));
      expect(saleRhythm(steady, now).steady).toBe(14);
      expect(saleRhythm([...steady, week(0, 60)], now).steady).toBe(14);
      expect(saleRhythm([...steady, week(3, 60)], now).steady).toBe(14);
      expect(saleRhythm([...steady, week(3, 60)], now).base).toBeGreaterThan(14); // Sin quitar el pico, la base sí se mueve.
    });

    it('R25: el más barato por unidad con flete alto pierde en costo total', () => {
      const [cheap, fair] = [quote({nombre: 'Barato', precio: '16000.00', flete: '150000.00'}), quote({nombre: 'Justo', precio: '17000.00', flete: '20000.00'})];
      expect(compareQuotes([cheap, fair], 60, 'COP').map(row => [row.nombre, row.costo_total])).toEqual([['Justo', '1040000.00'], ['Barato', '1110000.00']]);
    });

    it('un mínimo mayor que la cantidad no es elegible, aunque salga más barato', () => {
      const compared = compareQuotes([quote({nombre: 'Mayorista', precio: '1.00', minimo: 100}), quote({nombre: 'Normal'})], 60, 'COP');
      expect(compared.map(row => [row.nombre, row.elegible, row.motivo_no])).toEqual([['Normal', true, null], ['Mayorista', false, 'minimo']]);
    });

    it('sin plazo de entrega u otra moneda no son elegibles: no se convierte ni se adivina', () => {
      expect(compareQuotes([quote({dias_entrega: null})], 1, 'COP')[0]).toMatchObject({elegible: false, motivo_no: 'sin_plazo_entrega'});
      expect(compareQuotes([quote({moneda: 'USD'})], 1, 'COP')[0]).toMatchObject({elegible: false, motivo_no: 'otra_moneda'});
    });

    it('R26: sin prueba, o con una prueba vacía, es alternativa', () => {
      expect([equivalenceOf(null), equivalenceOf({}), equivalenceOf({lote: 'x'})]).toEqual(['alternativa', 'alternativa', 'equivalente']);
    });
  });

  describe('con libro', () => {
    let db: TestDatabase;
    let world: World;
    let variantId: string;

    beforeAll(async () => {db = await startTestDatabase();});
    afterAll(async () => {await db.close();});
    beforeEach(async () => {
      world = await createWorld(db);
      variantId = await seedVariant(world, undefined, {unitCost: '18000'});
    });

    const supplier = async (name: string, values: {price: string; freight?: string; minQty?: number; lead?: number | null; proof?: object | null; recordedAt?: string}) => {
      const id = randomUUID();
      await world.db.query(`INSERT INTO assistant.stock_suppliers(id,business_id,user_id,name,lead_time_days,occurred_at) VALUES ($1,$2,$3,$4,$5,now())`, [id, world.businessId, world.userId, name, values.lead === undefined ? 5 : values.lead]);
      await world.db.query(`INSERT INTO assistant.stock_supplier_quotes(id,supplier_id,variant_id,price,freight,min_qty,equivalent_proof,currency,recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'COP',COALESCE($8,now()))`,
        [randomUUID(), id, variantId, values.price, values.freight ?? '0', values.minQty ?? 1, values.proof ? JSON.stringify(values.proof) : null, values.recordedAt ?? null]);
      return id;
    };
    const order = (proveedor: string, cantidad = 60) => ({variante_id: variantId, proveedor_id: proveedor, cantidad, mandato: {precio_objetivo: '16000', tope: '17000'}});

    it('la propuesta sale con costo total, ordenada, y R26 en cada fila', async () => {
      const chosen = await supplier('Capilar', {price: '17000', freight: '20000', proof: {lote: 'A'}});
      await supplier('Flete caro', {price: '16000', freight: '150000'});
      const proposal = await propose(world, 'pedido', order(chosen));
      if (proposal.tipo !== 'pedido') throw new Error('tipo');
      expect(proposal.detalle.proveedores.map(row => [row.nombre, row.costo_total, row.elegido, row.equivalencia])).toEqual([
        ['Capilar', '1040000.00', true, 'equivalente'], ['Flete caro', '1110000.00', false, 'alternativa']]);
      expect(proposal.detalle.mandato).toEqual({precio_objetivo: '16000.00', tope: '17000.00', cantidad: 60});
    });

    it('solo cuenta la última cotización del proveedor', async () => {
      const id = await supplier('Capilar', {price: '17000', recordedAt: '2026-10-30T00:00:00Z'});
      await world.db.query(`INSERT INTO assistant.stock_supplier_quotes(id,supplier_id,variant_id,price,currency) VALUES ($1,$2,$3,15000,'COP')`, [randomUUID(), id, variantId]);
      const proposal = await propose(world, 'pedido', order(id, 2));
      if (proposal.tipo !== 'pedido') throw new Error('tipo');
      expect(proposal.detalle.proveedores).toHaveLength(1);
      expect(proposal.detalle.proveedores[0]!.precio).toBe('15000.00');
    });

    it('proveedor no elegible: CONFLICT. Mandato al revés: INVALID_REQUEST. Sin cotización: 404', async () => {
      const big = await supplier('Mayorista', {price: '10000', minQty: 100});
      await expect(propose(world, 'pedido', order(big))).rejects.toMatchObject({code: 'CONFLICT'});
      const fine = await supplier('Capilar', {price: '17000'});
      await expect(propose(world, 'pedido', {...order(fine), mandato: {precio_objetivo: '18000', tope: '17000'}})).rejects.toMatchObject({code: 'INVALID_REQUEST'});
      await expect(propose(world, 'pedido', order(randomUUID()))).rejects.toMatchObject({code: 'NOT_FOUND'});
    });

    it('un kit no se pide', async () => {
      const kit = await seedVariant(world, undefined, {kit: true});
      const fine = await supplier('Capilar', {price: '17000'});
      await expect(propose(world, 'pedido', {...order(fine), variante_id: kit})).rejects.toMatchObject({code: 'INVALID_REQUEST'});
    });

    it('list_suppliers da fecha y cantidad por opción, y el costo total se calcula con ella', async () => {
      await stockIn(world, variantId, 40);
      await approve(world, await propose(world, 'venta', {variante_id: variantId, cantidad: 14}));
      await supplier('Capilar', {price: '17000', freight: '20000', proof: {lote: 'A'}});
      await supplier('Sin plazo', {price: '100', lead: null});
      const plan = await world.stock.suppliers.plan(world.businessId, variantId);
      expect(plan).toMatchObject({saldo: 26, ritmo_vigente: 14, ritmo_estable: 0, moneda: 'COP'});
      expect(plan!.opciones.map(row => [row.nombre, row.elegible, row.fecha_pedido, row.cobertura_dias])).toEqual([['Capilar', true, '2026-11-01', 13], ['Sin plazo', false, null, 13]]);
      expect(() => STOCK_TOOLS.saleads_stock_list_suppliers.output.parse({proveedores: [], reposicion: plan})).not.toThrow();
      expect(await world.stock.suppliers.plan(world.businessId, randomUUID())).toBeNull();
    });

    it('sin apuesta y sin ventas no hay fecha, y una apuesta vigente suma lo previsto', async () => {
      await stockIn(world, variantId, 40);
      await supplier('Capilar', {price: '17000'});
      expect((await world.stock.suppliers.plan(world.businessId, variantId))!.opciones[0]).toMatchObject({fecha_pedido: null, cantidad_sugerida: 0});
      await propose(world, 'apuesta', {variante_id: variantId, presupuesto_diario: '10', tope: '100', duracion_dias: 14, unidades_semana_previstas: 28, fuente_prevision: 'dato'});
      const plan = await world.stock.suppliers.plan(world.businessId, variantId);
      expect(plan).toMatchObject({ritmo_vigente: 28, ritmo_estable: 28});
      expect(plan!.opciones[0]).toMatchObject({cobertura_dias: 10, punto_pedido_dias: 8, fecha_pedido: '2026-11-01', cantidad_sugerida: 48}); // Horizonte = apuesta de 14 días: 4 por día × 22 = 88, menos 40.
    });

    it('IVB-024 (oficial, P6): una apuesta sin previsión no mueve fecha ni cantidad; con previsión, sí (R23, R24)', async () => {
      await stockIn(world, variantId, 40);
      await supplier('Capilar', {price: '17000'});
      await propose(world, 'apuesta', {variante_id: variantId, presupuesto_diario: '10', tope: '100', duracion_dias: 14, unidades_semana_previstas: null, fuente_prevision: 'supuesto'});
      expect((await world.stock.suppliers.plan(world.businessId, variantId))!.opciones[0]).toMatchObject({fecha_pedido: null, cantidad_sugerida: 0});
      await propose(world, 'apuesta', {variante_id: variantId, presupuesto_diario: '10', tope: '100', duracion_dias: 14, unidades_semana_previstas: 28, fuente_prevision: 'supuesto'});
      expect((await world.stock.suppliers.plan(world.businessId, variantId))!.opciones[0]).toMatchObject({fecha_pedido: '2026-11-01', cantidad_sugerida: 48});
    });

    it('idempotencia de pedido: misma clave, misma propuesta', async () => {
      const id = await supplier('Capilar', {price: '17000'});
      const body = {idempotency_key: key(), kind: 'pedido', detalle: order(id)};
      const first = await world.stock.proposals.create(world.userId, world.businessId, 'stock', body);
      const second = await world.stock.proposals.create(world.userId, world.businessId, 'stock', body);
      expect(second).toEqual(first);
    });
  });
});
