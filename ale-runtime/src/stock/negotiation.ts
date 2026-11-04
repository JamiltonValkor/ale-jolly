import {Logger} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {StockSupplierSendInputV1, StockSupplierSendResultV1, StockSupplierWaitInputV1, StockSupplierWaitResultV1} from '../contracts/stock-v1';
import {conflict, notFound, serviceUnavailable} from '../domain/errors';
import {argsHash, writeAudit} from './audit';
import type {Autonomy} from './autonomy';
import type {StockClock} from './clock';
import {STOCK_LIMITS, STOCK_NEGOTIATION} from './config';
import type {WakeReason} from './wake';
import type {Notices} from './notices';
import type {SupplierChannel} from './supplier-channel';
import {activeRun, withoutHidden, type StockDb, type StockQuery} from './store';

type SendInput = z.infer<typeof StockSupplierSendInputV1>;
type SendResult = z.infer<typeof StockSupplierSendResultV1>;
type WaitInput = z.infer<typeof StockSupplierWaitInputV1>;
type WaitResult = z.infer<typeof StockSupplierWaitResultV1>;

const SENDERLESS = 'Hola, soy el asistente virtual del negocio.';
/** Una presentación propia al inicio del mensaje, hasta el primer punto. */
const INTRO = /^\s*(?:hola[,!.]?\s*)?(?:soy|te escribe)\s+(?:el|la|tu|un|una)?\s*asistente virtual[^.!?\n]*[.!?]?\s*/i;
const LIVE_STATES = ['abierta', 'esperando_proveedor', 'esperando_stock'];
/** Lo bloqueado por cifras o datos de cliente no deja copia: un teléfono cae en cifras, y el motivo basta para auditarlo. */
const WITHHELD = new Set(['dato_cliente', 'cifra_fuera_de_marcador']);
const WINDOW_CLOSED = 'ventana_cerrada: el proveedor debe escribir primero. No reintentes; avísale a Ale.';

const plainText = (text: string): string => text.normalize('NFKC').replace(/\p{Cf}/gu, '');
const folded = (text: string): string => plainText(text).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const hasPhrase = (text: string, phrases: readonly string[]): boolean => phrases.some(phrase => new RegExp(`(^|[^a-zñ])${phrase}($|[^a-zñ])`).test(text));

/** Reglas 4, 5 y 7 sobre lo que escribió el modelo, antes de llenar marcadores. Devuelve el motivo o `null`. */
export function textProblem(text: string, input: {cierre: boolean}): string | null {
  const bare = plainText(text).replace(/\{(oferta|precio_proveedor|cantidad)\}/g, ' ');
  if (/[{}]/.test(bare)) return 'marcador_desconocido';
  const plain = folded(bare);
  // Lo que se acuerda va solo por marcadores: «900 unidades» en un cierre contradiría lo que queda guardado.
  if (input.cierre && /\p{Nd}/u.test(plain)) return 'cifra_fuera_de_marcador';
  const moneyWord = plain.split(/[^a-zñ]+/).some(word => (STOCK_NEGOTIATION.moneyWords as readonly string[]).includes(word));
  // Corre también sobre números partidos y otras escrituras: «18 501», «1/8/5/0/1», «١٨٥٠١» y «18ooo» son la misma cifra.
  if (/[$€£]/.test(plain) || /\p{Nd}(?:[^\p{L}\p{Nd}]{0,3}\p{Nd}){3,}/u.test(plain) || /\p{Nd}o{2,}/u.test(plain) || /\p{Nd}\s*k\b/u.test(plain) || moneyWord) return 'cifra_fuera_de_marcador';
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(plain)) return 'dato_cliente';
  if (hasPhrase(plain, STOCK_NEGOTIATION.falseIdentity)) return 'identidad_falsa';
  if (hasPhrase(plain, STOCK_NEGOTIATION.paymentPromises)) return 'promesa_de_pago';
  if (!input.cierre && hasPhrase(plain, STOCK_NEGOTIATION.closingPhrases)) return 'compra_sin_cierre';
  return null;
}

const toNumber = (raw: string, unit: string | undefined): number => {
  const parts = raw.split(/[.,]/);
  const grouped = parts.length > 1 && parts.slice(1).every(part => part.length === 3);
  const value = grouped ? Number(parts.join('')) : Number(raw.replace(',', '.'));
  return unit ? value * 1000 : value;
};

