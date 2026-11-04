import {randomUUID} from 'node:crypto';
import {buildStock, stockSettings, type StockDeps, type StockRuntime} from '../../src/stock/module';
import type {StockDb, StockQuery} from '../../src/stock/store';
import type {Offering, OfferingRef} from '../../src/stock/offerings';
import type {TestDatabase} from './pglite-db';

/**
 * PGlite tiene una sola conexión: un candado en memoria impide que una consulta suelta caiga dentro de la transacción
 * de otro. Por eso aquí la concurrencia pasaría sola, y su prueba real está en `stock-postgres.real.spec.ts`.
 */
export function pgliteStockDb(test: TestDatabase): StockDb {
  const pool = test.database.pool;
  let chain: Promise<unknown> = Promise.resolve();
  const raw = pool.query.bind(pool) as StockQuery['query'];
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = chain.then(work, work);
    chain = run.catch(() => undefined);
    return run;
  };
  return {
    query: ((sql: string, params?: unknown[]) => serial(() => raw(sql, params))) as StockQuery['query'],
    tx: work => serial(async () => {
      await raw('BEGIN');
      try {
        const result = await work({query: raw});
        await raw('COMMIT');
        return result;
      } catch (error) {
        await raw('ROLLBACK');
        throw error;
      }
    }),
  };
}

export const key = (): string => randomUUID();

export interface World {
  stock: StockRuntime; db: StockDb; businessId: string; userId: string; offerings: {find: jest.Mock<Promise<Offering | null>, [string, string, OfferingRef]>};
  now: {value: Date};
}

export async function createWorld(test: TestDatabase, options: {bench?: boolean; maxAutonomy?: number; deps?: Partial<StockDeps>; senderName?: string;
  supplier?: {channel: 'banco' | 'telegram'; destination: string; token?: string}} = {}): Promise<World> {
  const businessId = randomUUID();
  const userId = `u-${randomUUID().slice(0, 8)}`;
  const db = pgliteStockDb(test);
  const now = {value: new Date('2026-11-01T10:00:00.000Z')};
  const offerings = {find: jest.fn(async (_user: string, _business: string, ref: OfferingRef) => ({...ref, name: 'Oferta'}) as Offering | null)};
  const settings = stockSettings({STOCK_ENABLED: true, STOCK_USER_IDS: [userId], STOCK_BUSINESS_SEEDS: [`${businessId}:${userId}:COP`], STOCK_WEB_BASE_URL: '',
    STOCK_BENCH_ENABLED: options.bench ?? false, STOCK_MAX_AUTONOMY_LEVEL: options.maxAutonomy ?? 2, STOCK_SUPPLIER_SENDER_NAME: options.senderName ?? '',
    ...(options.supplier ? {STOCK_SUPPLIER_CHANNEL: options.supplier.channel, STOCK_SUPPLIER_DESTINATION: options.supplier.destination, STOCK_SUPPLIER_TELEGRAM_TOKEN: options.supplier.token} : {})});
  const stock = (await buildStock(settings, {pool: test.database.pool, db, offerings, now: () => now.value, ...options.deps}))!;
  return {stock, db, businessId, userId, offerings, now};
}

