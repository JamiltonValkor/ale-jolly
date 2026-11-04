import {StockBetSignalV1, type StockRotationAlertV1} from '../contracts/stock-v1';
import type {StockClock} from './clock';
import {STOCK_ROTATION} from './config';
import {canonicalOf, kitReach, ledgerBalance, ledgerExpected, variantGroup} from './ledger';
import type {OfferingsReader} from './offerings';
import {activeRun, findVariant, type StockDb, type StockQuery, type VariantRow} from './store';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);
const round = (value: number, decimals: number): number => Number(value.toFixed(decimals));
const money = (value: number | string): string => Number(value).toFixed(2);

export type RotationState = 'sin_datos' | 'frenazo' | 'lento' | 'sin_pauta' | 'sano';
export interface SaleMark {at: Date; units: number}
export interface SaleRhythm {
  /** Unidades por semana antes de la ventana evaluada. */
  base: number; actual: number;
  /** Semanas con ventas en toda la historia, y semanas que la base pudo mirar. */
  weeks: number; spanWeeks: number;
  daysSilent: number;
  /** Días que suele pasar entre dos ventas. Quien concilia cada 14 días no está frenado al día 9. */
  ownGapDays: number;
  /** Semanas de la base sin la mejor: un pico nunca mueve lo que se pide (R24). */
  steady: number;
}

/**
 * Las semanas cuentan hacia atrás desde `now`: 0 es la ventana evaluada y lo que vendió antes va a la base. Una parada
 * que sigue en curso no baja la base: sus semanas se saltan mientras queden ventas entre las 8 anteriores (R18). Sin
 * ninguna venta en esas 8, la base ya es 0 y el producto deja de ser frenazo para ser lento.
 */
export function saleRhythm(sales: readonly SaleMark[], now: Date): SaleRhythm {
  const weekly = new Map<number, number>();
  for (const sale of sales) {
    const week = Math.floor((now.getTime() - sale.at.getTime()) / WEEK_MS);
    weekly.set(week, (weekly.get(week) ?? 0) + sale.units);
  }
  const unitsOf = (week: number): number => weekly.get(week) ?? 0;
  const span = STOCK_ROTATION.baselineWeeks;
  const weekRange = (from: number): number[] => Array.from({length: span}, (_, index) => from + index);
  const oldest = weekly.size ? Math.max(...weekly.keys()) : 0;
  let first = 1;
  if (sum(weekRange(1).map(unitsOf)) > 0) while (!unitsOf(first)) first += 1;
  const spanWeeks = Math.min(span, Math.max(oldest - first + 1, 1));
  const dates = sales.map(sale => sale.at.getTime()).sort((a, b) => a - b);
  const limit = now.getTime() - WEEK_MS;
  const inBase = dates.filter(date => date <= limit && date > limit - (first + span - 1) * WEEK_MS);
  const baseWeeks = Array.from({length: spanWeeks}, (_, index) => unitsOf(first + index)).sort((a, b) => b - a);
  const gaps = inBase.slice(1).map((date, index) => (date - inBase[index]!) / DAY_MS).filter(gap => gap > 0).sort((a, b) => a - b);
  return {
    base: sum(weekRange(first).map(unitsOf)) / spanWeeks,
    actual: unitsOf(0), weeks: weekly.size, spanWeeks,
    daysSilent: dates.length ? (now.getTime() - dates.at(-1)!) / DAY_MS : Number.POSITIVE_INFINITY,
    ownGapDays: gaps[Math.floor(gaps.length / 2)] ?? 0,
    steady: baseWeeks.length > 1 ? sum(baseWeeks.slice(1)) / (baseWeeks.length - 1) : baseWeeks[0] ?? 0,
  };
}

export type PautaActiva = boolean | 'desconocido';

