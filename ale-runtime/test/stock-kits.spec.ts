import {profileConfig, profileFiles, SPECIALIST_SALEADS_INCLUDE, SPECIALISTS} from '../src/activation/profiles';
import type {AgentBundle} from '../src/activation/hermes-files';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';
import {approve, createWorld, key, propose, seedVariant, stockIn, type World} from './support/stock-world';

const OTHER = '77777777-7777-4777-8777-777777777777';

describe('IVB-017: kits con margen del servidor (R20c, R20d, R2)', () => {
  let test: TestDatabase;
  let world: World;
  const rows = async (sql: string, params: unknown[] = []): Promise<number> => (await world.db.query<{n: number}>(sql, params)).rows[0]!.n;
  const kitRows = () => Promise.all([
    rows('SELECT count(*)::int AS n FROM assistant.stock_products WHERE business_id = $1 AND is_kit', [world.businessId]),
    rows('SELECT count(*)::int AS n FROM assistant.stock_variants v JOIN assistant.stock_products p ON p.id = v.product_id WHERE p.business_id = $1 AND v.is_kit', [world.businessId]),
    rows('SELECT count(*)::int AS n FROM assistant.stock_kit_components c JOIN assistant.stock_variants v ON v.id = c.kit_variant_id JOIN assistant.stock_products p ON p.id = v.product_id WHERE p.business_id = $1', [world.businessId]),
  ]);
  const kit = (componentes: Array<[string, number]>, extra: object = {}) => propose(world, 'kit', {
    subtipo: 'kit', componentes: componentes.map(([variante_id, cantidad]) => ({variante_id, cantidad})), diagnostico: 'valor_percibido', fuentes: [], hipotesis: 'hipótesis', ...extra,
  });
  const detail = <T extends {tipo: string}>(proposal: T) => {
    if (proposal.tipo !== 'kit') throw new Error('tipo');
    return (proposal as unknown as Extract<import('../src/contracts/stock-v1').StockProposalV1, {tipo: 'kit'}>).detalle;
  };
  const approvedKit = async (componentes: Array<[string, number]>) => {
    await approve(world, await kit(componentes, {precio_propuesto: '50000', precio_fuente: 'suma de precios actuales'}));
    const {rows: found} = await world.db.query<{id: string}>('SELECT v.id FROM assistant.stock_variants v JOIN assistant.stock_products p ON p.id = v.product_id WHERE p.business_id = $1 AND v.is_kit', [world.businessId]);
    return found[0]!.id;
  };
  const balance = (variantId: string) => world.stock.ledger.balance(world.businessId, variantId, null);

  beforeAll(async () => {test = await startTestDatabase();});
  afterAll(async () => {await test.close();});
  beforeEach(async () => {world = await createWorld(test);});

  describe('aprobar y rechazar', () => {
    it('aprobar crea 1 producto, 1 variante kit y N componentes, sin oferta', async () => {
      const [a, b, c] = [await seedVariant(world, 'Tira'), await seedVariant(world, 'Parado'), await seedVariant(world, 'Tercero')];
      await approve(world, await kit([[a, 1], [b, 1], [c, 2]], {precio_propuesto: '10000'}));
      await expect(kitRows()).resolves.toEqual([1, 1, 3]);
      const {rows: products} = await world.db.query<{offering_id: string | null; offering_type: string | null}>('SELECT offering_id, offering_type FROM assistant.stock_products WHERE business_id = $1 AND is_kit', [world.businessId]);
      expect(products).toEqual([{offering_id: null, offering_type: null}]);
      expect(world.offerings.find).not.toHaveBeenCalled();
    });

    it('rechazar no crea ninguna fila de catálogo ni de libro', async () => {
      const a = await seedVariant(world, 'Tira');
      const movements = await rows('SELECT count(*)::int AS n FROM assistant.stock_movements WHERE business_id = $1', [world.businessId]);
      const proposal = await kit([[a, 1]]);
      await world.stock.proposals.reject({userId: world.userId}, world.businessId, proposal.id, proposal.revision, key());
      await expect(kitRows()).resolves.toEqual([0, 0, 0]);
      await expect(rows('SELECT count(*)::int AS n FROM assistant.stock_movements WHERE business_id = $1', [world.businessId])).resolves.toBe(movements);
    });

    it.each(['complemento', 'venta_adicional'])('%s aprobado no crea variante, y su título no lo llama kit', async subtipo => {
      const a = await seedVariant(world, 'Tira');
      const proposal = await kit([[a, 1]], {subtipo});
      expect(proposal.titulo).not.toMatch(/\bkit\b/i);
      await expect(approve(world, proposal)).resolves.toMatchObject({estado: 'aprobada'});
      await expect(kitRows()).resolves.toEqual([0, 0, 0]);
    });

    it('el inventario se sigue leyendo con un kit sin oferta', async () => {
      const id = await approvedKit([[await seedVariant(world, 'Tira'), 1]]);
      const items = await world.stock.reads.items(world.businessId);
      expect(items.kits.map(item => item.id)).toEqual([id]);
    });

    it('el mismo kit con otras cantidades es otro kit; repetido exactamente choca', async () => {
      const [a, b] = [await seedVariant(world, 'Tira'), await seedVariant(world, 'Parado')];
      await approve(world, await kit([[a, 1], [b, 1]]));
      await approve(world, await kit([[a, 1], [b, 2]]));
      await expect(kitRows()).resolves.toEqual([2, 2, 4]);
      await expect(approve(world, await kit([[a, 1], [b, 2]]))).rejects.toMatchObject({code: 'CONFLICT'});
    });
  });

  describe('cálculo del servidor', () => {
    it('coincide con la cuenta a mano en centavos, sin redondeo acumulado', async () => {
      const [a, b, c] = [await seedVariant(world, 'A', {unitCost: '0.07'}), await seedVariant(world, 'B', {unitCost: '1234.56'}), await seedVariant(world, 'C', {unitCost: '0.10'})];
      // 0.07 × 3 + 1234.56 × 2 + 0.10 × 3 = 2469.63 (en punto flotante, 0.1 × 3 y 0.07 × 3 no dan exacto).
      const proposal = await kit([[a, 3], [b, 2], [c, 3]], {precio_propuesto: '3000.01'});
      expect(detail(proposal)).toMatchObject({costo_total: '2469.63', margen_dinero: '530.38', margen_pct: 17.68, moneda: 'COP'});
      expect(detail(proposal).componentes.map(item => item.costo)).toEqual(['0.07', '1234.56', '0.10']);
    });

    it('un margen negativo se muestra tal cual: decidir es del dueño', async () => {
      const a = await seedVariant(world, 'A', {unitCost: '30000'});
      expect(detail(await kit([[a, 1]], {precio_propuesto: '25000'}))).toMatchObject({margen_dinero: '-5000.00', margen_pct: -20});
    });

    it('unidades_alcanzan es entero y lo fija el componente más corto: saldo 7, cantidad 2, da 3', async () => {
      const [a, b] = [await seedVariant(world, 'A'), await seedVariant(world, 'B')];
      await stockIn(world, a, 7);
      await stockIn(world, b, 100);
      expect(detail(await kit([[a, 2], [b, 1]])).unidades_alcanzan).toBe(3);
    });

    it('sin saldo alcanzan 0, y sube al entrar mercancía: se calcula al leer', async () => {
      const a = await seedVariant(world, 'A');
      const proposal = await kit([[a, 2]]);
      expect(detail(proposal).unidades_alcanzan).toBe(0);
      await stockIn(world, a, 5);
      expect(detail(await world.stock.proposals.get(world.businessId, proposal.id)).unidades_alcanzan).toBe(2);
    });

    it('usa el último costo aprobado de la variante, no uno guardado en la propuesta', async () => {
      const a = await seedVariant(world, 'A', {unitCost: '1000'});
      const proposal = await kit([[a, 1]], {precio_propuesto: '4000'});
      await stockIn(world, a, 1, '2500.00');
      expect(detail(await world.stock.proposals.get(world.businessId, proposal.id))).toMatchObject({costo_total: '2500.00', margen_dinero: '1500.00'});
    });

    it('falta un costo: costo_incompleto, nulos y sin estimar, aunque otro componente sí tenga costo', async () => {
      const [a, b] = [await seedVariant(world, 'Con costo', {unitCost: '1000'}), await seedVariant(world, 'Sin costo')];
      const proposal = await kit([[a, 1], [b, 1]], {precio_propuesto: '4000'});
      expect(detail(proposal)).toMatchObject({costo_incompleto: true, precio_pendiente: false, costo_total: null, margen_dinero: null, margen_pct: null, precio_propuesto: '4000.00'});
      expect(detail(proposal).componentes.map(item => item.costo)).toEqual(['1000.00', null]);
    });

    it.each([[undefined], ['0'], ['0.00']])('precio %s: precio_pendiente, márgenes nulos y sin error', async precio => {
      const a = await seedVariant(world, 'A', {unitCost: '1000'});
      const proposal = await kit([[a, 1]], precio === undefined ? {} : {precio_propuesto: precio});
      expect(detail(proposal)).toMatchObject({precio_pendiente: true, precio_propuesto: null, costo_total: '1000.00', margen_dinero: null, margen_pct: null, costo_incompleto: false});
      await approve(world, proposal);
      const {rows: found} = await world.db.query<{sale_price: string | null}>('SELECT v.sale_price FROM assistant.stock_variants v JOIN assistant.stock_products p ON p.id = v.product_id WHERE p.business_id = $1 AND v.is_kit', [world.businessId]);
      expect(found).toEqual([{sale_price: null}]);
    });

    it.each([['margen_dinero', '999999'], ['margen_pct', 99], ['costo_total', '1'], ['unidades_alcanzan', 1000]])('%s enviado por el modelo no entra', async (campo, valor) => {
      const a = await seedVariant(world, 'A', {unitCost: '1000'});
      await expect(kit([[a, 1]], {precio_propuesto: '4000', [campo]: valor})).rejects.toMatchObject({name: 'ZodError'});
      await expect(rows('SELECT count(*)::int AS n FROM assistant.stock_proposals WHERE business_id = $1 AND kind = $2', [world.businessId, 'kit'])).resolves.toBe(0);
    });

    it('la moneda sale de los componentes, y monedas distintas dan INVALID_REQUEST', async () => {
      const [a, b] = [await seedVariant(world, 'Pesos', {unitCost: '1000'}), await seedVariant(world, 'Dólares', {unitCost: '10'})];
      await world.db.query(`UPDATE assistant.stock_variants SET currency = 'USD' WHERE id = $1`, [b]);
      await expect(kit([[a, 1], [b, 1]], {precio_propuesto: '4000'})).rejects.toMatchObject({code: 'INVALID_REQUEST'});
      await expect(rows('SELECT count(*)::int AS n FROM assistant.stock_proposals WHERE business_id = $1 AND kind = $2', [world.businessId, 'kit'])).resolves.toBe(0);
      expect(detail(await kit([[b, 1]])).moneda).toBe('USD');
    });

    it('un componente unido cuenta como su canónica, sin doble componente', async () => {
      const [origen, destino] = [await seedVariant(world, 'Viejo', {unitCost: '1'}), await seedVariant(world, 'Nuevo', {unitCost: '2000'})];
      await approve(world, await propose(world, 'union_catalogo', {origen_id: origen, destino_id: destino}));
      expect(detail(await kit([[origen, 1]], {precio_propuesto: '3000'}))).toMatchObject({costo_total: '2000.00'});
      await expect(kit([[origen, 1], [destino, 1]])).rejects.toMatchObject({code: 'INVALID_REQUEST'});
    });

    it('una unión posterior a la propuesta también manda al leer el costo', async () => {
      const [origen, destino] = [await seedVariant(world, 'Viejo', {unitCost: '1'}), await seedVariant(world, 'Nuevo', {unitCost: '2000'})];
      const proposal = await kit([[origen, 1]], {precio_propuesto: '3000'});
      await approve(world, await propose(world, 'union_catalogo', {origen_id: origen, destino_id: destino}));
      expect(detail(await world.stock.proposals.get(world.businessId, proposal.id))).toMatchObject({costo_total: '2000.00', margen_dinero: '1000.00'});
    });

    it('componente ajeno o inexistente: NOT_FOUND. Kit dentro de kit: INVALID_REQUEST', async () => {
      await expect(kit([[OTHER, 1]])).rejects.toMatchObject({code: 'NOT_FOUND'});
      const inner = await approvedKit([[await seedVariant(world, 'A'), 1]]);
      await expect(kit([[inner, 1]])).rejects.toMatchObject({code: 'INVALID_REQUEST'});
    });

    it('guarda diagnóstico, fuentes y fuente del precio como dato, para auditar el entregable', async () => {
      const a = await seedVariant(world, 'A', {unitCost: '1000'});
      const fuentes = [{url: 'https://ejemplo.co/precio', fecha: '2026-11-01'}];
      const proposal = await kit([[a, 1]], {precio_propuesto: '4000', precio_fuente: 'comparable\nlocal', fuentes});
      const {rows: found} = await world.db.query<{payload: Record<string, unknown>}>('SELECT payload FROM assistant.stock_proposals WHERE id = $1', [proposal.id]);
      expect(found[0]!.payload).toMatchObject({precio_fuente: 'comparable local', fuentes, diagnostico: 'valor_percibido'});
    });
  });

  describe('vender el kit aprobado (R2)', () => {
    const sell = async (id: string, cantidad: number) => approve(world, await propose(world, 'venta', {variante_id: id, cantidad}));

    it('descuenta cada componente por cantidad × unidades, con la misma confirmación', async () => {
      const [a, b] = [await seedVariant(world, 'Tira'), await seedVariant(world, 'Parado')];
      await stockIn(world, a, 10);
      await stockIn(world, b, 10);
      const id = await approvedKit([[a, 1], [b, 2]]);
      await sell(id, 3);
      await expect(Promise.all([balance(a), balance(b)])).resolves.toEqual([7, 4]);
      await expect(rows('SELECT count(DISTINCT confirmation_id)::int AS n FROM assistant.stock_movements WHERE kit_variant_id = $1', [id])).resolves.toBe(1);
      expect(detail(await world.stock.proposals.get(world.businessId, (await world.db.query<{id: string}>(`SELECT id FROM assistant.stock_proposals WHERE business_id = $1 AND kind = 'kit'`, [world.businessId])).rows[0]!.id)).unidades_alcanzan).toBe(2);
    });

    it('todo o nada: un componente insuficiente deja ambos saldos intactos y la venta sin aprobar', async () => {
      const [a, b] = [await seedVariant(world, 'Tira'), await seedVariant(world, 'Parado')];
      await stockIn(world, a, 10);
      await stockIn(world, b, 3);
      const id = await approvedKit([[a, 1], [b, 2]]);
      const venta = await propose(world, 'venta', {variante_id: id, cantidad: 2});
      await expect(approve(world, venta)).rejects.toMatchObject({code: 'STOCK_NEGATIVE'});
      await expect(Promise.all([balance(a), balance(b)])).resolves.toEqual([10, 3]);
      await expect(rows('SELECT count(*)::int AS n FROM assistant.stock_movements WHERE kit_variant_id = $1', [id])).resolves.toBe(0);
    });
  });

  describe('R20d: el investigador no puede crear ofertas', () => {
    const matches = (pattern: string, tool: string) => new RegExp(`^${pattern.replace(/\*/g, '.*')}$`).test(tool);
    const include = (config: string): string[] => JSON.parse(/saleads:\n\s+tools:\n\s+include: (\[.*\])/.exec(config)![1]!) as string[];
    const FORBIDDEN = ['saleads_create_offering', 'saleads_stock_propose', 'saleads_stock_get_overview'];
    const bundle = (): AgentBundle => ({
      version: 'b', soul: '', skills: JSON.stringify({}), jobs: '[]', profiles: {investigador: 'soul', estratega: 'soul'},
      profileSkills: {investigador: {'saleads-offer-kit/SKILL.md': 'skill'}},
    } as unknown as AgentBundle);

    it.each([{}, {explicitReads: true}, {stock: true}, {stock: true, explicitReads: true, metaSearch: true, scopedMemory: true}])('la capa real de %j no lista herramientas de escritura', options => {
      const list = include(profileConfig('investigador', options));
      expect(list.length).toBeGreaterThan(0);
      for (const tool of FORBIDDEN) expect(list.filter(pattern => matches(pattern, tool))).toEqual([]);
      expect(list.some(pattern => matches(pattern, 'saleads_list_offerings'))).toBe(true);
    });

    it('las listas de origen tampoco', () => {
      for (const list of [SPECIALIST_SALEADS_INCLUDE, SPECIALISTS.investigador!.saleads]) expect(list.filter(pattern => matches(pattern, 'saleads_create_offering'))).toEqual([]);
    });

    it('la skill viaja solo al investigador y solo con bandera', () => {
      const path = 'profiles/investigador/skills/saleads-offer-kit/SKILL.md';
      expect(Object.keys(profileFiles(bundle(), [], {stock: true})).filter(name => name.includes('saleads-offer-kit'))).toEqual([path]);
      expect(Object.keys(profileFiles(bundle(), [], {})).filter(name => name.includes('saleads-offer-kit'))).toEqual([]);
    });
  });
});
