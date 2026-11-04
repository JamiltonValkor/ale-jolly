import type {MessagesResponseV1} from '../contracts/v1';
import type {HermesMessage} from '../hermes/hermes-client';

type Message = MessagesResponseV1['messages'][number];

const MAX_ID = 200;

/** `content` de Hermes: texto, o partes multimodales (`{type:'text', text}`). */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(part => {
      const item = part as {type?: unknown; text?: unknown} | null;
      return item && typeof item.text === 'string' && (item.type === undefined || item.type === 'text' || item.type === 'input_text' || item.type === 'output_text') ? item.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** `timestamp` de Hermes: epoch en segundos (SQLite REAL) o una fecha ISO. */
function createdAt(timestamp: unknown): string | null {
  let ms: number | null = null;
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) ms = timestamp < 1e11 ? timestamp * 1000 : timestamp;
  else if (typeof timestamp === 'string' && timestamp.trim()) ms = Date.parse(timestamp);
  if (ms === null || !Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Historial de Hermes → v1: solo `user`/`assistant` con texto visible. Se
 * descartan las tools (rol `tool` y los assistant que solo llaman tools), los
 * mensajes de sistema y las filas ocultas por la compactación.
 */
export function toHistory(messages: HermesMessage[]): MessagesResponseV1 {
  const out: Message[] = [];
  messages.forEach((message, index) => {
    if (message.role !== 'user' && message.role !== 'assistant') return;
    if (message.display_kind === 'hidden') return;
    const text = contentText(message.content);
    if (!text.trim()) return;
    const rawId = typeof message.id === 'number' || typeof message.id === 'string' ? String(message.id).slice(0, MAX_ID) : '';
    out.push({id: rawId || `m${index}`, role: message.role, text, created_at: createdAt(message.timestamp)});
  });
  return {messages: out};
}