/** Reglas de `architecture.md` §13, en orden. Cobertura nula no es infinita: sin ritmo no hay cómo afirmar sobrestock. */
export function rotationState(input: {rhythm: SaleRhythm; base: number; activa: PautaActiva; coverage: number | null}): RotationState {
  const {rhythm, base, activa, coverage} = input;
  if (rhythm.weeks < STOCK_ROTATION.minWeeksWithSales) return 'sin_datos';
  const stopped = rhythm.actual === 0 && rhythm.daysSilent >= Math.max(STOCK_ROTATION.stopDays, rhythm.ownGapDays);
  if (base >= STOCK_ROTATION.stopMinRate && stopped) return 'frenazo';
  if (base < STOCK_ROTATION.slowRate && rhythm.spanWeeks >= STOCK_ROTATION.baselineWeeks) return 'lento';
  if (base >= STOCK_ROTATION.slowRate && activa === false && coverage !== null && coverage > STOCK_ROTATION.noAdsCoverageDays) return 'sin_pauta';
  return 'sano';
}

/** R22: cifras para que el agente decida. Lo proporcional asume que las unidades crecen con el presupuesto. */
export function betReach(input: {saldo: number; unidadesSemana: number | null | undefined; dias: number; presupuestoDiario: string}) {
  const {saldo, unidadesSemana, dias, presupuestoDiario} = input;
  if (unidadesSemana === null || unidadesSemana === undefined) {
    return {estado: 'sin_dato' as const, unidades_necesarias: null, unidades_disponibles: saldo, dias_alcanza: null, unidades_semana_alcanzables: null, presupuesto_diario_proporcional: null};
  }
  const necesarias = unidadesSemana * dias / 7;
  const alcanza = saldo >= necesarias;
  return {
    estado: alcanza ? 'alcanza' as const : 'no_alcanza' as const, unidades_necesarias: Math.ceil(necesarias), unidades_disponibles: saldo,
    dias_alcanza: unidadesSemana > 0 ? Math.floor(saldo / (unidadesSemana / 7)) : null,
    unidades_semana_alcanzables: alcanza ? null : round(saldo * 7 / dias, 1),
    presupuesto_diario_proporcional: alcanza ? null : money(Math.floor(Number(presupuestoDiario) * saldo / necesarias * 100) / 100),
  };
}

const decimal = (value: number): string => String(round(value, 1)).replace('.', ',');

/**
 * IVB-024, «pegando». Determinista: lo calcula el servidor y el agente no lo estima.
 * - `ritmo_actual_semana`: ventas de los últimos 2 días por 7/2. Con apuesta aprobada en curso solo cuentan las ventas
 *   desde su inicio (atribuidas). Siempre se divide por 2 días: unas horas de pauta nunca se proyectan a una semana.
 * - Referencia: `unidades_semana_previstas` de la apuesta; sin previsión, el ritmo base congelado al aprobar.
 * - Pega con apuesta aprobada en curso, al menos 2 unidades en la ventana y ritmo ≥ 1,5 × referencia.
 */
export function hotSignal(input: {sales: readonly SaleMark[]; now: Date; betStart: Date | null; previstas: number | null | undefined; base: number; saldo: number}) {
  const {sales, now, betStart, previstas, base, saldo} = input;
  const {hotWindowDays, hotFactor, hotMinUnits} = STOCK_ROTATION;
  const from = Math.max(now.getTime() - hotWindowDays * DAY_MS, betStart?.getTime() ?? Number.NEGATIVE_INFINITY);
  const units = sum(sales.filter(sale => sale.at.getTime() > from && sale.at.getTime() <= now.getTime()).map(sale => sale.units));
  const ritmo = round(units * 7 / hotWindowDays, 1);
  const forecast = previstas !== null && previstas !== undefined;
  const reference = forecast ? Number(previstas) : base;
  const pegando = betStart !== null && units >= hotMinUnits && ritmo >= hotFactor * reference;
  const contra = forecast ? `las ${decimal(reference)} previstas por semana` : `el ritmo base de ${decimal(reference)} por semana (la apuesta no trae previsión)`;
  return {
    pegando, ritmo_actual_semana: ritmo,
    motivo_pegando: pegando ? `Con la pauta vende a ${decimal(ritmo)} por semana en los últimos ${hotWindowDays} días, al menos ${decimal(hotFactor)} veces ${contra}.` : null,
    dias_cobertura_al_ritmo_actual: ritmo > 0 ? round(saldo / (ritmo / 7), 1) : null,
  };
}