/**
 * Precio escrito por el proveedor. Solo sirve para citárselo de vuelta con `{precio_proveedor}`, nunca para decidir. Con
 * más de un monto distinto en el mensaje no se adivina cuál es: `null`.
 */
export function supplierPriceIn(text: string): string | null | undefined {
  const amounts = new Set<number>();
  for (const match of folded(text).matchAll(/(\$\s*)?(\d+(?:[.,]\d+)*)\s*(mil\b|k\b)?/g)) {
    const value = toNumber(match[2]!, match[3]);
    if (match[1] || match[3] || value >= STOCK_NEGOTIATION.minPlainPrice) amounts.add(value);
  }
  if (!amounts.size) return undefined;
  return amounts.size === 1 ? [...amounts][0]!.toFixed(2) : null;
}

/** Lo que escribe el proveedor entra como dato: una línea, sin caracteres ocultos y con largo acotado. */
export const inboundText = (text: string): string => withoutHidden(text).replace(/\s+/g, ' ').trim().slice(0, STOCK_NEGOTIATION.maxTextChars);

type Closable = Pick<OrderRow, 'id' | 'user_id' | 'business_id' | 'proposal_id'> & {product: string; supplier: string};
interface SweepDeps {clock: Pick<StockClock, 'at'>; notices: Pick<Notices, 'template'>}

function notifyOrder(notices: SweepDeps['notices'], tx: StockQuery, order: Pick<OrderRow, 'id' | 'user_id' | 'business_id' | 'proposal_id'>, texto: string, stage: string): Promise<void> {
  return notices.template(tx, {userId: order.user_id, businessId: order.business_id, proposalId: order.proposal_id, productId: null, texto: texto.replace(/\s+/g, ' ').slice(0, 240), pregunta: false,
    plantilla: 'pedido', dedupeKey: `pedido:${order.id}:${stage}`});
}

/** Sin esto un pedido sin acuerdo tendría ocupada para siempre la única cola con el proveedor. */
async function closeOrder(tx: StockQuery, notices: SweepDeps['notices'], order: Closable, state: 'sin_acuerdo' | 'expirada', texto: string): Promise<void> {
  await tx.query(`UPDATE assistant.stock_negotiations SET state = $2 WHERE order_id = $1`, [order.id, state]);
  await tx.query(`UPDATE assistant.stock_orders SET status = 'cancelado', novedad = NULL WHERE id = $1`, [order.id]);
  await writeAudit(tx, {businessId: order.business_id, traceId: order.proposal_id, actor: 'servidor', action: `negociacion_${state}`, entity: 'stock_orders', entityId: order.id, args: {state}});
  await notifyOrder(notices, tx, order, texto, state);
}

/**
 * Vence lo abandonado. `updated_at` guarda la última actividad en el reloj del negocio, así que un salto de reloj también
 * cuenta. Corre con el candado de la cola: el temporizador y la apertura de un pedido no se pisan.
 */
export async function expireAbandoned(tx: StockQuery, deps: SweepDeps): Promise<void> {
  const {rows} = await tx.query<Closable & {updated_at: Date}>(
    `SELECT o.id, o.user_id, o.business_id, o.proposal_id, s.name AS supplier, p.name AS product, n.updated_at
       FROM assistant.stock_orders o JOIN assistant.stock_negotiations n ON n.order_id = o.id JOIN assistant.stock_suppliers s ON s.id = o.supplier_id
       JOIN assistant.stock_variants v ON v.id = o.variant_id JOIN assistant.stock_products p ON p.id = v.product_id
      WHERE o.status = 'negociando' AND n.state = ANY($1::text[]) FOR UPDATE OF o`, [LIVE_STATES]);
  for (const order of rows) {
    const now = await deps.clock.at(order.business_id, tx);
    if (now.getTime() - new Date(order.updated_at).getTime() < STOCK_NEGOTIATION.abandonedHours * 3_600_000) continue;
    await closeOrder(tx, deps.notices, order, 'expirada', `La negociación de ${order.product} con ${order.supplier} venció sin acuerdo. Míralo en la pantalla de Stock.`);
  }
}

const lockQueue = (tx: StockQuery) => tx.query(`SELECT pg_advisory_xact_lock(hashtext('stock_supplier_queue'))`);

