import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';
import {approve, count, createWorld, propose, say, seconds, seedVariant, stockIn, type World} from './support/stock-world';

/**
 * IVB-024: las consultas del banco E2E (`robot/banco/consultas/`) corren contra el esquema real y atrapan lo que deben.
 * `confirmation_id NOT NULL` ya lo impone la base: la prueba es el cruce con la propuesta, el método de §8 y el orden.
 */
const sql = (name: string) => readFileSync(join(__dirname, '..', 'robot', 'banco', 'consultas', name), 'utf8');
const fallas = async (world: World) =>
  (await world.db.query<{escritura: string; falla: string}>(sql('escrituras-sin-confirmacion.sql'), [null, world.businessId])).rows;

describe('consultas del banco E2E', () => {
  let db: TestDatabase;
  beforeAll(async () => {db = await startTestDatabase();});
  afterAll(async () => {await db.close();});

  it('un recorrido limpio (entrada en pantalla, conteo por voz) da cero fallas y el cruce lista cada escritura', async () => {
    const world = await createWorld(db);
    const variantId = await seedVariant(world);
    await stockIn(world, variantId, 24, '21000.00');
    const conteo = await count(world, variantId, 22);
    await say(world, 'sí', {recordedAt: seconds(1)});
    await world.stock.proposals.confirmByVoice(world.userId, world.businessId, conteo.id, conteo.revision, 'fiado');

    expect(await fallas(world)).toEqual([]);
    const cruce = (await world.db.query<{escritura: string; detalle: string; method: string; propuesta: string}>(sql('cruce-confirmaciones.sql'), [null, world.businessId])).rows;
    expect(cruce.map(r => [r.escritura, r.detalle, r.propuesta, r.method])).toEqual([
      ['movimiento', 'entrada', 'entrada', 'web'], ['movimiento', 'ajuste', 'conteo', 'voz']]);
    const saldo = (await world.db.query<{saldo: number}>(sql('saldo.sql'), [null, world.businessId])).rows;
    expect(saldo.map(r => r.saldo)).toEqual([22]);
  });

  it('el negativo en vivo: un conteo dicho y sin confirmar no mueve el saldo', async () => {
    const world = await createWorld(db);
    const variantId = await seedVariant(world);
    await stockIn(world, variantId, 24);
    await count(world, variantId, 22);
    const [fila] = (await world.db.query<{saldo: number; propuestas_pendientes: number}>(sql('saldo.sql'), [null, world.businessId])).rows;
    expect(fila).toMatchObject({saldo: 24, propuestas_pendientes: 1});
  });

  it('atrapa una venta confirmada por voz, un costo sin entrada y un nivel 3 efectivo', async () => {
    const world = await createWorld(db);
    const variantId = await seedVariant(world);
    await stockIn(world, variantId, 10);
    const venta = await propose(world, 'venta', {variante_id: variantId, cantidad: 1});
    const frase = await say(world, 'sí', {recordedAt: seconds(1)});
    const confirmacion = randomUUID();
    await world.db.query(`INSERT INTO assistant.stock_confirmations(id,proposal_id,business_id,method,actor,utterance_id,decision) VALUES ($1,$2,$3,'voz',$4,$5,'aprobada')`,
      [confirmacion, venta.id, world.businessId, world.userId, frase]);
    await world.db.query(`INSERT INTO assistant.stock_movements(id,business_id,variant_id,kind,delta,origin,confirmation_id,proposal_id,trace_id,occurred_at)
      VALUES ($1,$2,$3,'venta',-1,'voz',$4,$5,$6,now())`, [randomUUID(), world.businessId, variantId, confirmacion, venta.id, randomUUID()]);
    await seedVariant(world, 'Producto con costo puesto a mano', {unitCost: '9000.00'});
    await world.db.query(`INSERT INTO assistant.stock_autonomy(business_id,area,level) VALUES ($1,'reposicion',3)
      ON CONFLICT (business_id, area) DO UPDATE SET level = 3`, [world.businessId]);

    expect((await fallas(world)).map(f => [f.escritura, f.falla]).sort()).toEqual([
      ['autonomia', 'nivel efectivo 3 > 2'],
      ['costo_variante', 'unit_cost sin entrada confirmada en pantalla'],
      ['movimiento', 'método voz no permitido para venta'],
      ['propuesta_venta', 'resuelta por voz, solo vale web'],
    ]);
  });

  it('un conteo aprobado en pantalla también vale (§8: conteo por voz, canal o pantalla)', async () => {
    const world = await createWorld(db);
    const variantId = await seedVariant(world);
    const conteo = await count(world, variantId, 3);
    await approve(world, conteo, 'otra');
    expect(await fallas(world)).toEqual([]);
  });
});