interface Outflow extends SaleMark {sale: boolean}
interface Bet {id: string; status: string; expires_at: Date; payload: {presupuesto_diario: string; duracion_dias: number; unidades_semana_previstas?: number | null}; weekly_rate: string | null; computed_at: Date | null}
export interface BetAvailability {
  variant: VariantRow | null; runId: string | null; stock: {saldo: number; esperado: number; ultimo_conteo_en: string | null} | null;
  se_puede_pautar: boolean; motivo_no: 'sin_producto' | 'sin_stock' | null;
}

/** Salidas del libro. Un kit no tiene movimientos propios: una venta suya deja uno por componente y se cuenta una vez. */
async function outflows(q: StockQuery, businessId: string, variant: VariantRow, runId: string | null, now: Date): Promise<Outflow[]> {
  const {rows} = variant.is_kit
    ? await q.query<{occurred_at: Date; units: number; sale: boolean}>(
      `SELECT DISTINCT ON (m.proposal_id) m.occurred_at, abs(m.delta) / c.quantity AS units, true AS sale
         FROM assistant.stock_movements m JOIN assistant.stock_kit_components c ON c.kit_variant_id = m.kit_variant_id AND c.component_variant_id = m.variant_id
        WHERE m.business_id = $1 AND m.kit_variant_id = $2 AND m.run_id IS NOT DISTINCT FROM $3 AND m.delta < 0 AND m.occurred_at <= $4`, [businessId, variant.id, runId, now])
    : await q.query<{occurred_at: Date; units: number; sale: boolean}>(
      `SELECT occurred_at, abs(delta) AS units, (kind = 'venta' OR (kind = 'ajuste' AND cause = 'venta')) AS sale
         FROM assistant.stock_movements
        WHERE business_id = $1 AND variant_id = ANY($2::uuid[]) AND run_id IS NOT DISTINCT FROM $3 AND delta < 0 AND occurred_at <= $4`,
      [businessId, await variantGroup(q, variant.id), runId, now]);
  return rows.map(row => ({at: new Date(row.occurred_at), units: Number(row.units), sale: row.sale}));
}

/** Ritmo de ventas a una fecha. Es lo que se congela al aprobar una apuesta (R17). */
export async function salesRhythm(q: StockQuery, businessId: string, variantId: string, runId: string | null, now: Date): Promise<SaleRhythm> {
  const variant = (await findVariant(q, businessId, await canonicalOf(q, variantId), runId))!;
  return saleRhythm((await outflows(q, businessId, variant, runId, now)).filter(item => item.sale), now);
}

/** Señal para pauta (R17 a R22). El servidor entrega datos: comercialmente decide el agente. */
export class Rotation {
  constructor(private readonly deps: {db: StockDb; clock: StockClock; offerings: OfferingsReader}) {}

  /** R19: la misma compuerta para `bet-signal` y para crear una apuesta. */
  async availability(q: StockQuery, businessId: string, rawVariantId: string, runId: string | null): Promise<BetAvailability> {
    const found = await findVariant(q, businessId, rawVariantId, runId);
    if (!found) return {variant: null, runId, stock: null, se_puede_pautar: false, motivo_no: 'sin_producto'};
    const variant = (await findVariant(q, businessId, await canonicalOf(q, found.id), runId))!;
    let stock: NonNullable<BetAvailability['stock']>;
    if (variant.is_kit) {
      const reach = await kitReach(q, businessId, variant.id, runId);
      stock = {saldo: reach, esperado: reach, ultimo_conteo_en: null};
    } else {
      const expected = await ledgerExpected(q, businessId, variant.id, runId);
      stock = {saldo: await ledgerBalance(q, businessId, variant.id, runId), esperado: expected.expected, ultimo_conteo_en: expected.lastCountAt?.toISOString() ?? null};
    }
    const available = stock.saldo > 0;
    return {variant, runId, stock, se_puede_pautar: available, motivo_no: available ? null : 'sin_stock'};
  }