/** R30, en un solo sitio: la cola es una y el número es uno, sin importar negocio ni corrida. */
export async function openOrder(tx: StockQuery, input: {
  businessId: string; userId: string; variantId: string; supplierId: string; quantity: number; expectedCost: string; baseUnitCost: string | null; currency: string; proposalId: string;
  now: Date; simulated: boolean; runId: string | null; target: string; max: string; sweep(tx: StockQuery): Promise<void>;
}): Promise<string> {
  await lockQueue(tx);
  await input.sweep(tx);
  const {rows} = await tx.query(`SELECT 1 FROM assistant.stock_orders WHERE status IN ('aprobado','negociando') LIMIT 1`);
  if (rows.length) throw conflict();
  const id = randomUUID();
  await tx.query(
    `INSERT INTO assistant.stock_orders(id,business_id,user_id,variant_id,supplier_id,quantity,status,expected_cost,base_unit_cost,currency,proposal_id,occurred_at,simulated,run_id)
     VALUES ($1,$2,$3,$4,$5,$6,'negociando',$7,$8,$9,$10,$11,$12,$13)`,
    [id, input.businessId, input.userId, input.variantId, input.supplierId, input.quantity, input.expectedCost, input.baseUnitCost, input.currency, input.proposalId, input.now, input.simulated, input.runId]);
  await tx.query('INSERT INTO assistant.stock_negotiations(order_id,target_price,max_price,max_quantity,updated_at) VALUES ($1,$2,$3,$4,$5)', [id, input.target, input.max, input.quantity, input.now]);
  return id;
}

interface OrderRow {
  id: string; user_id: string; business_id: string; status: string; currency: string; proposal_id: string; supplier_id: string; variant_id: string; supplier: string; product: string;
  state: string | null; target_price: string; max_price: string; max_quantity: number; round: number; last_offer: string | null;
}
const ORDER = `SELECT o.id, o.user_id, o.business_id, o.status, o.currency, o.proposal_id, o.supplier_id, o.variant_id, s.name AS supplier, p.name AS product,
                      n.state, n.target_price, n.max_price, n.max_quantity, n.round, n.last_offer
                 FROM assistant.stock_orders o JOIN assistant.stock_negotiations n ON n.order_id = o.id JOIN assistant.stock_suppliers s ON s.id = o.supplier_id
                 JOIN assistant.stock_variants v ON v.id = o.variant_id JOIN assistant.stock_products p ON p.id = v.product_id
                WHERE o.id = $1 AND o.business_id = $2 AND o.run_id IS NOT DISTINCT FROM $3`;

interface MessageRow {id: string; sent_at: Date | null; blocked_reason: string | null; idempotency_key: string; body: string}
type Reserved = {result: SendResult} | {message: {id: string; body: string}};

export interface NegotiationDeps {
  db: StockDb; clock: StockClock; autonomy: Pick<Autonomy, 'assert'>; notices: Pick<Notices, 'template'>; channel: SupplierChannel | undefined; now: () => Date;
  wake(userId: string, businessId: string, reason: WakeReason): Promise<unknown>;
  senderName: string; waitMs: number; sleep?(ms: number): Promise<void>;
}

/**
 * Negociación persistente: todo el estado vive en base, así que un worker o un pod caídos no pierden nada. El servidor es
 * la barrera del mandato. Lo que escribe el proveedor nunca cambia un dato: entra como mensaje y sale marcado.
 */
export class Negotiation {
  private readonly logger = new Logger('StockNegotiation');
  private timer: NodeJS.Timeout | undefined;
  private polling: Promise<void> | undefined;

  constructor(private readonly deps: NegotiationDeps) {}

  private get channel(): SupplierChannel {
    if (!this.deps.channel) throw serviceUnavailable();
    return this.deps.channel;
  }

  // ---- Enviar ------------------------------------------------------------------------------------------------------

  async send(userId: string, businessId: string, input: SendInput): Promise<SendResult> {
    const channel = this.channel;
    await this.deps.autonomy.assert(businessId, 'negociacion', 2);
    const stored = `${input.idempotency_key}:${argsHash({...input, idempotency_key: undefined})}`;
    const reserved = await this.deps.db.tx(tx => this.reserve(tx, userId, businessId, input, stored));
    if ('result' in reserved) return reserved.result;
    const {message} = reserved;
    const outcome = await channel.send({idempotencyKey: stored, body: message.body});
    if (outcome.status === 'ventana_cerrada') {
      await this.deps.db.query('UPDATE assistant.stock_supplier_messages SET blocked_reason = $2 WHERE id = $1', [message.id, 'ventana_cerrada']);
      return {status: 'bloqueado', motivo: WINDOW_CLOSED};
    }
    await this.deps.db.tx(tx => this.settle(tx, businessId, input, message.id, outcome));
    return {status: 'enviado', mensaje_id: message.id};
  }

