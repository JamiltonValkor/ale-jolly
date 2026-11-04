import {createHash} from 'node:crypto';
import type {z} from 'zod';
import {STOCK_SAY_TEXT_MAX, type StockAlertTypeV1, type StockPendingAlertV1, type StockRobotSayResultV1} from '../contracts/stock-v1';
import type {StockClock} from './clock';
import type {Notices} from './notices';
import type {Rotation} from './rotation';
import {activeRun, type StockQuery} from './store';
import type {Suppliers} from './suppliers';

type AlertType = z.infer<typeof StockAlertTypeV1>;
type SayResult = z.infer<typeof StockRobotSayResultV1>;
type ActiveAlert = StockPendingAlertV1;

/**
 * Id estable de un aviso: el mismo negocio, corrida, variante, tipo y `estado_desde` dan siempre el mismo id. Tiene
 * forma de UUID (versión 5 sobre SHA-256) para viajar por los esquemas estrictos.
 */
export function alertId(input: {businessId: string; runId: string | null; variantId: string; tipo: AlertType; desde: Date | null}): string {
  const raw = [input.businessId, input.runId ?? 'real', input.variantId, input.tipo, input.desde?.toISOString() ?? 'sin_fecha'].join('|');
  const bytes = createHash('sha256').update(raw).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const decimal = (value: number): string => String(Number(value.toFixed(1))).replace('.', ',');
const MARKETING = '¿Se lo paso a marketing para que lo mueva?';
const ORDER = '¿Le pido a Stock que prepare el pedido?';

/** La frase la escribe el servidor con las cifras de este momento. El modelo no aporta texto ni números. */
function sentence(tipo: AlertType, producto: string, c: ActiveAlert['cifras'], simulado: boolean): string {
  const body = {
    frenazo: `${producto} vendía ${decimal(c.base_semanal)} por semana y lleva ${c.dias_sin_venta ?? 0} días sin ventas. Quedan ${c.saldo}. ${MARKETING}`,
    lento: `${producto} se mueve lento: ${decimal(c.base_semanal)} por semana. Quedan ${c.saldo}. ${MARKETING}`,
    sin_pauta: `${producto} vende ${decimal(c.base_semanal)} por semana sin pauta y lo que hay cubre ${decimal(c.cobertura_dias ?? 0)} días. ${MARKETING}`,
    cobertura: `${producto} alcanza para ${decimal(c.cobertura_dias ?? 0)} días y pedir toma ${c.punto_pedido_dias ?? 0} con el colchón. Quedan ${c.saldo}. ${ORDER}`,
    pegando: `${producto} está pegando con la pauta: vende ${decimal(c.ritmo_actual_semana)} por semana. Quedan ${c.saldo}, para ${decimal(c.dias_cobertura_al_ritmo_actual ?? 0)} días. ${ORDER}`,
  }[tipo];
  const mark = simulado ? ' Datos simulados.' : '';
  // Si no cabe, se acorta el nombre del producto y nunca las cifras ni la pregunta.
  const overflow = body.length + mark.length - STOCK_SAY_TEXT_MAX;
  if (overflow <= 0) return `${body}${mark}`;
  return sentence(tipo, `${producto.slice(0, Math.max(producto.length - overflow - 1, 8))}…`, c, false).slice(0, STOCK_SAY_TEXT_MAX - mark.length) + mark;
}

/**
 * IVB-024: los avisos los calcula el servidor, con el mismo cálculo de rotación de `bet-signal`. Qué ya se dijo lo sabe
 * la tabla de eventos de voz (la clave `alerta:<alerta_id>`), no la memoria del modelo: un tick nuevo no repite lo
 * dicho y una sesión larga no puede callar lo pendiente.
 */
export class StockAlerts {
  constructor(private readonly deps: {db: StockQuery; clock: StockClock; rotation: Rotation; suppliers: Suppliers; notices: Notices}) {}

  /** Avisos activos ahora, en la corrida activa. Orden estable: producto, variante y tipo. */
  async active(businessId: string): Promise<ActiveAlert[]> {
    const {db, clock, rotation, suppliers} = this.deps;
    const runId = await activeRun(db, businessId);
    const now = await clock.at(businessId);
    const {rows} = await db.query<{id: string; product_id: string; product: string; variant: string}>(
      `SELECT v.id, p.id AS product_id, p.name AS product, v.name AS variant FROM assistant.stock_variants v JOIN assistant.stock_products p ON p.id = v.product_id
        WHERE p.business_id = $1 AND p.run_id IS NOT DISTINCT FROM $2 AND v.id NOT IN (SELECT alias_variant_id FROM assistant.stock_variant_aliases)
        ORDER BY p.name, v.name, v.id`, [businessId, runId]);
    const alerts: ActiveAlert[] = [];
    for (const row of rows) {
      const state = await rotation.alertState(businessId, row.id, runId, now);
      if (!state || state.saldo <= 0) continue;
      const plan = state.variant.is_kit ? null : await suppliers.plan(businessId, row.id);
      const fastest = plan?.opciones.filter(option => option.elegible && option.fecha_pedido !== null).sort((a, b) => a.punto_pedido_dias - b.punto_pedido_dias)[0] ?? null;
      const cifras: ActiveAlert['cifras'] = {
        saldo: state.saldo, base_semanal: state.base, actual_semanal: state.actual, dias_sin_venta: state.daysSilent, cobertura_dias: fastest?.cobertura_dias ?? state.coverage,
        punto_pedido_dias: fastest?.punto_pedido_dias ?? null, ritmo_actual_semana: state.hot.ritmo_actual_semana, dias_cobertura_al_ritmo_actual: state.hot.dias_cobertura_al_ritmo_actual,
      };
      const found: Array<{tipo: AlertType; desde: Date | null}> = [];
      // Estancado: el ancla es la última venta. Una venta nueva limpia el frenazo; si vuelve, es otro aviso.
      if (state.estado === 'frenazo' || state.estado === 'lento') found.push({tipo: state.estado, desde: state.lastSale});
      // Sin pauta y cobertura cambian con lo que entra: el ancla es la última entrada.
      if (state.estado === 'sin_pauta') found.push({tipo: 'sin_pauta', desde: state.lastInflow});
      if (fastest && fastest.cobertura_dias !== null && fastest.cobertura_dias < fastest.punto_pedido_dias) found.push({tipo: 'cobertura', desde: state.lastInflow});
      // Pegando: una vez por apuesta.
      if (state.hot.pegando) found.push({tipo: 'pegando', desde: state.betStart});
      const producto = `${row.product} ${row.variant}`;
      for (const {tipo, desde} of found) {
        alerts.push({
          alerta_id: alertId({businessId, runId, variantId: state.variant.id, tipo, desde}), tipo, variante_id: state.variant.id, producto_id: row.product_id, producto,
          estado_desde: desde?.toISOString() ?? null, siguiente: tipo === 'cobertura' || tipo === 'pegando' ? 'pedido' : 'marketing',
          texto: sentence(tipo, producto, cifras, runId !== null), pregunta: true, simulado: runId !== null, cifras,
        });
      }
    }
    return alerts;
  }

  /** Lo activo que todavía no tiene evento de voz en esta corrida. */
  async pending(businessId: string): Promise<ActiveAlert[]> {
    const active = await this.active(businessId);
    const said = await this.deps.notices.alertEvents(this.deps.db, businessId, active.map(alert => alert.alerta_id));
    return active.filter(alert => !said.has(alert.alerta_id));
  }

  /** `robot_say` con `alerta_id`: solo un aviso activo ahora se dice, con la frase del servidor. */
  async say(userId: string, businessId: string, alertaId: string, prioridad: 'normal' | 'alta'): Promise<SayResult> {
    const alert = (await this.active(businessId)).find(item => item.alerta_id === alertaId);
    if (!alert) {
      // Ya dicho y ya limpio a la vez: se informa el evento para que Ale no lo repita ni crea que falta.
      const said = (await this.deps.notices.alertEvents(this.deps.db, businessId, [alertaId])).get(alertaId);
      return said ? this.deps.notices.repeated(said) : {status: 'no_vigente'};
    }
    return this.deps.notices.sayAlert(userId, businessId, {alertaId, productId: alert.producto_id, texto: alert.texto, prioridad});
  }
}
