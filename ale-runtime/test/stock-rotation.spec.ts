import {randomUUID} from 'node:crypto';
import {STOCK_PROFILE_TOOLS} from '../src/activation/profiles';
import {betReach, hotSignal, rotationState, saleRhythm, type SaleMark} from '../src/stock/rotation';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';
import {approve, count, createWorld, key, propose, seedDocument, seedKit, seedVariant, stockIn, type World} from './support/stock-world';

const NOW = new Date('2027-08-27T10:00:00.000Z');
const DAY = 86_400_000;
const OFFER = randomUUID();
const ago = (days: number): Date => new Date(NOW.getTime() - days * DAY);
/** `units` a la semana, en días fijos hacia atrás desde `first`. */
const weekly = (weeks: number, units: number, first = 8): SaleMark[] => Array.from({length: weeks}, (_, index) => ({at: ago(first + index * 7), units}));

describe('saleRhythm y rotationState: umbrales de architecture.md §13', () => {
  const state = (sales: SaleMark[], options: {activa?: boolean | 'desconocido'; coverage?: number | null} = {}) => {
    const rhythm = saleRhythm(sales, NOW);
    return rotationState({rhythm, base: rhythm.base, activa: options.activa ?? 'desconocido', coverage: options.coverage ?? null});
  };

  it('sin_datos con 3 semanas con ventas; con 4 ya clasifica', () => {
    expect(state(weekly(3, 5))).toBe('sin_datos');
    expect(state(weekly(4, 5))).toBe('frenazo');
  });

  it('frenazo con base 2 y 7 días en cero; con base 1,875 o venta en la ventana no', () => {
    expect(state(weekly(8, 2))).toBe('frenazo');
    expect(state([...weekly(7, 2), {at: ago(57), units: 1}])).toBe('sano');
    expect(state([...weekly(8, 2), {at: ago(1), units: 1}])).toBe('sano');
  });

  it('la ventana son 7 días exactos: una venta hace 6,9 días no es frenazo y una hace 7 sí', () => {
    expect(state([...weekly(8, 2, 8), {at: ago(6.9), units: 1}])).toBe('sano');
    expect(state(weekly(8, 2, 7))).toBe('frenazo');
  });

  it('lento bajo 1 por semana durante 8 semanas; con 1 exacto o con menos historia no', () => {
    expect(state([...weekly(4, 1), ...weekly(3, 1, 43)])).toBe('lento');
    expect(state(weekly(8, 1))).toBe('sano');
    // Producto nuevo: 4 unidades en 6 semanas no son 8 semanas de evidencia.
    expect(state([{at: ago(8), units: 1}, {at: ago(15), units: 1}, {at: ago(29), units: 1}, {at: ago(43), units: 1}])).toBe('sano');
  });

  it('un producto de 1 por semana con 5 semanas de vida tiene base 1, no 5/8', () => {
    expect(saleRhythm(weekly(5, 1), NOW).base).toBe(1);
  });

  it('sin_pauta exige pauta false confirmada y cobertura sobre 45 días', () => {
    const healthy = [...weekly(8, 2), {at: ago(1), units: 7}];
    expect(state(healthy, {activa: false, coverage: 46})).toBe('sin_pauta');
    expect(state(healthy, {activa: false, coverage: 45})).toBe('sano');
    expect(state(healthy, {activa: 'desconocido', coverage: 46})).toBe('sano');
    expect(state(healthy, {activa: true, coverage: 46})).toBe('sano');
    expect(state(healthy, {activa: false, coverage: null})).toBe('sano');
    expect(state([...weekly(4, 1), ...weekly(3, 1, 43), {at: ago(1), units: 1}], {activa: false, coverage: 46})).toBe('lento');
  });

  it('R18: una parada en curso no baja la base y el frenazo no se vuelve sano en la semana dos ni tres', () => {
    for (const first of [15, 22]) {
      expect(saleRhythm(weekly(8, 2, first), NOW).base).toBe(2);
      expect(state(weekly(8, 2, first))).toBe('frenazo');
    }
  });

  it('tras más de 8 semanas de silencio la base llega a 0 y el frenazo pasa a lento', () => {
    expect(state(weekly(8, 2, 57))).toBe('frenazo');
    expect(state(weekly(8, 2, 64))).toBe('lento');
  });

  it('frenazo relativo al ritmo propio: quien vende cada 14 días no está frenado al día 13 y sí al 14', () => {
    const lumps = (first: number): SaleMark[] => Array.from({length: 5}, (_, index) => ({at: ago(first + index * 14), units: 8}));
    expect(state(lumps(13))).toBe('sano');
    expect(state(lumps(14))).toBe('frenazo');
  });

  it('una semana en cero en medio de la historia cuenta en el promedio: no se puede saltar sin perder lento', () => {
    expect(saleRhythm([...weekly(2, 2), ...weekly(5, 2, 29)], NOW).base).toBe(1.75);
  });
});