  /** Bajo el candado del pedido: las validaciones y la reserva son una sola decisión, en el orden de la tarea. */
  private async reserve(tx: StockQuery, userId: string, businessId: string, input: SendInput, stored: string): Promise<Reserved> {
    const runId = await activeRun(tx, businessId);
    const {rows} = await tx.query<OrderRow>(`${ORDER} FOR UPDATE OF o`, [input.order_id, businessId, runId]);
    const order = rows[0];
    if (!order || order.user_id !== userId) return {result: {status: 'bloqueado', motivo: 'pedido_no_disponible'}};
    const live = order.status === 'negociando' && LIVE_STATES.includes(order.state ?? '');
    const repeated = await this.repeated(tx, order.id, input.idempotency_key, stored);
    // Reintentar un envío a medias no revive un pedido que ya cerró o venció.
    if (repeated) return !live && 'message' in repeated ? {result: {status: 'bloqueado', motivo: 'pedido_no_negociando'}} : repeated;
    const {cierre} = input;
    const firstProblem = textProblem(input.texto, {cierre});
    const block = async (motivo: string, shown: string = motivo): Promise<Reserved> => {
      // Vale para todo bloqueo: el primero en saltar puede no ser el de la cifra o el dato de cliente.
      await this.record(tx, order.id, WITHHELD.has(motivo) || WITHHELD.has(firstProblem ?? '') ? '[retenido]' : input.texto, stored, motivo);
      return {result: {status: 'bloqueado', motivo: shown}};
    };
    if (!live) return block('pedido_no_negociando');
    const {rows: sent} = await tx.query<{n: number}>(
      `SELECT count(*)::int AS n FROM assistant.stock_supplier_messages WHERE order_id = $1 AND direction = 'saliente' AND blocked_reason IS NULL`, [order.id]);
    const count = sent[0]!.n;
    if (count >= STOCK_NEGOTIATION.maxMessages) {
      await this.closeWithoutDeal(tx, order);
      return block('tope_mensajes');
    }
    const {precio_unitario_ofrecido: offer, cantidad} = input;
    if (offer !== null && Number(offer) > Number(order.max_price)) return block('sobre_tope');
    if (cantidad !== null && cantidad > order.max_quantity) return block('cantidad_sobre_mandato');
    if (firstProblem) return block(firstProblem);
    const uses = (marker: string): boolean => input.texto.includes(`{${marker}}`);
    if (uses('oferta') && offer === null) return block('falta_oferta');
    if (uses('cantidad') && cantidad === null) return block('falta_cantidad');
    const supplierPrice = uses('precio_proveedor') ? await this.supplierPrice(tx, order) : null;
    if (uses('precio_proveedor') && supplierPrice === null) return block('sin_precio_proveedor');
    if (supplierPrice !== null) {
      // El marcador trae al texto un monto que el mandato no revisa: «Sí, {precio_proveedor}» aceptaría sobre el tope.
      if (cierre && Number(supplierPrice) !== Number(offer)) return block('cierre_con_otro_precio');
      if (Number(supplierPrice) > Number(order.max_price) && !uses('oferta')) return block('cita_sobre_tope_sin_oferta');
    }
    if (cierre) {
      if (offer === null || cantidad === null) return block('cierre_incompleto');
      if (!uses('oferta') || !uses('cantidad')) return block('cierre_sin_marcadores');
      // Se cierra sobre una respuesta sin contestar: un acuerdo de un solo lado sería una oferta inventada.
      if (order.state !== 'esperando_stock') return block('sin_respuesta_proveedor');
      // Se cierra a lo último que dijo el proveedor o, si no dio cifra, a la oferta que contestó. Ambiguo no se adivina.
      const {rows: last} = await tx.query<{body: string}>(`SELECT body FROM assistant.stock_supplier_messages WHERE order_id = $1 AND direction = 'entrante' ORDER BY recorded_at DESC, id LIMIT 1`, [order.id]);
      const said = last[0] ? supplierPriceIn(last[0].body) : null;
      const agreed = said === undefined ? order.last_offer : said;
      if (agreed === null || Number(agreed) !== Number(offer)) return block('cierre_con_otro_precio');
    }
    const shown = (amount: string): string => `${Number(amount).toLocaleString('es-CO', {maximumFractionDigits: 2})} ${order.currency}`;
    let body = input.texto.replaceAll('{oferta}', offer === null ? '' : shown(offer)).replaceAll('{precio_proveedor}', supplierPrice === null ? '' : shown(supplierPrice))
      .replaceAll('{cantidad}', cantidad === null ? '' : String(cantidad));
    if (count === 0) body = this.introduced(body);
    if (body.length > STOCK_NEGOTIATION.maxTextChars) return block('texto_largo');
    return {message: {id: await this.record(tx, order.id, body, stored, null), body}};
  }

