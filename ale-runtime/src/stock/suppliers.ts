import type {StockPedidoDetalleV1} from '../contracts/stock-v1';
import {conflict, invalidRequest, notFound} from '../domain/errors';
import type {z} from 'zod';
import type {StockClock} from './clock';
import {STOCK_REORDER} from './config';
import {canonicalOf, ledgerExpected, variantGroup} from './ledger';
import type {Rotation} from './rotation';
import {activeRun, businessCurrency, findVariant, type StockQuery} from './store';

const DAY_MS = 86_400_000;
const money = (cents: number): string => (cents / 100).toFixed(2);
const cents = (value: string | number): number => Math.round(Number(value) * 100);

/** R26: «equivalente» exige prueba guardada. Un objeto vacío no prueba nada. */
export const equivalenceOf = (proof: unknown): 'equivalente' | 'alternativa' =>
  proof !== null && typeof proof === 'object' && Object.keys(proof).length > 0 ? 'equivalente' : 'alternativa';

export interface QuoteOption {
  proveedor_id: string; nombre: string; dias_entrega: number | null; precio: string; flete: string; minimo: number; plazo_pago_dias: number | null;
  garantia: string | null; equivalencia: 'equivalente' | 'alternativa'; moneda: string;
}
export interface ComparedOption extends QuoteOption {costo_total: string; elegible: boolean; motivo_no: 'minimo' | 'sin_plazo_entrega' | 'otra_moneda' | null}

/** R25: gana el costo total de la cantidad pedida. Un mínimo mayor que el mandato o sin plazo de entrega no es elegible. */
export function compareQuotes(options: readonly QuoteOption[], cantidad: number, moneda: string): ComparedOption[] {
  const motivo = (option: QuoteOption): ComparedOption['motivo_no'] => {
    if (option.moneda !== moneda) return 'otra_moneda';
    if (option.minimo > cantidad) return 'minimo';
    return option.dias_entrega === null ? 'sin_plazo_entrega' : null;
  };
  return options.map(option => {
    const reason = motivo(option);
    return {...option, costo_total: money(cents(option.precio) * cantidad + cents(option.flete)), elegible: reason === null, motivo_no: reason};
  }).sort((a, b) => Number(b.elegible) - Number(a.elegible) || cents(a.costo_total) - cents(b.costo_total) || a.proveedor_id.localeCompare(b.proveedor_id));
}

export interface ReorderInput {
  saldo: number; /** Actual más lo previsto por la apuesta. Mueve la fecha (R23). */ ritmoVigente: number;
  /** Sin el pico de la semana evaluada ni el de ninguna otra: mueve la cantidad (R24). */ ritmoEstable: number;
  diasEntrega: number; horizonteDias: number; minimo: number; hoy: Date;
}

/** R23 y R24, sin leer nada: cobertura contra entrega más colchón, y cantidad para el horizonte con el ritmo estable. */
export function reorderPlan(input: ReorderInput) {
  const {saldo, ritmoVigente, ritmoEstable, diasEntrega, horizonteDias, minimo, hoy} = input;
  const punto = diasEntrega + STOCK_REORDER.bufferDays;
  const cobertura = ritmoVigente > 0 ? Math.max(saldo, 0) / (ritmoVigente / 7) : null;
  const margen = cobertura === null ? null : Math.max(Math.floor(cobertura - punto), 0);
  const faltan = Math.ceil(ritmoEstable / 7 * (horizonteDias + punto)) - Math.max(saldo, 0);
  return {
    cobertura_dias: cobertura === null ? null : Number(cobertura.toFixed(1)), punto_pedido_dias: punto,
    fecha_pedido: margen === null ? null : new Date(hoy.getTime() + margen * DAY_MS).toLocaleDateString('en-CA', {timeZone: 'America/Bogota'}),
    cantidad_sugerida: faltan > 0 ? Math.max(faltan, minimo) : 0,
  };
}

type OrderRequest = z.infer<typeof StockPedidoDetalleV1>;

/** Proveedores sembrados: esta ola no busca proveedores reales. La decisión comercial es del agente; las cuentas, del servidor. */
export class Suppliers {
  constructor(private readonly deps: {db: StockQuery; clock: StockClock; rotation: Rotation}) {}

  /** Última cotización de cada proveedor para el producto, incluidas sus variantes unidas. */
  private async quotes(businessId: string, variantId: string, runId: string | null): Promise<QuoteOption[]> {
    const {db} = this.deps;
    const {rows} = await db.query<{
      supplier_id: string; name: string; lead_time_days: number | null; price: string; freight: string; min_qty: number; payment_term_days: number | null; warranty: string | null;
      equivalent_proof: unknown; currency: string;
    }>(
      `SELECT DISTINCT ON (q.supplier_id) q.supplier_id, s.name, s.lead_time_days, q.price, q.freight, q.min_qty, q.payment_term_days, q.warranty, q.equivalent_proof, q.currency
         FROM assistant.stock_supplier_quotes q JOIN assistant.stock_suppliers s ON s.id = q.supplier_id
        WHERE s.business_id = $1 AND s.run_id IS NOT DISTINCT FROM $2 AND q.variant_id = ANY($3::uuid[])
        ORDER BY q.supplier_id, q.recorded_at DESC, q.id`, [businessId, runId, await variantGroup(db, variantId)]);
    return rows.map(row => ({proveedor_id: row.supplier_id, nombre: row.name, dias_entrega: row.lead_time_days, precio: money(cents(row.price)), flete: money(cents(row.freight)), minimo: row.min_qty,
      plazo_pago_dias: row.payment_term_days, garantia: row.warranty, equivalencia: equivalenceOf(row.equivalent_proof), moneda: row.currency}));
  }

