import {randomUUID} from 'node:crypto';
import {STOCK_LIMITS, STOCK_NEGOTIATION} from './config';
import {writeAudit} from './audit';
import type {StockClock} from './clock';
import {localTime, ZONE} from './notices';
import {activeRun, type StockDb, type StockQuery} from './store';

/** Topes por día y negocio. Nombres iguales a los que ya escriben `notices.ts`, `documents.ts` y `wake.ts`. */
export const STOCK_TOPES = {
  sam_llamadas: 60,
  extraccion: STOCK_LIMITS.extractionsPerDay,
  despertares_ale: STOCK_LIMITS.wakesPerDay,
  avisos_voz: STOCK_LIMITS.noticesPerDay,
  tarjetas_stock: 12,
  tokens_ale: 2_200_000,
} as const;
export type StockMetric = keyof typeof STOCK_TOPES;

/** Por pedido y por conteo, no por día. Viven donde se aplican: aquí queda la tabla que lee la operación. */
export const STOCK_TOPES_POR_UNIDAD = {mensajes_proveedor: STOCK_NEGOTIATION.maxMessages, fotos_por_conteo: STOCK_LIMITS.photoRetries + 1} as const;

/**
 * Consumo de un turno de Ale, en tokens de entrada, medido en T0 (S-30): 44.000 a 136.000, y 503.000 con terminal. El
 * tope diario son los 16 turnos posibles (8 ticks y 8 despertares) a 136.000. Remedir con `scripts/stock-consumo.py`.
 */
export const STOCK_TOKENS = {turnoEsperado: 136_000, turnoConTerminal: 503_000, diario: STOCK_TOPES.tokens_ale} as const;

export const STOCK_CARD_TYPES = ['tick', 'pedido', 'conteo', 'factura', 'alerta', 'oferta', 'negociar'] as const;
export type StockCardType = (typeof STOCK_CARD_TYPES)[number];
const CARD_WINDOW_HOURS = 3;

export type CardReservation = {permitida: true; nueva: boolean; clave: string; id: string} | {permitida: false; motivo: 'tope_diario'};

export interface UsageDeps {db: StockDb; clock: StockClock; now: () => Date; benchEnabled: boolean}

/**
 * Contadores de gasto. Sin corrida cuentan por día real en la zona del negocio. Con corrida activa y banco cuenta
 * `stock_run_budgets`: una semana comprimida no agota el día real, y su presupuesto no vuelve a cero con un salto.
 * El día sale de `now`, nunca de `StockClock`: un salto de reloj no abre un día nuevo.
 */
export class StockUsage {
  constructor(private readonly deps: UsageDeps) {}

  private async run(q: StockQuery, businessId: string): Promise<string | null> {
    return this.deps.benchEnabled ? activeRun(q, businessId) : null;
  }

  async day(q: StockQuery, businessId: string): Promise<string> {
    return localTime(this.deps.now(), await this.zone(q, businessId)).day;
  }

  /** La semilla define el presupuesto. Si calla, la corrida hereda el tope diario como total: sigue siendo finito. */
  private async budget(q: StockQuery, runId: string, metric: StockMetric): Promise<void> {
    await q.query('INSERT INTO assistant.stock_run_budgets(run_id,metric,limit_value) VALUES ($1,$2,$3) ON CONFLICT (run_id, metric) DO NOTHING', [runId, metric, STOCK_TOPES[metric]]);
  }

  /** Atómico: el contador es la barrera. `day` solo lo pasan los avisos, que cobran lo de la noche al cupo de mañana. */
  async spend(q: StockQuery, businessId: string, metric: StockMetric, day?: string): Promise<boolean> {
    const runId = await this.run(q, businessId);
    if (runId) {
      await this.budget(q, runId, metric);
      const {rows} = await q.query('UPDATE assistant.stock_run_budgets SET used = used + 1 WHERE run_id = $1 AND metric = $2 AND used < limit_value RETURNING used', [runId, metric]);
      return rows.length > 0;
    }
    const {rows} = await q.query(
      `INSERT INTO assistant.stock_usage(business_id, day, metric, value) VALUES ($1, $2, $3, 1)
       ON CONFLICT (business_id, day, metric) DO UPDATE SET value = assistant.stock_usage.value + 1 WHERE assistant.stock_usage.value < $4
       RETURNING value`, [businessId, day ?? await this.day(q, businessId), metric, STOCK_TOPES[metric]]);
    return rows.length > 0;
  }

