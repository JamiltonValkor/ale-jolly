import type {Pool} from 'pg';
import {serviceUnavailable} from '../domain/errors';

export interface StockQuery {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{rows: T[]; rowCount: number | null}>;
}
/** Consultas sueltas y transacciones. El libro exige una sola conexión por transacción para sus candados. */
export interface StockDb extends StockQuery {tx<T>(work: (tx: StockQuery) => Promise<T>): Promise<T>}

type PoolLike = Pick<Pool, 'query'> & Partial<Pick<Pool, 'connect'>>;

export function poolStockDb(pool: PoolLike): StockDb {
  const query = pool.query.bind(pool) as StockQuery['query'];
  return {
    query,
    async tx(work) {
      // `Database` solo expone query/end; el Pool real también tiene connect. Sin él no hay transacción: falla cerrado.
      if (!pool.connect) throw serviceUnavailable();
      const client = await pool.connect();
      let failure: unknown;
      try {
        await client.query('BEGIN');
        const result = await work(client as unknown as StockQuery);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        failure = error;
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release(failure instanceof Error && /terminat|connection/i.test(failure.message) ? failure : undefined);
      }
    },
  };
}

let savepoints = 0;

/**
 * Una transacción abierta vista como `StockDb`: cada `tx` interno es un SAVEPOINT. Sirve para que una operación que ya
 * abre sus propias transacciones (crear y aprobar propuestas) quede entera dentro de otra: si algo falla, no queda nada.
 */
export function nestedStockDb(q: StockQuery): StockDb {
  return {
    query: q.query.bind(q) as StockQuery['query'],
    async tx(work) {
      const name = `stock_sp_${++savepoints}`;
      await q.query(`SAVEPOINT ${name}`);
      try {
        const result = await work(q);
        await q.query(`RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (error) {
        await q.query(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => undefined);
        throw error;
      }
    },
  };
}

/** El run activo decide qué filas existen: nunca se mezclan datos de una corrida con los reales. */
export async function activeRun(q: StockQuery, businessId: string): Promise<string | null> {
  const {rows} = await q.query<{id: string}>(`SELECT id FROM assistant.stock_runs WHERE business_id = $1 AND status = 'activo'`, [businessId]);
  return rows[0]?.id ?? null;
}

export interface VariantRow {
  id: string; product_id: string; product_name: string; variant_name: string; units_per_box: number | null; unit_cost: string | null;
  sale_price: string | null; currency: string; is_kit: boolean; simulated: boolean;
}

/** Variante del negocio y del run vigente. Lo ajeno y lo inexistente son igual de invisibles. */
export async function findVariant(q: StockQuery, businessId: string, variantId: string, runId: string | null): Promise<VariantRow | null> {
  const {rows} = await q.query<VariantRow>(
    `SELECT v.id, v.product_id, p.name AS product_name, v.name AS variant_name, v.units_per_box, v.unit_cost, v.sale_price, v.currency, v.is_kit, p.simulated
       FROM assistant.stock_variants v JOIN assistant.stock_products p ON p.id = v.product_id
      WHERE v.id = $1 AND p.business_id = $2 AND p.run_id IS NOT DISTINCT FROM $3`, [variantId, businessId, runId]);
  return rows[0] ?? null;
}

export async function businessCurrency(q: StockQuery, businessId: string): Promise<string> {
  const {rows} = await q.query<{currency: string}>('SELECT currency FROM assistant.stock_enabled_businesses WHERE business_id = $1', [businessId]);
  if (!rows[0]) throw serviceUnavailable();
  return rows[0].currency;
}

export function normalizeName(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9ñ]+/g, ' ').trim();
}

const trigrams = (value: string): Set<string> => {
  const grams = new Set<string>();
  for (const word of normalizeName(value).split(' ').filter(Boolean)) {
    const padded = `  ${word} `;
    for (let index = 0; index + 3 <= padded.length; index++) grams.add(padded.slice(index, index + 3));
  }
  return grams;
};

/** Similitud por trigramas, en memoria y sin extensión de base (R7). */
export function nameSimilarity(a: string, b: string): number {
  const [left, right] = [trigrams(a), trigrams(b)];
  if (!left.size || !right.size) return 0;
  const shared = [...left].filter(gram => right.has(gram)).length;
  return shared / (left.size + right.size - shared);
}

/** Formato y control no se ven en pantalla ni los lee una persona: en texto de terceros solo sirven para esconder algo. */
export const withoutHidden = (text: string): string => text.replace(/\p{Cf}/gu, '').replace(/\p{Cc}/gu, ' ');