  private async rhythm(businessId: string, variantId: string) {
    const signal = await this.deps.rotation.reorderSignal(businessId, variantId);
    return {...signal, horizonte: signal.apuestaDias ?? STOCK_REORDER.horizonDays};
  }

  /** Cuándo y cuánto pedir por opción. Sin ritmo no hay fecha: se dice, no se inventa. */
  async plan(businessId: string, rawVariantId: string) {
    const {db, clock} = this.deps;
    const runId = await activeRun(db, businessId);
    const found = await findVariant(db, businessId, rawVariantId, runId);
    if (!found || found.is_kit) return null;
    const variantId = await canonicalOf(db, found.id);
    const [options, moneda, hoy] = [await this.quotes(businessId, variantId, runId), await businessCurrency(db, businessId), await clock.at(businessId)];
    const rhythm = await this.rhythm(businessId, variantId);
    const plans = options.map(option => reorderPlan({saldo: rhythm.saldo, ritmoVigente: rhythm.vigente, ritmoEstable: rhythm.estable, diasEntrega: option.dias_entrega ?? 0, horizonteDias: rhythm.horizonte, minimo: option.minimo, hoy}));
    const cantidad = Math.max(0, ...plans.map(plan => plan.cantidad_sugerida));
    const compared = compareQuotes(options, cantidad || 1, moneda);
    return {variante_id: variantId, saldo: rhythm.saldo, ritmo_vigente: rhythm.vigente, ritmo_estable: rhythm.estable, moneda,
      opciones: compared.map(option => {
        const plan = plans[options.findIndex(item => item.proveedor_id === option.proveedor_id)]!;
        return {proveedor_id: option.proveedor_id, nombre: option.nombre, costo_total: option.costo_total, elegible: option.elegible, motivo_no: option.motivo_no, equivalencia: option.equivalencia,
          fecha_pedido: option.dias_entrega === null ? null : plan.fecha_pedido, cobertura_dias: plan.cobertura_dias, punto_pedido_dias: plan.punto_pedido_dias, cantidad_sugerida: plan.cantidad_sugerida};
      })};
  }

  /** Texto y vista de la propuesta `pedido`. Cifras del servidor: el modelo solo elige proveedor, cantidad y mandato. */
  async orderDraft(businessId: string, runId: string | null, detalle: OrderRequest) {
    const {db} = this.deps;
    const {precio_objetivo: objetivo, tope} = detalle.mandato;
    if (Number(objetivo) > Number(tope) || Number(tope) <= 0) throw invalidRequest();
    const found = await findVariant(db, businessId, detalle.variante_id, runId);
    if (!found) throw notFound();
    if (found.is_kit) throw invalidRequest();
    const variantId = await canonicalOf(db, found.id);
    const moneda = await businessCurrency(db, businessId);
    const compared = compareQuotes(await this.quotes(businessId, variantId, runId), detalle.cantidad, moneda);
    const chosen = compared.find(option => option.proveedor_id === detalle.proveedor_id);
    if (!chosen) throw notFound();
    if (!chosen.elegible) throw conflict();
    const rhythm = await this.rhythm(businessId, variantId);
    const producto = `${found.product_name} ${found.variant_name}`;
    const shown = (await ledgerExpected(db, businessId, variantId, runId)).expected;
    return {
      title: `Pedido de ${producto}`, reason: compared.length === 1 ? 'Un proveedor comparado por costo total.' : `Comparados ${compared.length} proveedores por costo total.`,
      effectsYes: ['Se crea el pedido y empieza la negociación dentro del mandato. Nada se paga.'], effectsNo: ['No se crea pedido, ni negociación, ni mensaje.'],
      payload: {
        variante_id: variantId, proveedor_id: chosen.proveedor_id, cantidad: detalle.cantidad, moneda, costo_esperado: chosen.costo_total, mandato: {precio_objetivo: money(cents(objetivo)), tope: money(cents(tope))},
        vista: {
          producto, cantidad: detalle.cantidad, stock_esperado: shown, ritmo_semanal: rhythm.vigente, dias_entrega: chosen.dias_entrega!,
          proveedores: compared.map(option => ({nombre: option.nombre, precio: option.precio, flete: option.flete, minimo: option.minimo, dias_entrega: option.dias_entrega ?? 0, plazo_pago_dias: option.plazo_pago_dias ?? 0,
            garantia: option.garantia ?? 'Sin dato', costo_total: option.costo_total, elegido: option.proveedor_id === chosen.proveedor_id, equivalencia: option.equivalencia})),
          mandato: {precio_objetivo: money(cents(objetivo)), tope: money(cents(tope)), cantidad: detalle.cantidad}, moneda,
        },
      },
    };
  }
}