  /** Mide sin negar: los tokens de un turno ya se gastaron. Lo que frena es `exhausted`, antes del siguiente. */
  async record(q: StockQuery, businessId: string, metric: StockMetric, amount: number): Promise<void> {
    const runId = await this.run(q, businessId);
    if (runId) {
      await this.budget(q, runId, metric);
      await q.query('UPDATE assistant.stock_run_budgets SET used = used + $3 WHERE run_id = $1 AND metric = $2', [runId, metric, amount]);
      return;
    }
    await q.query(
      `INSERT INTO assistant.stock_usage(business_id, day, metric, value) VALUES ($1, $2, $3, $4)
       ON CONFLICT (business_id, day, metric) DO UPDATE SET value = assistant.stock_usage.value + $4`, [businessId, await this.day(q, businessId), metric, amount]);
  }

  async exhausted(q: StockQuery, businessId: string, metric: StockMetric): Promise<boolean> {
    const runId = await this.run(q, businessId);
    if (runId) {
      const {rows} = await q.query<{limit_value: string; used: string}>('SELECT limit_value, used FROM assistant.stock_run_budgets WHERE run_id = $1 AND metric = $2', [runId, metric]);
      return !!rows[0] && Number(rows[0].used) >= Number(rows[0].limit_value);
    }
    const {rows} = await q.query<{value: string}>('SELECT value FROM assistant.stock_usage WHERE business_id = $1 AND day = $2 AND metric = $3',
      [businessId, await this.day(q, businessId), metric]);
    return Number(rows[0]?.value ?? 0) >= STOCK_TOPES[metric];
  }

  /**
   * Las tarjetas nacen en la VM, así que el servidor no puede impedir `kanban_create`: entrega la clave y gasta el cupo.
   * Doble tick en la ventana: misma clave y un solo gasto, y Hermes deduplica por ella. Sin cupo no hay clave.
   */
  /**
   * `ref` es el `order_id` de `negociar` o el `document_id` de `factura`. Una factura con su documento tiene clave propia:
   * dos facturas en la misma ventana ya no comparten tarjeta (IVB-024, factura huérfana).
   */
  async reserveCard(businessId: string, tipo: StockCardType, ref?: string): Promise<CardReservation> {
    const {db, clock} = this.deps;
    const local = localTime(await clock.at(businessId), await this.zone(db, businessId));
    const slot = Math.floor(local.hour / CARD_WINDOW_HOURS);
    const stamp = `${local.day.replaceAll('-', '')}${String(slot * CARD_WINDOW_HOURS).padStart(2, '0')}`;
    const own = tipo === 'negociar' || (tipo === 'factura' && ref !== undefined);
    const base = own ? `stock:${businessId}:${tipo}:${ref}` : `stock:${businessId}:${tipo}:${stamp}-${slot}`;
    return db.tx(async tx => {
      const runId = await activeRun(tx, businessId);
      // Con corrida, la clave lleva la corrida: dos corridas que simulan la misma ventana chocaban en la idempotencia de
      // Hermes, y `kanban_create` devolvía la tarjeta `done` de la corrida anterior (IVB-024, ensayo del 2-nov).
      const clave = runId && !own ? `${base}:corrida-${runId.slice(0, 8)}` : base;
      const entityId = runId ? `${clave}@${runId}` : clave;
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`stock_card:${entityId}`]);
      const {rows} = await tx.query<{trace_id: string}>(
        `SELECT trace_id FROM assistant.stock_audit WHERE business_id = $1 AND action = 'tarjeta_reservada' AND entity_id = $2 LIMIT 1`, [businessId, entityId]);
      if (rows[0]) return {permitida: true, nueva: false, clave, id: rows[0].trace_id};
      if (!await this.spend(tx, businessId, 'tarjetas_stock')) return {permitida: false, motivo: 'tope_diario'};
      const id = randomUUID();
      await writeAudit(tx, {businessId, traceId: id, actor: 'ale', action: 'tarjeta_reservada', entity: 'stock_tarjetas', entityId, args: {tipo}});
      return {permitida: true, nueva: true, clave, id};
    });
  }

  private async zone(q: StockQuery, businessId: string): Promise<string> {
    const {rows} = await q.query<{timezone: string | null}>(
      `SELECT a.timezone FROM assistant.stock_enabled_businesses b LEFT JOIN assistant.assistants a ON a.user_id = b.user_id AND a.deleted_at IS NULL WHERE b.business_id = $1`, [businessId]);
    return rows[0]?.timezone ?? ZONE;
  }

  /** Lo gastado en la corrida: va al reporte de banco. */
  async runBudgets(q: StockQuery, runId: string): Promise<Array<{metric: string; limit_value: string; used: string}>> {
    const {rows} = await q.query<{metric: string; limit_value: string; used: string}>('SELECT metric, limit_value, used FROM assistant.stock_run_budgets WHERE run_id = $1 ORDER BY metric', [runId]);
    return rows;
  }
}
