import {
  StockItemDetailV1, StockItemsV1, StockOrdersV1, StockOverviewV1, StockSummaryV1, StockSuppliersV1,
} from '../contracts/stock-v1';
import {notFound} from '../domain/errors';
import type {StockClock} from './clock';
import {STOCK_LIMITS} from './config';
import {ledgerBalance, ledgerExpected, variantGroup, canonicalOf} from './ledger';
import {activeRun, businessCurrency, findVariant, type StockDb} from './store';
import {equivalenceOf} from './suppliers';

type Items = ReturnType<typeof StockItemsV1.parse>;
type Item = Items['items'][number];
interface VariantRow {id: string; product_id: string; product: string; variant: string; offering_id: string | null; offering_name: string | null}
/** `opciones`: conteo con variante por confirmar (R15). Vale para cada una, pero sin cifra por variante hasta el reparto. */
interface PendingCount {id: string; variante_id: string | null; opciones: string[] | null; contado: number; conteo_en: string; diferencia: number; causa_requerida: boolean}

const iso = (value: Date | string | null | undefined): string | null => value ? new Date(value).toISOString() : null;
const money = (value: string | null): string | null => value === null ? null : Number(value).toFixed(2);

/** Lecturas de Stock. Siempre del run vigente: una lectura sin datos da listas vacías, nunca 404. */
export class StockReads {
  constructor(private readonly db: StockDb, private readonly clock: StockClock) {}

  private async pendingCounts(businessId: string, runId: string | null): Promise<PendingCount[]> {
    const now = await this.clock.at(businessId);
    const {rows} = await this.db.query<PendingCount>(
      `SELECT id, payload->>'variante_id' AS variante_id, (SELECT array_agg(o->>'variante_id') FROM jsonb_array_elements(payload->'opciones') o) AS opciones,
              (payload->>'contado')::int AS contado, payload->>'conteo_en' AS conteo_en,
              (payload->>'diferencia')::int AS diferencia, (payload->>'causa_requerida')::boolean AS causa_requerida
         FROM assistant.stock_proposals
        WHERE business_id = $1 AND kind = 'conteo' AND status = 'pendiente' AND expires_at > $2 AND run_id IS NOT DISTINCT FROM $3
        ORDER BY recorded_at DESC`, [businessId, now, runId]);
    return rows;
  }

  private async item(businessId: string, runId: string | null, row: VariantRow, pending: PendingCount[], now: Date): Promise<Item> {
    const expected = await ledgerExpected(this.db, businessId, row.id, runId);
    const found = pending.find(item => item.variante_id === row.id || item.opciones?.includes(row.id));
    const shared = found?.opciones ? found : undefined;
    const open = shared ? undefined : found;
    const staleBefore = now.getTime() - STOCK_LIMITS.staleCountDays * 86_400_000;
    const estado = shared ? 'conteo_por_aprobar' : open ? (open.causa_requerida ? 'causa_preguntada' : 'conteo_por_aprobar')
      : expected.lastCountAt && expected.lastCountAt.getTime() >= staleBefore ? 'cuadra' : 'sin_conteo_reciente';
    return {
      variante_id: row.id, producto_id: row.product_id, producto: row.product, variante: row.variant,
      oferta: row.offering_id ? {id: row.offering_id, nombre: row.offering_name ?? ''} : null,
      ultimo_conteo: expected.lastCount, entradas: expected.inbound, ventas_reportadas: expected.sold, esperado: expected.expected,
      contado: open?.contado ?? expected.lastCount, contado_en: open ? iso(open.conteo_en) : iso(expected.lastCountAt), diferencia: open?.diferencia ?? (expected.lastCount === null ? null : 0),
      estado, propuesta_id: found?.id ?? null, simulado: runId !== null,
    };
  }

