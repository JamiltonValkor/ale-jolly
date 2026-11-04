import {randomUUID} from 'node:crypto';
import {stockNegative} from '../domain/errors';
import {writeAudit} from './audit';
import type {StockQuery} from './store';

export interface StockLedger {
  balance(businessId: string, variantId: string, runId: string | null): Promise<number>;
  balanceAt(businessId: string, variantId: string, runId: string | null, at: Date): Promise<number>;
  expected(businessId: string, variantId: string, runId: string | null): Promise<ExpectedStock>;
}
export interface ExpectedStock {expected: number; lastCount: number | null; lastCountAt: Date | null; inbound: number; returned: number; sold: number}

export interface MovementInput {
  businessId: string; variantId: string; kind: 'entrada' | 'venta' | 'ajuste' | 'devolucion'; delta: number; occurredAt: Date; origin: string;
  confirmationId: string; proposalId: string; traceId: string; actor: string; runId: string | null; simulated: boolean;
  unitCost?: string | null; currency?: string | null; cause?: string | null; orderId?: string | null; kitVariantId?: string | null;
}

/** Saldo insuficiente de una variante: viaja hasta fuera de la transacción para dejar el conteo sugerido. */
export class StockNegativeError extends Error {
  readonly serviceError = stockNegative();
  constructor(readonly variantId: string) {super('STOCK_NEGATIVE');}
}

/** Destino final de una variante unida. Un alias nunca toca movimientos: solo cambia cómo se suman. */
export async function canonicalOf(q: StockQuery, variantId: string): Promise<string> {
  const {rows} = await q.query<{id: string}>(
    `WITH RECURSIVE up(id) AS (
       SELECT $1::uuid
       UNION SELECT a.canonical_variant_id FROM assistant.stock_variant_aliases a JOIN up ON a.alias_variant_id = up.id
     ) SELECT id FROM up WHERE id NOT IN (SELECT alias_variant_id FROM assistant.stock_variant_aliases)`, [variantId]);
  return rows[0]?.id ?? variantId;
}

/** La variante canónica y todo lo que se unió a ella. */
export async function variantGroup(q: StockQuery, variantId: string): Promise<string[]> {
  const canonical = await canonicalOf(q, variantId);
  const {rows} = await q.query<{id: string}>(
    `WITH RECURSIVE down(id) AS (
       SELECT $1::uuid
       UNION SELECT a.alias_variant_id FROM assistant.stock_variant_aliases a JOIN down ON a.canonical_variant_id = down.id
     ) SELECT id FROM down`, [canonical]);
  return rows.map(row => row.id);
}

async function sumDelta(q: StockQuery, businessId: string, group: string[], runId: string | null, at: Date | null): Promise<number> {
  const {rows} = await q.query<{saldo: number}>(
    `SELECT COALESCE(sum(delta), 0)::int AS saldo FROM assistant.stock_movements
      WHERE business_id = $1 AND variant_id = ANY($2::uuid[]) AND run_id IS NOT DISTINCT FROM $3
        AND ($4::timestamptz IS NULL OR occurred_at <= $4)`, [businessId, group, runId, at]);
  return rows[0]?.saldo ?? 0;
}

export const ledgerBalance = async (q: StockQuery, businessId: string, variantId: string, runId: string | null): Promise<number> =>
  sumDelta(q, businessId, await variantGroup(q, variantId), runId, null);
export const ledgerBalanceAt = async (q: StockQuery, businessId: string, variantId: string, runId: string | null, at: Date): Promise<number> =>
  sumDelta(q, businessId, await variantGroup(q, variantId), runId, at);

/** Kits completos que alcanzan con el saldo de sus componentes. */
export async function kitReach(q: StockQuery, businessId: string, kitVariantId: string, runId: string | null): Promise<number> {
  const {rows} = await q.query<{component_variant_id: string; quantity: number}>(
    'SELECT component_variant_id, quantity FROM assistant.stock_kit_components WHERE kit_variant_id = $1', [kitVariantId]);
  let reach = rows.length ? Number.POSITIVE_INFINITY : 0;
  for (const part of rows) reach = Math.min(reach, Math.floor(Math.max(await ledgerBalance(q, businessId, part.component_variant_id, runId), 0) / part.quantity));
  return reach;
}

export async function ledgerExpected(q: StockQuery, businessId: string, variantId: string, runId: string | null): Promise<ExpectedStock> {
  const group = await variantGroup(q, variantId);
  const {rows: counts} = await q.query<{counted: number; counted_at: Date}>(
    `SELECT counted, counted_at FROM assistant.stock_counts
      WHERE business_id = $1 AND variant_id = ANY($2::uuid[]) AND run_id IS NOT DISTINCT FROM $3 AND confirmation_id IS NOT NULL
      ORDER BY counted_at DESC, recorded_at DESC LIMIT 1`, [businessId, group, runId]);
  const last = counts[0];
  const {rows} = await q.query<{inbound: number; returned: number; sold: number}>(
    `SELECT COALESCE(sum(delta) FILTER (WHERE kind = 'entrada'), 0)::int AS inbound,
            COALESCE(sum(delta) FILTER (WHERE kind = 'devolucion'), 0)::int AS returned,
            COALESCE(-sum(delta) FILTER (WHERE kind = 'venta'), 0)::int AS sold
       FROM assistant.stock_movements
      WHERE business_id = $1 AND variant_id = ANY($2::uuid[]) AND run_id IS NOT DISTINCT FROM $3
        AND ($4::timestamptz IS NULL OR occurred_at > $4)`, [businessId, group, runId, last?.counted_at ?? null]);
  const {inbound = 0, returned = 0, sold = 0} = rows[0] ?? {};
  const base = last?.counted ?? 0;
  return {expected: base + inbound + returned - sold, lastCount: last?.counted ?? null, lastCountAt: last ? new Date(last.counted_at) : null, inbound, returned, sold};
}

