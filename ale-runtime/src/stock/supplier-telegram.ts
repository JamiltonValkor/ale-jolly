import {Logger} from '@nestjs/common';
import {createHash} from 'node:crypto';
import type {OutboundFetch} from '../outbound/http-client';
import {TELEGRAM_CURSOR_BASE, type SupplierChannel, type SupplierInbound, type SupplierSendResult} from './supplier-channel';

const API = 'https://api.telegram.org';
/** Id numérico de una persona en Telegram. Un grupo o canal es negativo, y un `@usuario` se puede reasignar: ninguno vale (R30). */
export const TELEGRAM_USER_ID = /^[1-9]\d{4,15}$/;
/** Forma del token de @BotFather: id del bot, dos puntos y secreto. Solo se valida la forma; nunca se registra. */
export const TELEGRAM_BOT_TOKEN = /^\d{5,16}:[A-Za-z0-9_-]{30,64}$/;
const NO_TEXT = '[mensaje sin texto: no se lee]';

interface TelegramChat {id: number; type: string}
interface TelegramMessage {message_id: number; chat: TelegramChat; from?: {id: number; is_bot: boolean}; text?: string; caption?: string}
interface TelegramUpdate {update_id: number; message?: TelegramMessage}
interface TelegramReply<T> {ok: boolean; result?: T; error_code?: number; description?: string}

/** Error sin la URL ni el cuerpo: la URL de la Bot API lleva el token. */
export class TelegramChannelError extends Error {
  constructor(readonly code: string) {
    super(`telegram: ${code}`);
    this.name = 'TelegramChannelError';
  }
}

/**
 * Proveedor por Telegram, con un bot propio de ale-runtime (no el del asistente de la VM). R30 en servidor:
 * - el destino es un id numérico de persona fijado por configuración; `send` no recibe destinatario;
 * - Telegram confirma a qué chat entregó, y si no es el destino fijo se corta;
 * - solo entra lo escrito en el chat privado por esa misma persona; lo demás se descarta y se cuenta.
 * El texto entrante es dato no confiable: `Negotiation` lo limpia y lo entrega marcado `no_confiable`.
 *
 * Idempotencia en memoria, como el banco: un reinicio entre enviar y guardar puede repetir un mensaje.
 */
export class TelegramSupplierChannel implements SupplierChannel {
  private readonly logger = new Logger('StockSupplierTelegram');
  private readonly sentByKey = new Map<string, Promise<SupplierSendResult>>();
  /** Último `update_id` ajeno ya descartado: sin esto un mensaje ajeno volvería en cada pasada durante 24 h. */
  private ignoredUpTo: number | undefined;
  /** Mensajes ignorados desde el arranque (ajenos al destino fijo, o comandos). Solo el conteo: nunca quién ni qué. */
  discarded = 0;

  constructor(private readonly destination: string, private readonly token: string, private readonly fetcher: OutboundFetch) {
    if (!TELEGRAM_USER_ID.test(destination)) throw new Error('CONFIGURATION_INVALID: STOCK_SUPPLIER_DESTINATION');
    if (!TELEGRAM_BOT_TOKEN.test(token)) throw new Error('CONFIGURATION_INVALID: STOCK_SUPPLIER_TELEGRAM_TOKEN');
  }

  send({idempotencyKey, body}: {idempotencyKey: string; body: string}): Promise<SupplierSendResult> {
    const repeated = this.sentByKey.get(idempotencyKey);
    if (repeated) return repeated;
    const sending = this.deliver(body);
    this.sentByKey.set(idempotencyKey, sending);
    // Solo lo entregado queda: un fallo o una ventana cerrada se pueden reintentar.
    sending.then(result => {if (result.status !== 'enviado') this.sentByKey.delete(idempotencyKey);}, () => this.sentByKey.delete(idempotencyKey));
    return sending;
  }

  private async deliver(body: string): Promise<SupplierSendResult> {
    const reply = await this.call<TelegramMessage>('sendMessage', {chat_id: this.destination, text: body, link_preview_options: {is_disabled: true}});
    if (!reply.ok) {
      // 403: el proveedor bloqueó el bot o nunca le escribió. 400 «chat not found»: nunca le escribió.
      if (reply.error_code === 403 || (reply.error_code === 400 && /chat not found/i.test(reply.description ?? ''))) return {status: 'ventana_cerrada'};
      throw new TelegramChannelError(`envio_${reply.error_code ?? 'sin_codigo'}`);
    }
    const message = reply.result;
    if (!message || String(message.chat?.id) !== this.destination) throw new TelegramChannelError('destino_distinto');
    return {status: 'enviado', externalId: `tg-${message.message_id}`, destinationHash: createHash('sha256').update(this.destination).digest('hex')};
  }

  /**
   * `after` es el cursor guardado. Del rango de Telegram, `offset = update_id + 1` le confirma a Telegram lo ya guardado,
   * y un reinicio retoma ahí. Fuera de ese rango (cursor del banco o 0) se piden todos los pendientes: repetidos no
   * entran dos veces porque `relay_id` es único.
   */
  async poll(after: number): Promise<SupplierInbound[]> {
    const saved = after >= TELEGRAM_CURSOR_BASE ? after - TELEGRAM_CURSOR_BASE : undefined;
    const last = Math.max(saved ?? -1, this.ignoredUpTo ?? -1);
    const reply = await this.call<TelegramUpdate[]>('getUpdates', {...(last >= 0 ? {offset: last + 1} : {}), timeout: 0, limit: 100, allowed_updates: ['message']});
    if (!reply.ok || !Array.isArray(reply.result)) throw new TelegramChannelError(`lectura_${reply.error_code ?? 'sin_codigo'}`);
    const inbound: SupplierInbound[] = [];
    let ignored = 0;
    for (const update of reply.result) {
      const body = this.fromDestination(update.message);
      if (body === null) {
        ignored += 1;
        continue;
      }
      inbound.push({relayId: `tg-${update.update_id}`, cursor: TELEGRAM_CURSOR_BASE + update.update_id, body});
    }
    if (ignored) {
      this.discarded += ignored;
      this.logger.warn(`ignorados ${ignored} mensajes ajenos al proveedor fijo o comandos (total ${this.discarded})`);
    }
    // Sin nada propio en la tanda, todo lo leído es ajeno: se confirma sin guardar. Con algo propio, lo confirma el cursor.
    if (!inbound.length && reply.result.length) this.ignoredUpTo = Math.max(...reply.result.map(update => update.update_id));
    return inbound;
  }

  /** El texto, si viene del destino fijo en su chat privado; `null` si no. Un comando (`/start`) no es respuesta. */
  private fromDestination(message: TelegramMessage | undefined): string | null {
    if (!message || message.chat?.type !== 'private') return null;
    if (String(message.chat.id) !== this.destination || String(message.from?.id) !== this.destination || message.from?.is_bot) return null;
    const text = message.text ?? message.caption;
    if (text === undefined) return NO_TEXT;
    return text.trimStart().startsWith('/') ? null : text;
  }

  private async call<T>(method: string, payload: unknown): Promise<TelegramReply<T>> {
    let response: Response;
    try {
      response = await this.fetcher(`${API}/bot${this.token}/${method}`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(payload)});
    } catch {
      throw new TelegramChannelError('red');
    }
    try {
      return await response.json() as TelegramReply<T>;
    } catch {
      throw new TelegramChannelError(`respuesta_${response.status}`);
    }
  }
}