  /**
   * R29. IVB-024 (oficial, paso 7): Stock se presentó como «asistente virtual del negocio», sin el nombre. Con nombre
   * configurado, una presentación sin él se cambia por el saludo del servidor. Sin nombre, vale cualquier presentación.
   */
  private introduced(body: string): string {
    const name = this.deps.senderName;
    if (name && !folded(body).includes(folded(name))) return `${this.greeting()} ${body.replace(INTRO, '')}`.trim();
    return folded(body).includes('asistente virtual') ? body : `${this.greeting()} ${body}`;
  }

  private greeting(): string {
    return this.deps.senderName ? `Hola, soy el asistente virtual de ${this.deps.senderName}.` : SENDERLESS;
  }

  private async repeated(tx: StockQuery, orderId: string, key: string, stored: string): Promise<Reserved | null> {
    const {rows} = await tx.query<MessageRow>(
      `SELECT id, sent_at, blocked_reason, idempotency_key, body FROM assistant.stock_supplier_messages
        WHERE order_id = $1 AND direction = 'saliente' AND left(idempotency_key, length($2) + 1) = $2 || ':' ORDER BY recorded_at LIMIT 1`, [orderId, key]);
    const row = rows[0];
    if (!row) return null;
    if (row.idempotency_key !== stored) throw conflict();
    if (row.blocked_reason) return {result: {status: 'bloqueado', motivo: row.blocked_reason === 'ventana_cerrada' ? WINDOW_CLOSED : row.blocked_reason}};
    return row.sent_at ? {result: {status: 'enviado', mensaje_id: row.id}} : {message: {id: row.id, body: row.body}};
  }

  private async record(tx: StockQuery, orderId: string, body: string, stored: string, blocked: string | null): Promise<string> {
    const id = randomUUID();
    await tx.query(
      `INSERT INTO assistant.stock_supplier_messages(id,order_id,direction,body,blocked_reason,idempotency_key) VALUES ($1,$2,'saliente',$3,$4,$5)`,
      [id, orderId, body, blocked, stored]);
    return id;
  }

  /** `{precio_proveedor}` solo se llena con lo guardado: el último mensaje con un monto o, sin ninguno, la cotización. */
  private async supplierPrice(q: StockQuery, order: Pick<OrderRow, 'id' | 'supplier_id' | 'variant_id'>): Promise<string | null> {
    const {rows} = await q.query<{body: string}>(
      `SELECT body FROM assistant.stock_supplier_messages WHERE order_id = $1 AND direction = 'entrante' ORDER BY recorded_at DESC, id`, [order.id]);
    for (const {body} of rows) {
      const price = supplierPriceIn(body);
      if (price !== undefined) return price;
    }
    const {rows: quotes} = await q.query<{price: string}>(
      'SELECT price FROM assistant.stock_supplier_quotes WHERE supplier_id = $1 AND variant_id = $2 ORDER BY recorded_at DESC, id LIMIT 1', [order.supplier_id, order.variant_id]);
    return quotes[0] ? Number(quotes[0].price).toFixed(2) : null;
  }