export async function seedVariant(world: World, name = `Producto ${randomUUID().slice(0, 8)}`, options: {unitsPerBox?: number; unitCost?: string; kit?: boolean; runId?: string | null} = {}): Promise<string> {
  const [productId, variantId] = [randomUUID(), randomUUID()];
  await world.db.query(
    `INSERT INTO assistant.stock_products(id,business_id,user_id,name,normalized_name,offering_type,offering_id,offering_name,is_kit,occurred_at,simulated,run_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'Oferta',$8,now(),$9,$10)`,
    [productId, world.businessId, world.userId, name, name.toLowerCase(), options.kit ? null : 'product', options.kit ? null : 'o-1', options.kit ?? false, Boolean(options.runId), options.runId ?? null]);
  await world.db.query('INSERT INTO assistant.stock_variants(id,product_id,name,units_per_box,unit_cost,currency,is_kit) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [variantId, productId, '250 ml', options.unitsPerBox ?? null, options.unitCost ?? null, 'COP', options.kit ?? false]);
  return variantId;
}

export async function seedKit(world: World, parts: Array<[string, number]>): Promise<string> {
  const kit = await seedVariant(world, `Kit ${randomUUID().slice(0, 8)}`, {kit: true});
  for (const [variant, quantity] of parts) await world.db.query('INSERT INTO assistant.stock_kit_components VALUES ($1,$2,$3)', [kit, variant, quantity]);
  return kit;
}

export async function seedDocument(world: World, lines: Array<{variantId?: string; quantity: number; unitCost: string; description?: string; doubtful?: string[]}>, proveedor = 'Distribuidora', runId: string | null = null) {
  const documentId = randomUUID();
  await world.db.query(
    `INSERT INTO assistant.stock_documents(id,business_id,user_id,kind,content_type,sha256,channel,status,extraction,occurred_at,simulated,run_id) VALUES ($1,$2,$3,'factura','application/pdf',$4,'whatsapp','extraido',$5,now(),$6,$7)`,
    [documentId, world.businessId, world.userId, randomUUID().replace(/-/g, '').padEnd(64, '0'), JSON.stringify({proveedor: {nombre: proveedor}}), Boolean(runId), runId]);
  const lineas: Array<{linea_id: string; variante_id: string | null}> = [];
  for (const line of lines) {
    const id = randomUUID();
    await world.db.query('INSERT INTO assistant.stock_document_lines(id,document_id,description,quantity,unit_cost,doubtful) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, documentId, line.description ?? 'Producto', line.quantity, line.unitCost, JSON.stringify(line.doubtful ?? [])]);
    lineas.push({linea_id: id, variante_id: line.variantId ?? null});
  }
  return {documentId, lineas};
}

export const created = <T extends {estado: string}>(result: T) => {
  if (result.estado !== 'creada') throw new Error('sin propuesta');
  return (result as unknown as {propuesta: import('../../src/contracts/stock-v1').StockProposalV1}).propuesta;
};

export async function propose(world: World, kind: string, detalle: unknown) {
  return created(await world.stock.proposals.create(world.userId, world.businessId, 'stock', {idempotency_key: key(), kind, detalle}));
}

export async function approve(world: World, proposal: {id: string; revision: number}, causa?: 'venta' | 'fiado' | 'movimiento' | 'otra') {
  return world.stock.proposals.approveWeb({userId: world.userId}, world.businessId, proposal.id, proposal.revision, key(), causa);
}

/** Entra mercancía por el camino real: factura, propuesta y aprobación. */
export async function stockIn(world: World, variantId: string, quantity: number, unitCost = '1000.00') {
  const {documentId, lineas} = await seedDocument(world, [{variantId, quantity, unitCost}]);
  return approve(world, await propose(world, 'entrada', {document_id: documentId, lineas}));
}

export async function count(world: World, variantId: string, contado: number) {
  return propose(world, 'conteo', {variante_id: variantId, contado, origen: 'voz'});
}

export async function say(world: World, text: string, options: {recordedAt?: Date; userId?: string} = {}) {
  const id = randomUUID();
  // `now()` de PGlite tiene resolución de ms: en el mismo ms la frase no sería posterior a la propuesta.
  if (!options.recordedAt) await new Promise(resolve => setTimeout(resolve, 2));
  await world.db.query('INSERT INTO assistant.stock_owner_utterances(id,user_id,device_id,text,recorded_at) VALUES ($1,$2,$3,$4,COALESCE($5,now()))',
    [id, options.userId ?? world.userId, randomUUID(), text, options.recordedAt ?? null]);
  return id;
}

export const seconds = (value: number): Date => new Date(Date.now() + value * 1000);
