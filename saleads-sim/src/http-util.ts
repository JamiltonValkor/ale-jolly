import type {IncomingMessage, ServerResponse} from 'node:http';

/** Utilidades HTTP mínimas sobre node:http (sin framework). */

export class BodyTooLarge extends Error {}

export async function readBody(req: IncomingMessage, limit = 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new BodyTooLarge();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams((await readBody(req, 64 * 1024)).toString('utf8'));
}

/** JSON del cuerpo; `undefined` si está vacío, `Error` si no es JSON. */
export async function readJson(req: IncomingMessage, limit?: number): Promise<unknown> {
  const raw = (await readBody(req, limit)).toString('utf8');
  if (!raw.trim()) return undefined;
  return JSON.parse(raw);
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers});
  res.end(payload);
}

export function sendText(res: ServerResponse, status: number, body: string | Buffer, contentType: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {'content-type': contentType, ...headers});
  res.end(body);
}

export function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, {location, 'cache-control': 'no-store'});
  res.end();
}

export function bearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  const match = typeof header === 'string' ? /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i.exec(header.trim()) : null;
  return match?.[1] ?? null;
}

export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) =>
  ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]!);