  async items(businessId: string): Promise<Items> {
    const runId = await activeRun(this.db, businessId);
    const now = await this.clock.at(businessId);
    const pending = await this.pendingCounts(businessId, runId);
    const {rows} = await this.db.query<VariantRow>(
      `SELECT v.id, v.product_id, p.name AS product, v.name AS variant, p.offering_id, p.offering_name
         FROM assistant.stock_variants v JOIN assistant.stock_products p ON p.id = v.product_id
        WHERE p.business_id = $1 AND p.run_id IS NOT DISTINCT FROM $2 AND NOT v.is_kit
          AND v.id NOT IN (SELECT alias_variant_id FROM assistant.stock_variant_aliases)
        ORDER BY p.name, v.name, v.id`, [businessId, runId]);
    const items: Item[] = [];
    for (const row of rows) items.push(await this.item(businessId, runId, row, pending, now));
    const {rows: kits} = await this.db.query<{id: string; name: string}>(
      `SELECT v.id, p.name FROM assistant.stock_variants v JOIN assistant.stock_products p ON p.id = v.product_id
        WHERE p.business_id = $1 AND p.run_id IS NOT DISTINCT FROM $2 AND v.is_kit ORDER BY p.name, v.id`, [businessId, runId]);
    const list: Items['kits'] = [];
    for (const kit of kits) {
      const {rows: parts} = await this.db.query<{variant_id: string; product: string; variant: string; quantity: number}>(
        `SELECT c.component_variant_id AS variant_id, p.name AS product, v.name AS variant, c.quantity
           FROM assistant.stock_kit_components c JOIN assistant.stock_variants v ON v.id = c.component_variant_id JOIN assistant.stock_products p ON p.id = v.product_id
          WHERE c.kit_variant_id = $1 ORDER BY p.name, v.id`, [kit.id]);
      let reach = parts.length ? Number.POSITIVE_INFINITY : 0;
      for (const part of parts) reach = Math.min(reach, Math.floor(Math.max(await ledgerBalance(this.db, businessId, part.variant_id, runId), 0) / part.quantity));
      list.push({id: kit.id, nombre: kit.name, estado: 'activo', componentes: parts.map(part => ({variante_id: part.variant_id, nombre: `${part.product} ${part.variant}`, cantidad: part.quantity})), alcanzan: reach, simulado: runId !== null});
    }
    return StockItemsV1.parse({items, kits: list});
  }

  async summary(businessId: string) {
    const runId = await activeRun(this.db, businessId);
    const [{items}, pending, currency, now] = [await this.items(businessId), await this.pendingCounts(businessId, runId), await businessCurrency(this.db, businessId), await this.clock.at(businessId)];
    const {rows} = await this.db.query<{proposals: number; orders: number; last: Date | null}>(
      `SELECT (SELECT count(*)::int FROM assistant.stock_proposals WHERE business_id = $1 AND status = 'pendiente' AND expires_at > $3 AND run_id IS NOT DISTINCT FROM $2) AS proposals,
              (SELECT count(*)::int FROM assistant.stock_orders WHERE business_id = $1 AND status IN ('aprobado','negociando','acordado','en_camino') AND run_id IS NOT DISTINCT FROM $2) AS orders,
              (SELECT max(counted_at) FROM assistant.stock_counts WHERE business_id = $1 AND confirmation_id IS NOT NULL AND run_id IS NOT DISTINCT FROM $2) AS last`, [businessId, runId, now]);
    return StockSummaryV1.parse({
      unidades_esperadas: items.reduce((sum, item) => sum + item.esperado, 0), diferencias_por_resolver: pending.filter(item => item.causa_requerida).length,
      propuestas_pendientes: rows[0]?.proposals ?? 0, pedidos_en_curso: rows[0]?.orders ?? 0, ultimo_conteo_en: iso(rows[0]?.last), moneda: currency, simulado: runId !== null,
    });
  }

  async overview(businessId: string) {
    const {items, kits} = await this.items(businessId);
    return StockOverviewV1.parse({resumen: await this.summary(businessId), items, kits});
  }

  async itemDetail(businessId: string, rawVariantId: string) {
    const runId = await activeRun(this.db, businessId);
    const found = await findVariant(this.db, businessId, rawVariantId, runId);
    if (!found || found.is_kit) throw notFound();
    const variantId = await canonicalOf(this.db, found.id);
    const variant = (await findVariant(this.db, businessId, variantId, runId))!;
    const item = (await this.items(businessId)).items.find(row => row.variante_id === variantId);
    if (!item) throw notFound();
    const expected = await ledgerExpected(this.db, businessId, variantId, runId);
    const {rows: confirmed} = await this.db.query<{method: 'web' | 'voz' | 'canal' | 'semilla'}>(
      `SELECT c.method FROM assistant.stock_counts s JOIN assistant.stock_confirmations c ON c.id = s.confirmation_id
        WHERE s.business_id = $1 AND s.variant_id = ANY($2::uuid[]) AND s.run_id IS NOT DISTINCT FROM $3 ORDER BY s.counted_at DESC, s.recorded_at DESC LIMIT 1`,
      [businessId, await variantGroup(this.db, variantId), runId]);
    const method = confirmed[0]?.method ?? null;
    return StockItemDetailV1.parse({item, saldo: await ledgerBalance(this.db, businessId, variantId, runId), ultimo_conteo_en: iso(expected.lastCountAt),
      ultimo_conteo_confirmado_por: method === 'canal' ? 'canal_atestiguado' : method,
      costo_unitario: money(variant.unit_cost), moneda: variant.currency, unidades_por_caja: variant.units_per_box});
  }

