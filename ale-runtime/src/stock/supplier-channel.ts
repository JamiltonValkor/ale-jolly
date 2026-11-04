import {createHash} from 'node:crypto';

/**
 * Inicio del rango de cursores de Telegram (`TELEGRAM_CURSOR_BASE + update_id`). El banco usa milisegundos del reloj,
 * muy por debajo (1e14 ms es el año 5138), así que un cursor guardado por el banco nunca confirma un mensaje de Telegram.
 */
export const TELEGRAM_CURSOR_BASE = 100_000_000_000_000;

/** Mensaje de un proveedor. `cursor` crece siempre: un reinicio retoma desde el último guardado. */
export interface SupplierInbound {relayId: string; cursor: number; body: string}
export type SupplierSendResult =
  | {status: 'enviado'; externalId: string; destinationHash: string}
  /** El canal no deja escribir primero. No se reintenta: el proveedor debe abrir la conversación. */
  | {status: 'ventana_cerrada'};

/**
 * Canal con el proveedor (R30). `send` no recibe destinatario, a propósito: el destino sale de la configuración del
 * adaptador y nada que venga del modelo llega hasta aquí. `send` debe ser idempotente por `idempotencyKey`, y `poll` solo
 * devuelve mensajes del destino fijo.
 *
 * Adaptadores: `banco` (simulado, sin red) y `telegram` (`supplier-telegram.ts`, bot propio del servidor). El cursor es
 * global (`stock_relay_state`), así que cada adaptador usa su propio rango: el del banco va bajo `TELEGRAM_CURSOR_BASE`.
 */
export interface SupplierChannel {
  send(input: {idempotencyKey: string; body: string}): Promise<SupplierSendResult>;
  poll(after: number): Promise<SupplierInbound[]>;
}

/**
 * Proveedor simulado: no toca ninguna red. Vive en memoria; el cursor parte del reloj para que tras un reinicio
 * un mensaje nuevo no quede detrás del cursor guardado.
 */
export class BenchSupplierChannel implements SupplierChannel {
  private readonly sentByKey = new Map<string, SupplierSendResult>();
  private inbox: SupplierInbound[] = [];
  private last = 0;
  readonly sent: Array<{destination: string; body: string}> = [];

  constructor(private readonly destination: string, private readonly now: () => number = Date.now) {}

  async send({idempotencyKey, body}: {idempotencyKey: string; body: string}): Promise<SupplierSendResult> {
    const repeated = this.sentByKey.get(idempotencyKey);
    if (repeated) return repeated;
    this.sent.push({destination: this.destination, body});
    const result: SupplierSendResult = {status: 'enviado', externalId: `banco-${this.sent.length}-${this.now()}`, destinationHash: createHash('sha256').update(this.destination).digest('hex')};
    this.sentByKey.set(idempotencyKey, result);
    return result;
  }

  async poll(after: number): Promise<SupplierInbound[]> {
    // Un cursor del rango de Telegram no es del banco: volver a `banco` tras Telegram no debe esconder lo nuevo.
    const from = after < TELEGRAM_CURSOR_BASE ? after : 0;
    return this.inbox.filter(message => message.cursor > from);
  }

  /** La respuesta del proveedor en el banco: `bench_supplier_reply`, o el guion de una prueba. */
  reply(body: string): SupplierInbound {
    this.last = Math.max(this.last + 1, this.now());
    const message = {relayId: `banco-${this.last}`, cursor: this.last, body};
    this.inbox.push(message);
    return message;
  }
}