  private async settle(tx: StockQuery, businessId: string, input: SendInput, messageId: string, outcome: {externalId: string; destinationHash: string}): Promise<void> {
    const now = await this.deps.clock.at(businessId, tx);
    const {rows: marked} = await tx.query(
      `UPDATE assistant.stock_supplier_messages SET sent_at = $2, wamid = $3, wa_id_hash = $4 WHERE id = $1 AND sent_at IS NULL RETURNING id`,
      [messageId, now, outcome.externalId, outcome.destinationHash]);
    if (!marked.length) return;
    const {order_id: orderId, precio_unitario_ofrecido: offer, cantidad, cierre} = input;
    // Si venció mientras salía el mensaje, lo cerrado sigue cerrado: un `cierre` tardío no revive el pedido.
    const {rows: open} = await tx.query(
      `UPDATE assistant.stock_negotiations SET state = $2, round = round + 1, last_offer = COALESCE($3, last_offer), updated_at = $4 WHERE order_id = $1 AND state = ANY($5::text[]) RETURNING order_id`,
      [orderId, cierre ? 'acordada' : 'esperando_proveedor', offer, now, LIVE_STATES]);
    if (!open.length || !cierre) return;
    const agreed = (Math.round(Number(offer) * 100) * cantidad! / 100).toFixed(2);
    const {rows} = await tx.query<OrderRow>(
      `UPDATE assistant.stock_orders SET status = 'acordado', quantity = $2, agreed_cost = $3, novedad = NULL WHERE id = $1 RETURNING id, user_id, business_id, proposal_id`, [orderId, cantidad, agreed]);
    const {rows: names} = await tx.query<{supplier: string; product: string}>(
      `SELECT s.name AS supplier, p.name AS product FROM assistant.stock_orders o JOIN assistant.stock_suppliers s ON s.id = o.supplier_id
         JOIN assistant.stock_variants v ON v.id = o.variant_id JOIN assistant.stock_products p ON p.id = v.product_id WHERE o.id = $1`, [orderId]);
    // Sin cifras: la plata solo se ve en la pantalla de Stock.
    await notifyOrder(this.deps.notices, tx, rows[0]!, `Quedó acordado el pedido de ${names[0]!.product} con ${names[0]!.supplier}. Míralo en la pantalla de Stock: nada se pagó ni se confirmó.`, 'acordado');
  }

  private closeWithoutDeal(tx: StockQuery, order: OrderRow): Promise<void> {
    return closeOrder(tx, this.deps.notices, order, 'sin_acuerdo', `El pedido de ${order.product} con ${order.supplier} terminó sin acuerdo. Míralo en la pantalla de Stock.`);
  }

  /** Pasada del temporizador. Abrir un pedido hace lo mismo, por si el temporizador no alcanzó a correr. */
  sweep(): Promise<void> {
    return this.deps.db.tx(async tx => {
      await lockQueue(tx);
      await expireAbandoned(tx, this.deps);
    });
  }

  /** Solo el dueño, por web: Stock no tiene cómo. Repetir no falla, y lo acordado o recibido ya no se cancela aquí. */
  async cancel(userId: string, businessId: string, orderId: string): Promise<void> {
    await this.deps.db.tx(async tx => {
      const runId = await activeRun(tx, businessId);
      const {rows} = await tx.query<OrderRow>(`${ORDER} FOR UPDATE OF o`, [orderId, businessId, runId]);
      const order = rows[0];
      if (!order || order.user_id !== userId) throw notFound();
      if (order.status === 'cancelado') return;
      if (order.status !== 'negociando') throw conflict();
      await closeOrder(tx, this.deps.notices, order, 'sin_acuerdo', `Cancelaste el pedido de ${order.product} con ${order.supplier}.`);
      await writeAudit(tx, {businessId, traceId: order.proposal_id, actor: userId, action: 'pedido_cancelado', entity: 'stock_orders', entityId: order.id, args: {motivo: 'dueno'}});
    });
  }

  // ---- Recibir -----------------------------------------------------------------------------------------------------

  /** Una sola pasada a la vez. El cursor avanza con cada mensaje guardado: tras un reinicio no se pierde ni se repite nada. */
  async tick(): Promise<void> {
    if (!this.deps.channel) return;
    this.polling ??= this.poll().finally(() => {this.polling = undefined;});
    return this.polling;
  }