  private async bets(businessId: string, variantId: string, runId: string | null, now: Date): Promise<{approved: Bet | null; current: Bet | null}> {
    const {db} = this.deps;
    const {rows} = await db.query<Bet>(
      `SELECT p.id, p.status, p.expires_at, p.payload, b.weekly_rate, b.computed_at
         FROM assistant.stock_proposals p LEFT JOIN assistant.stock_rotation_baselines b ON b.proposal_id = p.id
        WHERE p.business_id = $1 AND p.kind = 'apuesta' AND p.run_id IS NOT DISTINCT FROM $2 AND p.status IN ('pendiente', 'aprobada')
          AND p.payload->>'variante_id' = ANY($3::text[])
        ORDER BY p.recorded_at DESC, p.id`, [businessId, runId, await variantGroup(db, variantId)]);
    const running = (bet: Bet): boolean => bet.computed_at !== null && new Date(bet.computed_at).getTime() + Number(bet.payload.duracion_dias) * DAY_MS > now.getTime();
    const approved = rows.find(bet => bet.status === 'aprobada' && running(bet)) ?? null;
    return {approved, current: approved ?? rows.find(bet => bet.status === 'pendiente' && new Date(bet.expires_at) > now) ?? null};
  }

  private async pauta(businessId: string, variantId: string, runId: string | null) {
    if (runId === null) return {activa: 'desconocido' as const, simulado: false, presupuesto_diario: null, senales: null};
    const {rows} = await this.deps.db.query<{budget: string; signals: Record<string, number>}>(
      `SELECT budget, signals FROM assistant.stock_sim_campaigns WHERE business_id = $1 AND run_id = $2 AND status = 'activa' AND variant_id = ANY($3::uuid[])
        ORDER BY recorded_at DESC, id LIMIT 1`, [businessId, runId, await variantGroup(this.deps.db, variantId)]);
    const campaign = rows[0];
    if (!campaign) return {activa: false, simulado: true, presupuesto_diario: null, senales: null};
    return {activa: true, simulado: true, presupuesto_diario: money(campaign.budget), senales: {gasto: campaign.signals.gasto ?? 0, mensajes: campaign.signals.mensajes ?? 0}};
  }

  private async evaluate(businessId: string, availability: BetAvailability, now: Date) {
    const {runId} = availability;
    const [variant, saldo] = [availability.variant!, availability.stock!.saldo];
    const flows = await outflows(this.deps.db, businessId, variant, runId, now);
    const rhythm = saleRhythm(flows.filter(item => item.sale), now);
    const {approved, current} = await this.bets(businessId, variant.id, runId, now);
    const pauta = await this.pauta(businessId, variant.id, runId);
    const base = approved ? Number(approved.weekly_rate) : rhythm.base;
    const vigente = rhythm.actual + Number(current?.payload.unidades_semana_previstas ?? 0);
    const coverage = vigente > 0 ? saldo / (vigente / 7) : null;
    return {flows, rhythm, approved, current, pauta, base, coverage, estado: rotationState({rhythm, base, activa: pauta.activa, coverage})};
  }

  /** `margen` nace del precio de la oferta ligada. Sin precio, sin costo o sin lectura es nulo: nunca lo da el modelo. */
  private async margin(userId: string, businessId: string, variant: VariantRow) {
    if (variant.unit_cost === null) return null;
    const {rows} = await this.deps.db.query<{offering_type: 'product' | 'service' | null; offering_id: string | null}>(
      'SELECT offering_type, offering_id FROM assistant.stock_products WHERE id = $1', [variant.product_id]);
    const {offering_type: type, offering_id: id} = rows[0] ?? {};
    if (!type || !id) return null;
    const offering = await this.deps.offerings.find(userId, businessId, {type, id}).catch(() => null);
    const price = Number(offering?.price ?? 0);
    if (price <= 0 || (offering?.currency && offering.currency !== variant.currency)) return null;
    const gain = price - Number(variant.unit_cost);
    return {dinero: money(gain), pct: Math.round(gain / price * 100)};
  }