describe('betReach: R22', () => {
  it('saldo 42, 14 por semana, 30 días: faltan 18, alcanzan 21 días, 9,8 por semana y 70 % del presupuesto', () => {
    expect(betReach({saldo: 42, unidadesSemana: 14, dias: 30, presupuestoDiario: '50000.00'})).toEqual({
      estado: 'no_alcanza', unidades_necesarias: 60, unidades_disponibles: 42, dias_alcanza: 21, unidades_semana_alcanzables: 9.8, presupuesto_diario_proporcional: '35000.00',
    });
  });

  it('justo lo que alcanza no pide bajar; una unidad menos sí', () => {
    expect(betReach({saldo: 60, unidadesSemana: 14, dias: 30, presupuestoDiario: '50000.00'})).toMatchObject({estado: 'alcanza', presupuesto_diario_proporcional: null});
    expect(betReach({saldo: 59, unidadesSemana: 14, dias: 30, presupuestoDiario: '50000.00'}).estado).toBe('no_alcanza');
  });

  it('sin unidades previstas responde sin_dato y no inventa', () => {
    expect(betReach({saldo: 42, unidadesSemana: null, dias: 30, presupuestoDiario: '50000.00'})).toMatchObject({estado: 'sin_dato', unidades_necesarias: null, presupuesto_diario_proporcional: null});
  });
});

describe('hotSignal: «pegando» (IVB-024)', () => {
  const hot = (sales: SaleMark[], extra: Partial<Parameters<typeof hotSignal>[0]> = {}) =>
    hotSignal({sales, now: NOW, betStart: ago(3), previstas: 20, base: 6, saldo: 42, ...extra});

  it('9 ventas en 2 días contra 20 previstas: 31,5 por semana pega, con su motivo y cobertura al ritmo actual', () => {
    expect(hot([{at: ago(1.5), units: 4}, {at: ago(0.5), units: 5}])).toEqual({
      pegando: true, ritmo_actual_semana: 31.5, dias_cobertura_al_ritmo_actual: 9.3,
      motivo_pegando: 'Con la pauta vende a 31,5 por semana en los últimos 2 días, al menos 1,5 veces las 20 previstas por semana.',
    });
  });

  it('justo 1,5 veces pega y una unidad menos no; lo de antes de la ventana no cuenta', () => {
    const flat = (units: number): SaleMark[] => [{at: ago(1), units}, {at: ago(2.5), units: 50}];
    expect(hot(flat(9), {previstas: 21})).toMatchObject({pegando: true, ritmo_actual_semana: 31.5});
    expect(hot(flat(8), {previstas: 21})).toMatchObject({pegando: false, ritmo_actual_semana: 28, motivo_pegando: null});
  });

  it('solo cuentan las ventas desde el inicio de la apuesta, y unas horas de pauta no se proyectan a la semana', () => {
    const sales = [{at: ago(1.5), units: 10}, {at: ago(0.1), units: 3}];
    expect(hot(sales, {betStart: ago(0.5)})).toMatchObject({pegando: false, ritmo_actual_semana: 10.5});
    expect(hot(sales, {betStart: ago(2)})).toMatchObject({pegando: true, ritmo_actual_semana: 45.5});
  });

  it('sin previsión compara contra 1,5 veces la base, y lo dice', () => {
    const sales = [{at: ago(1), units: 3}];
    expect(hot(sales, {previstas: null, base: 6})).toMatchObject({pegando: true, ritmo_actual_semana: 10.5,
      motivo_pegando: 'Con la pauta vende a 10,5 por semana en los últimos 2 días, al menos 1,5 veces el ritmo base de 6 por semana (la apuesta no trae previsión).'});
    expect(hot(sales, {previstas: null, base: 8})).toMatchObject({pegando: false});
  });

  it('una sola venta no es tendencia aunque la base sea 0', () => {
    expect(hot([{at: ago(1), units: 1}], {previstas: null, base: 0})).toMatchObject({pegando: false, ritmo_actual_semana: 3.5});
    expect(hot([{at: ago(1), units: 2}], {previstas: null, base: 0})).toMatchObject({pegando: true, ritmo_actual_semana: 7});
  });

  it('sin apuesta aprobada nunca pega, pero el ritmo y la cobertura se informan; sin ventas la cobertura es nula', () => {
    expect(hot([{at: ago(1), units: 40}], {betStart: null})).toEqual({pegando: false, ritmo_actual_semana: 140, motivo_pegando: null, dias_cobertura_al_ritmo_actual: 2.1});
    expect(hot([])).toEqual({pegando: false, ritmo_actual_semana: 0, motivo_pegando: null, dias_cobertura_al_ritmo_actual: null});
  });
});