export function createLedger(q: StockQuery): StockLedger {
  return {
    balance: (businessId, variantId, runId) => ledgerBalance(q, businessId, variantId, runId),
    balanceAt: (businessId, variantId, runId, at) => ledgerBalanceAt(q, businessId, variantId, runId, at),
    expected: (businessId, variantId, runId) => ledgerExpected(q, businessId, variantId, runId),
  };
}

/** Candados de la transacción, siempre en el mismo orden: dos kits cruzados no se bloquean entre sí. */
export async function lockVariants(tx: StockQuery, variantIds: readonly string[]): Promise<void> {
  for (const id of [...new Set(variantIds)].sort()) {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [id]);
  }
}

/**
 * Única puerta de escritura del libro: exige el candado ya tomado, rechaza saldo negativo, deja traza y refresca los
 * conteos pendientes que dependían de esa fecha, para que el dueño nunca apruebe una cifra vieja.
 */
export async function recordMovement(tx: StockQuery, input: MovementInput): Promise<string> {
  const variantId = await canonicalOf(tx, input.variantId);
  const group = await variantGroup(tx, variantId);
  const current = await sumDelta(tx, input.businessId, group, input.runId, null);
  if (current + input.delta < 0) throw new StockNegativeError(variantId);
  const id = randomUUID();
  await tx.query(
    `INSERT INTO assistant.stock_movements(id,business_id,variant_id,kind,delta,unit_cost,currency,origin,cause,confirmation_id,proposal_id,order_id,kit_variant_id,trace_id,occurred_at,simulated,run_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [id, input.businessId, variantId, input.kind, input.delta, input.unitCost ?? null, input.currency ?? null, input.origin, input.cause ?? null,
      input.confirmationId, input.proposalId, input.orderId ?? null, input.kitVariantId ?? null, input.traceId, input.occurredAt, input.simulated, input.runId]);
  await writeAudit(tx, {businessId: input.businessId, traceId: input.traceId, actor: input.actor, action: 'movimiento', entity: 'stock_movements', entityId: id,
    args: {variantId, kind: input.kind, delta: input.delta, confirmationId: input.confirmationId}});
  await refreshPendingCounts(tx, input.businessId, group, input.runId, input.occurredAt);
  return id;
}

/** `fijo`: saldo ya calculado, para un conteo por producto (R15). */
interface PendingCount {id: string; contado: number; conteo_en: string; esperado: number; pendiente: number; fijo?: number}

/** Si `saldo_a(conteo_en)` cambió desde la propuesta, sube `revision` y recalcula: el dueño ve la cifra nueva. */
async function refreshPendingCounts(tx: StockQuery, businessId: string, group: string[], runId: string | null, occurredAt: Date): Promise<void> {
  const {rows} = await tx.query<PendingCount>(
    `SELECT id, (payload->>'contado')::int AS contado, payload->>'conteo_en' AS conteo_en, (payload->>'esperado')::int AS esperado, COALESCE((payload->>'pendiente_pedido')::int, 0) AS pendiente
       FROM assistant.stock_proposals
      WHERE business_id = $1 AND kind = 'conteo' AND status = 'pendiente' AND run_id IS NOT DISTINCT FROM $3
        AND payload->>'variante_id' = ANY($2::text[]) AND (payload->>'conteo_en')::timestamptz >= $4`, [businessId, group, runId, occurredAt]);
  // R15: un conteo por producto espera la suma de sus opciones.
  const {rows: shared} = await tx.query<PendingCount & {opciones: string[]}>(
    `SELECT id, (payload->>'contado')::int AS contado, payload->>'conteo_en' AS conteo_en, (payload->>'esperado')::int AS esperado, 0 AS pendiente,
            (SELECT array_agg(o->>'variante_id') FROM jsonb_array_elements(payload->'opciones') o) AS opciones
       FROM assistant.stock_proposals
      WHERE business_id = $1 AND kind = 'conteo' AND status = 'pendiente' AND run_id IS NOT DISTINCT FROM $3 AND (payload->>'variante_por_confirmar')::boolean
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(payload->'opciones') o WHERE o->>'variante_id' = ANY($2::text[])) AND (payload->>'conteo_en')::timestamptz >= $4`,
    [businessId, group, runId, occurredAt]);
  for (const row of shared) {
    let saldo = 0;
    for (const option of row.opciones) saldo += await sumDelta(tx, businessId, await variantGroup(tx, option), runId, new Date(row.conteo_en));
    rows.push({id: row.id, contado: row.contado, conteo_en: row.conteo_en, esperado: row.esperado, pendiente: 0, fijo: saldo});
  }
  for (const row of rows) {
    const saldo = row.fijo ?? await sumDelta(tx, businessId, group, runId, new Date(row.conteo_en)) + row.pendiente; // Lo que viene en el pedido también se espera.
    if (saldo === row.esperado) continue;
    await tx.query(
      `UPDATE assistant.stock_proposals SET revision = revision + 1,
         payload = payload || jsonb_build_object('esperado', $2::int, 'diferencia', $3::int, 'causa_requerida', $4::boolean)
       WHERE id = $1`, [row.id, saldo, row.contado - saldo, row.contado !== saldo]);
  }
}