  async orders(businessId: string, filters: {status?: string; con_novedad?: boolean} = {}) {
    const runId = await activeRun(this.db, businessId);
    const {rows} = await this.db.query<{
      id: string; product: string; variant: string; quantity: number; supplier: string; expected_cost: string | null; agreed_cost: string | null; currency: string; status: string;
      novedad: string | null; received_qty: number | null; saving_confirmed: string | null; simulated: boolean;
    }>(
      `SELECT o.id, p.name AS product, v.name AS variant, o.quantity, s.name AS supplier, o.expected_cost, o.agreed_cost, o.currency, o.status, o.novedad, o.received_qty, o.saving_confirmed, o.simulated
         FROM assistant.stock_orders o JOIN assistant.stock_variants v ON v.id = o.variant_id JOIN assistant.stock_products p ON p.id = v.product_id JOIN assistant.stock_suppliers s ON s.id = o.supplier_id
        WHERE o.business_id = $1 AND o.run_id IS NOT DISTINCT FROM $2 AND ($3::text IS NULL OR o.status = $3) AND ($4::boolean IS NULL OR (o.novedad IS NOT NULL) = $4)
        ORDER BY o.recorded_at DESC, o.id`, [businessId, runId, filters.status ?? null, filters.con_novedad ?? null]);
    return StockOrdersV1.parse({pedidos: rows.map(row => ({
      id: row.id, producto: `${row.product} ${row.variant}`, cantidad: row.quantity, proveedor: row.supplier, costo: money(row.agreed_cost ?? row.expected_cost),
      costo_tipo: row.agreed_cost === null ? 'esperado' : 'acordado', moneda: row.currency, estado: row.status, novedad: row.novedad, pedido_cantidad: row.quantity,
      recibido_cantidad: row.received_qty, ahorro_confirmado: money(row.saving_confirmed), simulado: row.simulated,
    }))});
  }

  async suppliers(businessId: string, variantId?: string) {
    const runId = await activeRun(this.db, businessId);
    const {rows: suppliers} = await this.db.query<{id: string; name: string; contact_label: string | null; lead_time_days: number | null; simulated: boolean}>(
      `SELECT id, name, contact_label, lead_time_days, simulated FROM assistant.stock_suppliers WHERE business_id = $1 AND run_id IS NOT DISTINCT FROM $2 ORDER BY name, id`, [businessId, runId]);
    const proveedores = [];
    for (const supplier of suppliers) {
      const {rows: quotes} = await this.db.query<{variant_id: string; price: string; freight: string; min_qty: number; payment_term_days: number | null; warranty: string | null; equivalent_proof: unknown; currency: string}>(
        `SELECT variant_id, price, freight, min_qty, payment_term_days, warranty, equivalent_proof, currency FROM assistant.stock_supplier_quotes
          WHERE supplier_id = $1 AND ($2::uuid IS NULL OR variant_id = $2) ORDER BY recorded_at DESC, id`, [supplier.id, variantId ?? null]);
      if (variantId && !quotes.length) continue;
      proveedores.push({id: supplier.id, nombre: supplier.name, contacto: supplier.contact_label, dias_entrega: supplier.lead_time_days, simulado: supplier.simulated,
        cotizaciones: quotes.map(quote => ({variante_id: quote.variant_id, precio: money(quote.price), flete: money(quote.freight), minimo: quote.min_qty, plazo_pago_dias: quote.payment_term_days,
          garantia: quote.warranty, equivalencia: equivalenceOf(quote.equivalent_proof), moneda: quote.currency}))});
    }
    return StockSuppliersV1.parse({proveedores});
  }
}