describe('Rotation contra el libro', () => {
  let db: TestDatabase;
  let world: World;

  beforeAll(async () => {db = await startTestDatabase();});
  afterAll(async () => {await db.close();});
  beforeEach(async () => {world = await createWorld(db, {bench: true});});

  const at = (date: Date) => {world.now.value = date;};
  const stocked = async (quantity = 300): Promise<string> => {
    at(ago(90));
    const variantId = await seedVariant(world, undefined, {unitCost: '17000.00'});
    await stockIn(world, variantId, quantity, '17000.00');
    return variantId;
  };
  const sell = async (variantId: string, daysAgo: number, cantidad: number) => {
    at(ago(daysAgo));
    await approve(world, await propose(world, 'venta', {variante_id: variantId, cantidad}));
  };
  const reconcile = async (variantId: string, daysAgo: number, contado: number, causa: 'venta' | 'fiado' | 'movimiento') => {
    at(ago(daysAgo));
    await approve(world, await count(world, variantId, contado), causa);
  };
  const signal = (variantId: string, when = NOW) => {
    at(when);
    return world.stock.rotation.signal(world.userId, world.businessId, variantId);
  };
  const betDetail = (variantId: string, extra: Record<string, unknown> = {}) => ({
    variante_id: variantId, presupuesto_diario: '50000.00', tope: '350000.00', duracion_dias: 30, unidades_semana_previstas: 14, fuente_prevision: 'supuesto', ...extra,
  });
  const twoPerWeek = async (variantId: string) => {
    for (let week = 7; week >= 0; week--) await sell(variantId, 8 + week * 7, 2);
  };
  const scalar = async (sql: string, ...params: unknown[]) => (await world.db.query<{n: number}>(sql, params)).rows[0]!.n;

  it('R18: 2 por semana durante 8 semanas y 7 días en cero da frenazo, nunca lento', async () => {
    const variantId = await stocked();
    await twoPerWeek(variantId);
    expect((await signal(variantId)).ritmo).toEqual({base_semanal: 2, actual_semanal: 0, estado: 'frenazo'});
    await sell(variantId, 2, 1);
    expect((await signal(variantId)).ritmo!.estado).toBe('sano');
  });

  it('R18: ventas que solo llegan por conteo con causa venta cuentan, y dentro de su cadencia no es frenazo', async () => {
    const variantId = await stocked();
    let left = 300;
    for (const daysAgo of [65, 51, 37, 23, 9]) await reconcile(variantId, daysAgo, left -= 8, 'venta');
    const signalled = await signal(variantId);
    expect(signalled.ritmo!.base_semanal).toBeGreaterThanOrEqual(2);
    expect(signalled.ritmo!.estado).toBe('sano');
    expect((await signal(variantId, new Date(ago(9).getTime() + 14 * DAY))).ritmo!.estado).toBe('frenazo');
  });

  it('R18: fiado y movimiento no suben el ritmo', async () => {
    const [sold, credited] = [await stocked(), await stocked()];
    for (const [index, daysAgo] of [36, 29, 22, 15, 8].entries()) {
      await reconcile(sold, daysAgo, 300 - (index + 1) * 5, 'venta');
      await reconcile(credited, daysAgo, 300 - (index + 1) * 5, index % 2 ? 'fiado' : 'movimiento');
    }
    expect((await signal(sold)).ritmo!.base_semanal).toBeGreaterThan(0);
    expect((await signal(credited)).ritmo).toEqual({base_semanal: 0, actual_semanal: 0, estado: 'sin_datos'});
  });

  it('un ajuste positivo con causa venta no es una venta', async () => {
    const variantId = await stocked(10);
    await reconcile(variantId, 8, 14, 'venta');
    expect((await signal(variantId)).ritmo!.base_semanal).toBe(0);
  });

  it('R17: aprobar congela la base; ventas nuevas no la mueven y al terminar la apuesta vuelve a calcularse', async () => {
    const variantId = await stocked();
    await twoPerWeek(variantId);
    at(ago(7));
    await approve(world, await propose(world, 'apuesta', betDetail(variantId, {duracion_dias: 20})));
    const [frozen] = (await world.db.query<{weekly_rate: string; before_bet: boolean}>('SELECT weekly_rate, before_bet FROM assistant.stock_rotation_baselines WHERE variant_id = $1', [variantId])).rows;
    expect(frozen).toMatchObject({before_bet: true});
    expect(Number(frozen!.weekly_rate)).toBe(2);
    await sell(variantId, 6, 30);
    await sell(variantId, 1, 30);
    // A los 8 días esas ventas ya salieron de la ventana: sin congelar entrarían a la base.
    expect((await signal(variantId, new Date(NOW.getTime() + 8 * DAY))).ritmo!.base_semanal).toBe(2);
    expect((await signal(variantId, new Date(ago(7).getTime() + 21 * DAY))).ritmo!.base_semanal).not.toBe(2);
  });

  describe('R19: sin stock no hay propuesta', () => {
    const rows = () => scalar(`SELECT count(*)::int AS n FROM assistant.stock_proposals WHERE business_id = $1 AND kind = 'apuesta'`, world.businessId);

    it('sin unidades: indicador falso, 409 al proponer y ninguna fila', async () => {
      const variantId = await seedVariant(world);
      expect(await signal(variantId)).toMatchObject({se_puede_pautar: false, motivo_no: 'sin_stock'});
      await expect(world.stock.proposals.create(world.userId, world.businessId, 'ale', {idempotency_key: key(), kind: 'apuesta', detalle: betDetail(variantId)})).rejects.toMatchObject({code: 'CONFLICT'});
      expect(await rows()).toBe(0);
    });

    it('variante inexistente o de otro negocio: se responde sin_producto y da 409', async () => {
      const other = await createWorld(db);
      const foreign = await seedVariant(other);
      for (const variantId of [randomUUID(), foreign]) {
        expect(await signal(variantId)).toMatchObject({variante_id: variantId, stock: null, ritmo: null, se_puede_pautar: false, motivo_no: 'sin_producto'});
        await expect(world.stock.proposals.create(world.userId, world.businessId, 'ale', {idempotency_key: key(), kind: 'apuesta', detalle: betDetail(variantId)})).rejects.toMatchObject({code: 'CONFLICT'});
      }
      expect(await rows()).toBe(0);
    });

    it('id de producto o de oferta: sigue sin_producto en la compuerta, pero la señal dice qué variante usar (IVB-023)', async () => {
      const variantId = await stocked(15);
      const {rows} = await world.db.query<{product_id: string}>('SELECT product_id FROM assistant.stock_variants WHERE id = $1', [variantId]);
      const productId = rows[0]!.product_id;
      await world.db.query(`UPDATE assistant.stock_products SET offering_id = $2 WHERE id = $1`, [productId, OFFER]);
      const byProduct = await signal(productId);
      expect(byProduct).toMatchObject({stock: null, se_puede_pautar: false, motivo_no: 'id_de_producto', variantes: [{variante_id: variantId}]});
      expect(await signal(OFFER)).toMatchObject({stock: null, motivo_no: 'id_de_oferta', variantes: [{variante_id: variantId}]});
      expect(await signal(variantId)).toMatchObject({stock: {saldo: 15}, se_puede_pautar: true});
      await expect(world.stock.proposals.create(world.userId, world.businessId, 'ale', {idempotency_key: key(), kind: 'apuesta', detalle: betDetail(productId)})).rejects.toMatchObject({code: 'CONFLICT'});
      const other = await createWorld(db);
      const foreign = await seedVariant(other);
      const {rows: theirs} = await other.db.query<{product_id: string}>('SELECT product_id FROM assistant.stock_variants WHERE id = $1', [foreign]);
      const leaked = await signal(theirs[0]!.product_id);
      expect(leaked.motivo_no).toBe('sin_producto');
      expect(leaked).not.toHaveProperty('variantes');
    });

    it('con unidades, la misma compuerta deja pasar', async () => {
      const variantId = await stocked(5);
      expect(await signal(variantId)).toMatchObject({se_puede_pautar: true, motivo_no: null});
      await propose(world, 'apuesta', betDetail(variantId));
      expect(await rows()).toBe(1);
    });

    it('un kit se mide por lo que alcanzan sus componentes, y su venta cuenta una vez', async () => {
      const [a, b] = [await stocked(10), await stocked(10)];
      const kit = await seedKit(world, [[a, 1], [b, 2]]);
      expect((await signal(kit)).stock).toEqual({saldo: 5, esperado: 5, ultimo_conteo_en: null});
      await sell(kit, 1, 2);
      expect((await signal(kit)).ritmo!.actual_semanal).toBe(2);
      expect((await signal(b)).ritmo!.actual_semanal).toBe(4);
      const empty = await seedKit(world, [[await seedVariant(world), 1]]);
      expect(await signal(empty)).toMatchObject({se_puede_pautar: false, motivo_no: 'sin_stock'});
    });

    it('una variante unida responde por su canónica', async () => {
      const canonical = await stocked(7);
      const alias = await seedVariant(world);
      await approve(world, await propose(world, 'union_catalogo', {origen_id: alias, destino_id: canonical}));
      expect(await signal(alias)).toMatchObject({variante_id: canonical, stock: {saldo: 7}, se_puede_pautar: true});
    });
  });

  it('ritmo vigente 0: cobertura nula con motivo, sin error', async () => {
    const variantId = await stocked(42);
    expect(await signal(variantId)).toMatchObject({cobertura_dias: null, motivo_cobertura: 'sin_ritmo'});
  });

  it('cobertura = saldo / ((actual + unidades previstas) / 7), y sin apuesta no cuenta previsión', async () => {
    const variantId = await stocked(42);
    await sell(variantId, 1, 7);
    expect((await signal(variantId)).cobertura_dias).toBe(35);
    await propose(world, 'apuesta', betDetail(variantId, {unidades_semana_previstas: 14}));
    expect(await signal(variantId)).toMatchObject({cobertura_dias: 11.7, motivo_cobertura: null});
  });

  it('R22: la señal de la apuesta vigente trae las cifras, y sin unidades previstas dice sin_dato', async () => {
    const variantId = await stocked(42);
    at(NOW);
    const bet = await propose(world, 'apuesta', betDetail(variantId));
    expect(bet.motivo).toContain('hay 42 y se prevén 60');
    expect((await signal(variantId)).alcance_pauta).toEqual({apuesta_id: bet.id, estado: 'no_alcanza', unidades_necesarias: 60, unidades_disponibles: 42, dias_alcanza: 21, unidades_semana_alcanzables: 9.8, presupuesto_diario_proporcional: '35000.00'});
    const unknown = await stocked(42);
    at(NOW);
    const blind = await propose(world, 'apuesta', betDetail(unknown, {unidades_semana_previstas: null}));
    expect(blind.motivo).toContain('Sin unidades previstas');
    expect((await signal(unknown)).alcance_pauta!.estado).toBe('sin_dato');
  });

  it('R20: la apuesta lleva presupuesto y tope, aprobar no crea campaña ni evento y solo bench_campaign la prende, simulada', async () => {
    const runId = randomUUID();
    await world.db.query(`INSERT INTO assistant.stock_runs(id, business_id, name, seed, status) VALUES ($1, $2, 'r', 's', 'activo')`, [runId, world.businessId]);
    const variantId = await seedVariant(world, undefined, {runId});
    const {documentId, lineas} = await seedDocument(world, [{variantId, quantity: 40, unitCost: '17000.00'}], 'Distribuidora', runId);
    await approve(world, await propose(world, 'entrada', {document_id: documentId, lineas}));
    const bet = await propose(world, 'apuesta', betDetail(variantId));
    if (bet.tipo !== 'apuesta') throw new Error('tipo');
    expect(bet.detalle).toMatchObject({presupuesto_diario: '50000.00', tope: '350000.00', senal: {saldo: 40, esperado: 40}});
    const campaigns = () => scalar('SELECT count(*)::int AS n FROM assistant.stock_sim_campaigns WHERE business_id = $1', world.businessId);
    const events = () => scalar('SELECT count(*)::int AS n FROM assistant.stock_robot_events WHERE business_id = $1', world.businessId);
    const before = await events();
    await approve(world, bet);
    expect([await campaigns(), await events()]).toEqual([0, before]);
    expect((await signal(variantId)).pauta).toEqual({activa: false, simulado: true, presupuesto_diario: null, senales: null});

    const sent: unknown[] = [];
    const response = {status: () => response, setHeader: () => response, json: (body: unknown) => sent.push(body)};
    await world.stock.deviceOps.handle({userId: world.userId, deviceId: 'd-1'} as never, {op: 'bench_campaign', proposal_id: bet.id, senales: {gasto: 12000, mensajes: 3}, run_id: runId}, response as never);
    expect(sent[0]).toMatchObject({ok: true, simulado: true});
    expect(await campaigns()).toBe(1);
    await sell(variantId, -0.5, 5);
    const followed = await signal(variantId, new Date(NOW.getTime() + DAY));
    expect(followed.pauta).toEqual({activa: true, simulado: true, presupuesto_diario: '50000.00', senales: {gasto: 12000, mensajes: 3}});
    // R21: las tres señales, cada una marcada.
    expect(followed.seguimiento).toMatchObject({
      pauta: {gasto: 12000, mensajes: 3, simulado: true}, ventas_reportadas: {unidades: 5, simulado: true}, salida_inventario: {unidades: 5, simulado: true},
    });
    expect(followed.datos_simulados).toEqual(['stock', 'ventas', 'pauta']);
  });

  it('R21: en datos reales la pauta es desconocida, sin ceros inventados; salida incluye lo que no es venta', async () => {
    const variantId = await stocked();
    await sell(variantId, 6, 9);
    at(ago(5));
    await approve(world, await propose(world, 'apuesta', betDetail(variantId)));
    await sell(variantId, 3, 4);
    await reconcile(variantId, 2, 281, 'fiado');
    const followed = await signal(variantId);
    expect(followed.pauta).toEqual({activa: 'desconocido', simulado: false, presupuesto_diario: null, senales: null});
    expect(followed.seguimiento).toMatchObject({pauta: null, ventas_reportadas: {unidades: 4, simulado: false}, salida_inventario: {unidades: 10, simulado: false}});
    expect(followed.datos_simulados).toEqual([]);
  });

  it('pegando (IVB-024): la apuesta aprobada que vende 1,5 veces lo previsto pega; la pendiente no, y fiado no suma', async () => {
    const variantId = await stocked(60);
    await sell(variantId, 20, 2);
    at(ago(2.5));
    const bet = await propose(world, 'apuesta', betDetail(variantId, {unidades_semana_previstas: 20, duracion_dias: 7}));
    await sell(variantId, 1.5, 4);
    await sell(variantId, 0.5, 5);
    expect(await signal(variantId)).toMatchObject({pegando: false, ritmo_actual_semana: 31.5, motivo_pegando: null});
    at(ago(2.4));
    await approve(world, bet);
    await reconcile(variantId, 0.2, 40, 'fiado');
    const hot = await signal(variantId);
    expect(hot).toMatchObject({pegando: true, ritmo_actual_semana: 31.5, dias_cobertura_al_ritmo_actual: 8.9});
    expect(hot.motivo_pegando).toContain('20 previstas');
    // Al terminar la apuesta ya no pega, aunque el ritmo siga.
    expect(await signal(variantId, new Date(ago(2.4).getTime() + 7 * DAY + 1))).toMatchObject({pegando: false});
  });

  it('pegando sin previsión compara con la base congelada; variante inexistente responde falso y nulos', async () => {
    const variantId = await stocked();
    await twoPerWeek(variantId);
    at(ago(3));
    await approve(world, await propose(world, 'apuesta', betDetail(variantId, {unidades_semana_previstas: null})));
    await sell(variantId, 1, 1);
    expect(await signal(variantId)).toMatchObject({pegando: false, ritmo_actual_semana: 3.5});
    await sell(variantId, 0.5, 1);
    expect(await signal(variantId)).toMatchObject({pegando: true, ritmo_actual_semana: 7});
    expect((await signal(variantId)).motivo_pegando).toContain('ritmo base de 2 por semana');
    expect(await signal(randomUUID())).toMatchObject({pegando: false, ritmo_actual_semana: 0, motivo_pegando: null, dias_cobertura_al_ritmo_actual: null});
  });

  it('sin apuesta aprobada no hay seguimiento', async () => {
    expect((await signal(await stocked())).seguimiento).toBeNull();
  });

  it('toda salida usa el reloj del negocio: saltar el reloj convierte lo sano en frenazo', async () => {
    const variantId = await stocked();
    await twoPerWeek(variantId);
    await sell(variantId, 1, 2);
    expect((await signal(variantId)).ritmo!.estado).toBe('sano');
    await world.db.query(`INSERT INTO assistant.stock_clock_offsets(business_id, offset_seconds, updated_by) VALUES ($1, $2, 'prueba')`, [world.businessId, 7 * 86_400]);
    expect((await signal(variantId)).ritmo).toMatchObject({estado: 'frenazo', actual_semanal: 0});
  });

  describe('margen', () => {
    it('sale del precio de la oferta ligada', async () => {
      const variantId = await stocked();
      world.offerings.find.mockResolvedValue({type: 'product', id: 'o-1', name: 'Oferta', price: 29000, currency: 'COP'});
      expect((await signal(variantId)).margen).toEqual({dinero: '12000.00', pct: 41});
    });

    it('un precio bajo el costo se muestra negativo', async () => {
      const variantId = await stocked();
      world.offerings.find.mockResolvedValue({type: 'product', id: 'o-1', name: 'Oferta', price: 10000, currency: 'COP'});
      expect((await signal(variantId)).margen).toEqual({dinero: '-7000.00', pct: -70});
    });

    it.each([
      ['oferta sin precio', async () => ({type: 'product' as const, id: 'o-1', name: 'x', price: null})],
      ['otra moneda', async () => ({type: 'product' as const, id: 'o-1', name: 'x', price: 29000, currency: 'USD'})],
      ['oferta borrada', async () => null],
      ['lectura caída', async () => {throw new Error('caído');}],
    ])('con %s es nulo y la señal sigue', async (_name, find) => {
      const variantId = await stocked();
      world.offerings.find.mockImplementation(find);
      expect(await signal(variantId)).toMatchObject({margen: null, se_puede_pautar: true});
    });

    it('sin costo o sin oferta ni se consulta', async () => {
      const noCost = await seedVariant(world);
      const kit = await seedKit(world, [[await stocked(), 1]]);
      world.offerings.find.mockClear();
      expect((await signal(noCost)).margen).toBeNull();
      expect((await signal(kit)).margen).toBeNull();
      expect(world.offerings.find).not.toHaveBeenCalled();
    });
  });

  it('el costo dice su fuente, y sin costo lo dice', async () => {
    expect((await signal(await stocked())).costo).toEqual({unitario: '17000.00', moneda: 'COP', fuente: 'factura'});
    expect((await signal(await seedVariant(world))).costo).toEqual({unitario: null, moneda: 'COP', fuente: 'sin_dato'});
  });

  it('alerts entrega solo novedades para el ciclo', async () => {
    const [stopped, fine] = [await stocked(), await stocked()];
    await twoPerWeek(stopped);
    await twoPerWeek(fine);
    await sell(fine, 1, 2);
    await seedVariant(world);
    at(NOW);
    expect(await world.stock.rotation.alerts(world.businessId)).toEqual([expect.objectContaining({variante_id: stopped, estado: 'frenazo', base_semanal: 2, actual_semanal: 0, saldo: 284})]);
  });
});

describe('R36', () => {
  it('lanzar y aprobar quedan fuera de la lista exacta del perfil Stock, y esa lista conserva la señal', () => {
    expect(STOCK_PROFILE_TOOLS.filter(tool => /launch|approve/.test(tool))).toEqual([]);
    expect(STOCK_PROFILE_TOOLS).toContain('saleads_stock_get_bet_signal');
  });
});