  /**
   * IVB-023: Ale pasó el id de un producto o de una oferta, recibió `stock` nulo y le dijo al dueño «no hay stock» de un kit
   * con 15 unidades. El 200 con `sin_producto` se mantiene (R19 no cambia), pero si el id es de un producto o de una oferta
   * del mismo negocio y corrida, se dice cuál es y qué variantes sí sirven. Nada de otro negocio se revela.
   */
  private async notAVariant(businessId: string, rawId: string, runId: string | null): Promise<{motivo: 'id_de_producto' | 'id_de_oferta'; variantes: Array<{variante_id: string; nombre: string}>} | null> {
    const {rows} = await this.deps.db.query<{variante_id: string; nombre: string; por_producto: boolean}>(
      `SELECT v.id AS variante_id, p.name || ' ' || v.name AS nombre, (p.id::text = $2) AS por_producto
         FROM assistant.stock_products p JOIN assistant.stock_variants v ON v.product_id = p.id
        WHERE p.business_id = $1 AND p.run_id IS NOT DISTINCT FROM $3 AND (p.id::text = $2 OR p.offering_id = $2)
        ORDER BY p.name, v.name LIMIT 20`, [businessId, rawId, runId]);
    if (!rows.length) return null;
    return {motivo: rows.some(row => row.por_producto) ? 'id_de_producto' : 'id_de_oferta', variantes: rows.map(({variante_id, nombre}) => ({variante_id, nombre}))};
  }

  /** Se calcula al leer con el reloj del negocio: el tiempo simulado manda. */
  async signal(userId: string, businessId: string, rawVariantId: string) {
    const {db, clock} = this.deps;
    const runId = await activeRun(db, businessId);
    const availability = await this.availability(db, businessId, rawVariantId, runId);
    const {variant, stock, se_puede_pautar, motivo_no} = availability;
    if (!variant || !stock) {
      const hint = await this.notAVariant(businessId, rawVariantId, runId);
      return StockBetSignalV1.parse({variante_id: rawVariantId, stock: null, costo: null, ritmo: null, margen: null, cobertura_dias: null, motivo_cobertura: null, pauta: null,
        alcance_pauta: null, seguimiento: null, se_puede_pautar, motivo_no: hint?.motivo ?? motivo_no, datos_simulados: [],
        pegando: false, ritmo_actual_semana: 0, motivo_pegando: null, dias_cobertura_al_ritmo_actual: null, ...(hint ? {variantes: hint.variantes} : {})});
    }
    const now = await clock.at(businessId);
    const {flows, rhythm, approved, current, pauta, base, coverage, estado} = await this.evaluate(businessId, availability, now);
    const since = approved ? new Date(approved.computed_at!) : null;
    const after = since ? flows.filter(item => item.at > since) : [];
    const simulated = runId !== null;
    return StockBetSignalV1.parse({
      variante_id: variant.id, stock,
      costo: {unitario: variant.unit_cost === null ? null : money(variant.unit_cost), moneda: variant.currency, fuente: variant.unit_cost === null ? 'sin_dato' : 'factura'},
      ritmo: {base_semanal: round(base, 2), actual_semanal: rhythm.actual, estado},
      margen: await this.margin(userId, businessId, variant),
      cobertura_dias: coverage === null ? null : round(coverage, 1), motivo_cobertura: coverage === null ? 'sin_ritmo' : null,
      pauta,
      alcance_pauta: current ? {apuesta_id: current.id, ...betReach({saldo: stock.saldo, unidadesSemana: current.payload.unidades_semana_previstas, dias: current.payload.duracion_dias, presupuestoDiario: current.payload.presupuesto_diario})} : null,
      seguimiento: since ? {
        desde: since.toISOString(), pauta: pauta.senales ? {...pauta.senales, simulado: pauta.simulado} : null,
        ventas_reportadas: {unidades: sum(after.filter(item => item.sale).map(item => item.units)), simulado: simulated},
        salida_inventario: {unidades: sum(after.map(item => item.units)), simulado: simulated},
      } : null,
      se_puede_pautar, motivo_no, datos_simulados: simulated ? ['stock', 'ventas', ...(pauta.activa === true ? ['pauta'] : [])] : [],
      ...hotSignal({sales: flows.filter(item => item.sale), now, betStart: since, previstas: approved?.payload.unidades_semana_previstas, base, saldo: stock.saldo}),
    });
  }