  private async poll(): Promise<void> {
    const {db} = this.deps;
    await db.query('INSERT INTO assistant.stock_relay_state(id) VALUES (1) ON CONFLICT (id) DO NOTHING');
    const {rows} = await db.query<{cursor: string}>('SELECT cursor FROM assistant.stock_relay_state WHERE id = 1');
    for (const message of await this.channel.poll(Number(rows[0]!.cursor))) {
      const order = await db.tx(async tx => {
        const open = await tx.query<OrderRow>(
          `SELECT o.id, o.user_id, o.business_id FROM assistant.stock_orders o JOIN assistant.stock_negotiations n ON n.order_id = o.id
            WHERE o.status = 'negociando' AND n.state = ANY($1::text[]) ORDER BY o.recorded_at DESC LIMIT 1 FOR UPDATE OF o`, [LIVE_STATES]);
        const target = open.rows[0];
        const {rows: inserted} = await tx.query(
          `INSERT INTO assistant.stock_supplier_messages(id,order_id,direction,body,relay_id) VALUES ($1,$2,'entrante',$3,$4) ON CONFLICT (relay_id) DO NOTHING RETURNING id`,
          [randomUUID(), target?.id ?? null, inboundText(message.body), message.relayId]);
        await tx.query('UPDATE assistant.stock_relay_state SET cursor = GREATEST(cursor, $1), updated_at = now() WHERE id = 1', [message.cursor]);
        if (!target || !inserted.length) return null;
        await tx.query(`UPDATE assistant.stock_orders SET novedad = 'respuesta_proveedor' WHERE id = $1`, [target.id]);
        await tx.query(`UPDATE assistant.stock_negotiations SET state = 'esperando_stock', updated_at = $2 WHERE order_id = $1`, [target.id, await this.deps.clock.at(target.business_id, tx)]);
        return target;
      });
      if (order) await this.deps.wake(order.user_id, order.business_id, 'respuesta_proveedor').catch(() => undefined);
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void Promise.all([this.tick(), this.sweep()]).catch(error => this.logger.warn(`poller: ${(error as Error).name}`)), STOCK_LIMITS.supplierPollMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.polling?.catch(() => undefined);
  }

  /** Stock retoma con `after: 0`: el historial sale de aquí, no de la memoria del worker. */
  async wait(businessId: string, input: WaitInput): Promise<WaitResult> {
    const {db} = this.deps;
    if (!this.deps.channel) throw serviceUnavailable();
    const runId = await activeRun(db, businessId);
    const sleep = this.deps.sleep ?? (async (ms: number) => {await new Promise(resolve => setTimeout(resolve, ms));});
    const after = input.after ?? 0;
    const deadline = this.deps.now().getTime() + this.deps.waitMs;
    for (;;) {
      await this.tick().catch(error => this.logger.warn(`poller: ${(error as Error).name}`));
      const {rows} = await db.query<OrderRow>(ORDER, [input.order_id, businessId, runId]);
      const order = rows[0];
      if (!order) throw notFound();
      const {rows: messages} = await db.query<{id: string; direction: 'saliente' | 'entrante'; body: string; at: Date}>(
        `SELECT id, direction, body, COALESCE(sent_at, recorded_at) AS at FROM assistant.stock_supplier_messages
          WHERE order_id = $1 AND blocked_reason IS NULL AND (direction = 'entrante' OR sent_at IS NOT NULL) ORDER BY recorded_at, id`, [order.id]);
      const fresh = messages.slice(after).slice(-STOCK_NEGOTIATION.maxShownMessages);
      const heard = fresh.some(message => message.direction === 'entrante');
      if (heard || !LIVE_STATES.includes(order.state ?? '') || this.deps.now().getTime() >= deadline) {
        await db.query('UPDATE assistant.stock_negotiations SET last_message_cursor = $2 WHERE order_id = $1', [order.id, messages.length]);
        if (heard) await db.query('UPDATE assistant.stock_orders SET novedad = NULL WHERE id = $1', [order.id]);
        return {
          status: heard ? 'respuesta' : 'sin_novedad', cursor: messages.length, estado_negociacion: order.state!,
          mensajes: fresh.map(message => {
            const foreign = message.direction === 'entrante';
            return {id: message.id, direccion: message.direction, texto: message.body, en: new Date(message.at).toISOString(), no_confiable: foreign,
              trae_instruccion: foreign && (STOCK_NEGOTIATION.injectionHints as readonly string[]).some(hint => folded(message.body).includes(hint))};
          }),
          mandato: {precio_objetivo: Number(order.target_price).toFixed(2), tope: Number(order.max_price).toFixed(2), cantidad: order.max_quantity}, moneda: order.currency,
          rondas: order.round, rondas_max: STOCK_NEGOTIATION.maxMessages, precio_proveedor: await this.supplierPrice(db, order),
        };
      }
      await sleep(Math.min(STOCK_LIMITS.supplierWaitPollMs, Math.max(deadline - this.deps.now().getTime(), 0)));
    }
  }
}