  /** Lo que reposición necesita: ritmo vigente con la pauta prevista (R23) y ritmo estable más lo apostado (R24). */
  async reorderSignal(businessId: string, variantId: string) {
    const {db, clock} = this.deps;
    const runId = await activeRun(db, businessId);
    const availability = await this.availability(db, businessId, variantId, runId);
    const {rhythm, current} = await this.evaluate(businessId, availability, await clock.at(businessId));
    const previstas = Number(current?.payload.unidades_semana_previstas ?? 0);
    return {saldo: availability.stock!.saldo, vigente: rhythm.actual + previstas, estable: round(rhythm.steady + previstas, 2), apuestaDias: current ? Number(current.payload.duracion_dias) : null};
  }

  /**
   * IVB-024 (avisos pendientes): el estado de una variante para los avisos que calcula el servidor. Mismo cálculo que
   * `bet-signal` y `alerts`, más las fechas que anclan cada estado: la última venta, la última entrada y el inicio de la
   * apuesta aprobada en curso.
   */
  async alertState(businessId: string, variantId: string, runId: string | null, now: Date) {
    const {db} = this.deps;
    const availability = await this.availability(db, businessId, variantId, runId);
    if (!availability.variant || !availability.stock) return null;
    const {flows, rhythm, approved, base, coverage, estado} = await this.evaluate(businessId, availability, now);
    const sales = flows.filter(item => item.sale);
    const betStart = approved ? new Date(approved.computed_at!) : null;
    const {rows} = await db.query<{at: Date | null}>(
      `SELECT max(occurred_at) AS at FROM assistant.stock_movements
        WHERE business_id = $1 AND variant_id = ANY($2::uuid[]) AND run_id IS NOT DISTINCT FROM $3 AND delta > 0 AND occurred_at <= $4`,
      [businessId, await variantGroup(db, availability.variant.id), runId, now]);
    const lastSale = sales.reduce<Date | null>((latest, sale) => (!latest || sale.at > latest ? sale.at : latest), null);
    return {
      variant: availability.variant, saldo: availability.stock.saldo, estado, base: round(base, 2), actual: rhythm.actual, coverage: coverage === null ? null : round(coverage, 1),
      daysSilent: Number.isFinite(rhythm.daysSilent) ? Math.floor(rhythm.daysSilent) : null, lastSale, lastInflow: rows[0]?.at ? new Date(rows[0].at) : null, betStart,
      hot: hotSignal({sales, now, betStart, previstas: approved?.payload.unidades_semana_previstas, base, saldo: availability.stock.saldo}),
    };
  }

  /** Lo que el ciclo debe mirar. Sano y sin datos no son novedad, y un producto sin datos no se inventa. */
  async alerts(businessId: string): Promise<StockRotationAlertV1[]> {
    const {db, clock} = this.deps;
    const runId = await activeRun(db, businessId);
    const now = await clock.at(businessId);
    const {rows} = await db.query<{id: string; product: string; variant: string}>(
      `SELECT v.id, p.name AS product, v.name AS variant FROM assistant.stock_variants v JOIN assistant.stock_products p ON p.id = v.product_id
        WHERE p.business_id = $1 AND p.run_id IS NOT DISTINCT FROM $2 AND v.id NOT IN (SELECT alias_variant_id FROM assistant.stock_variant_aliases)
        ORDER BY p.name, v.name, v.id`, [businessId, runId]);
    const alerts: StockRotationAlertV1[] = [];
    for (const row of rows) {
      const availability = await this.availability(db, businessId, row.id, runId);
      const {estado, base, rhythm} = await this.evaluate(businessId, availability, now);
      if (estado === 'sano' || estado === 'sin_datos') continue;
      alerts.push({variante_id: row.id, producto: `${row.product} ${row.variant}`, estado, base_semanal: round(base, 2), actual_semanal: rhythm.actual, saldo: availability.stock!.saldo});
    }
    return alerts;
  }
}
