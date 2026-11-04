import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {GcpTokenSource} from '../compute/gcp-token';
import type {OutboundFetch} from '../outbound/http-client';

/**
 * Archivo de memorias al borrar (OCB-012, vm/README.md paso 5): el servicio
 * firma una URL V4 de subida (PUT, application/gzip) al bucket de memorias, la
 * entrega a la VM por `hermes-archive-url`, y comprueba que el objeto exista.
 * Al crear una VM nueva para el mismo usuario (D50), el provisioner entrega el
 * último archivo por `hermes-restore-url` (GET firmado) y el watcher lo
 * restaura una sola vez, antes de arrancar Hermes.
 *
 * La signed URL es una credencial: no se registra, no va a eventos ni a
 * errores, y solo vive en la metadata de la VM que se va a borrar.
 */

export class ArchiveError extends Error {
  constructor(readonly reason: string) {
    super(`ARCHIVE_FAILED reason=${reason}`);
    this.name = 'ArchiveError';
  }
}

/** Firma bytes con la llave de Google de una service account (sin key local). */
export interface BlobSigner {
  readonly email: string;
  sign(payload: Buffer): Promise<Buffer>;
}

/** Comprueba objetos del bucket de memorias. */
export interface ArchiveStore {
  objectExists(bucket: string, object: string): Promise<boolean>;
}

/** Puerto completo del archivo, para inyectar en el servicio y simular en pruebas. */
export interface MemoryArchiver extends ArchiveStore {
  signedUploadUrl(input: {bucket: string; object: string; now: Date; ttlSeconds: number}): Promise<string>;
}

/** Nombre del objeto: `<user_id>/<YYYYMMDDTHHMMSSZ>.tgz`. */
export function archiveObjectName(userId: string, now: Date): string {
  return `${userId}/${goog4DateTime(now)}.tgz`;
}

const goog4DateTime = (now: Date) => now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Codificación RFC 3986 (lo que exige el canonical request V4). */
const rfc3986 = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface SignedUrlParts { url: string; canonicalRequest: string; stringToSign: string }

export const ARCHIVE_CONTENT_TYPE = 'application/gzip';
const STORAGE_HOST = 'storage.googleapis.com';

/**
 * Construye la signed URL V4 (GOOG4-RSA-SHA256) path-style de un PUT con
 * `content-type: application/gzip` firmado, como lo envía el watcher:
 * https://cloud.google.com/storage/docs/access-control/signing-urls-manually
 */
export async function signedPutUrlV4(input: {
  bucket: string; object: string; now: Date; ttlSeconds: number; signer: BlobSigner; contentType?: string;
}): Promise<SignedUrlParts> {
  const datetime = goog4DateTime(input.now);
  const scope = `${datetime.slice(0, 8)}/auto/storage/goog4_request`;
  const path = `/${input.bucket}/${input.object.split('/').map(rfc3986).join('/')}`;
  const params: Array<[string, string]> = [
    ['X-Goog-Algorithm', 'GOOG4-RSA-SHA256'],
    ['X-Goog-Credential', `${input.signer.email}/${scope}`],
    ['X-Goog-Date', datetime],
    ['X-Goog-Expires', String(input.ttlSeconds)],
    ['X-Goog-SignedHeaders', 'content-type;host'],
  ];
  const query = params.map(([key, value]) => `${rfc3986(key)}=${rfc3986(value)}`).sort().join('&');
  const canonicalRequest = [
    'PUT', path, query,
    `content-type:${input.contentType ?? ARCHIVE_CONTENT_TYPE}`, `host:${STORAGE_HOST}`, '',
    'content-type;host', 'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = [
    'GOOG4-RSA-SHA256', datetime, scope,
    createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
  ].join('\n');
  const signature = (await input.signer.sign(Buffer.from(stringToSign, 'utf8'))).toString('hex');
  return {url: `https://${STORAGE_HOST}${path}?${query}&X-Goog-Signature=${signature}`, canonicalRequest, stringToSign};
}

/**
 * Signed URL V4 de un GET (ORQA OSB-007, semilla del cerebro): solo `host`
 * firmado, para que `curl` del watcher la use tal cual. Es una credencial de
 * lectura: nunca va a logs ni a eventos.
 */
export async function signedGetUrlV4(input: {
  bucket: string; object: string; now: Date; ttlSeconds: number; signer: BlobSigner;
}): Promise<SignedUrlParts> {
  const datetime = goog4DateTime(input.now);
  const scope = `${datetime.slice(0, 8)}/auto/storage/goog4_request`;
  const path = `/${input.bucket}/${input.object.split('/').map(rfc3986).join('/')}`;
  const params: Array<[string, string]> = [
    ['X-Goog-Algorithm', 'GOOG4-RSA-SHA256'],
    ['X-Goog-Credential', `${input.signer.email}/${scope}`],
    ['X-Goog-Date', datetime],
    ['X-Goog-Expires', String(input.ttlSeconds)],
    ['X-Goog-SignedHeaders', 'host'],
  ];
  const query = params.map(([key, value]) => `${rfc3986(key)}=${rfc3986(value)}`).sort().join('&');
  const canonicalRequest = ['GET', path, query, `host:${STORAGE_HOST}`, '', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = [
    'GOOG4-RSA-SHA256', datetime, scope,
    createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
  ].join('\n');
  const signature = (await input.signer.sign(Buffer.from(stringToSign, 'utf8'))).toString('hex');
  return {url: `https://${STORAGE_HOST}${path}?${query}&X-Goog-Signature=${signature}`, canonicalRequest, stringToSign};
}

const SignBlobResponse = z.object({signedBlob: z.string().min(1)});

/**
 * signBlob de IAM Credentials con el token de Workload Identity. La GSA tiene
 * `iam.serviceAccountTokenCreator` sobre sí misma (validado en dev).
 */
export class IamCredentialsSigner implements BlobSigner {
  constructor(
    readonly email: string,
    private readonly apiBase: string,
    private readonly tokens: GcpTokenSource,
    private readonly fetcher: OutboundFetch,
  ) {}

  async sign(payload: Buffer): Promise<Buffer> {
    let response: Response;
    try {
      const token = await this.tokens.token();
      response = await this.fetcher(
        `${this.apiBase.replace(/\/$/, '')}/projects/-/serviceAccounts/${encodeURIComponent(this.email)}:signBlob`, {
          method: 'POST',
          headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json'},
          body: JSON.stringify({payload: payload.toString('base64')}),
        });
    } catch {
      throw new ArchiveError('sign_unavailable');
    }
    if (!response.ok) throw new ArchiveError(`sign_http_${response.status}`);
    let body: unknown = null;
    try {body = await response.json();} catch {body = null;}
    const parsed = SignBlobResponse.safeParse(body);
    if (!parsed.success) throw new ArchiveError('sign_invalid_response');
    return Buffer.from(parsed.data.signedBlob, 'base64');
  }
}

/** objects.get (solo metadata) de la JSON API de Cloud Storage. */
export class GcsArchiveStore implements ArchiveStore {
  constructor(private readonly apiBase: string, private readonly tokens: GcpTokenSource, private readonly fetcher: OutboundFetch) {}

  async objectExists(bucket: string, object: string): Promise<boolean> {
    let response: Response;
    try {
      const token = await this.tokens.token();
      response = await this.fetcher(
        `${this.apiBase.replace(/\/$/, '')}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}?fields=name,size`, {
          headers: {authorization: `Bearer ${token}`, accept: 'application/json'},
        });
    } catch {
      throw new ArchiveError('storage_unavailable');
    }
    if (response.status === 404) return false;
    if (!response.ok) throw new ArchiveError(`storage_http_${response.status}`);
    let body: {size?: unknown} | null = null;
    try {body = await response.json() as {size?: unknown};} catch {body = null;}
    return Number(body?.size ?? 0) > 0;
  }
}

/** Subida simple (uploadType=media) de la JSON API de Cloud Storage con el token de Workload Identity. */
export class GcsObjectWriter {
  constructor(private readonly apiBase: string, private readonly tokens: GcpTokenSource, private readonly fetcher: OutboundFetch) {}

  async upload(bucket: string, object: string, body: Buffer, contentType: string): Promise<void> {
    let response: Response;
    try {
      const token = await this.tokens.token();
      response = await this.fetcher(
        `${this.apiBase.replace(/\/$/, '')}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(object)}`, {
          method: 'POST',
          headers: {authorization: `Bearer ${token}`, 'content-type': contentType, accept: 'application/json'},
          body: new Uint8Array(body),
        });
    } catch {
      throw new ArchiveError('storage_unavailable');
    }
    try {await response.body?.cancel();} catch {/* sin cuerpo */}
    if (!response.ok) throw new ArchiveError(`storage_http_${response.status}`);
  }
}

/** Descarga (alt=media) de la JSON API de Cloud Storage; null = el objeto no existe. Tope de bytes: nunca carga más. */
export class GcsObjectReader {
  constructor(private readonly apiBase: string, private readonly tokens: GcpTokenSource, private readonly fetcher: OutboundFetch) {}

  async download(bucket: string, object: string, maxBytes: number): Promise<Buffer | null> {
    let response: Response;
    try {
      const token = await this.tokens.token();
      response = await this.fetcher(
        `${this.apiBase.replace(/\/$/, '')}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}?alt=media`, {
          headers: {authorization: `Bearer ${token}`},
        });
    } catch {
      throw new ArchiveError('storage_unavailable');
    }
    if (response.status === 404) {try {await response.body?.cancel();} catch {/* */} return null;}
    if (!response.ok) {try {await response.body?.cancel();} catch {/* */} throw new ArchiveError(`storage_http_${response.status}`);}
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > maxBytes) {try {await response.body?.cancel();} catch {/* */} throw new ArchiveError('object_too_large');}
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new ArchiveError('object_too_large');
    return bytes;
  }
}

const ListObjectsResponse = z.object({
  items: z.array(z.object({name: z.string(), size: z.string().optional()})).optional(),
  nextPageToken: z.string().optional(),
});

/** objects.list (solo nombre y tamaño) de la JSON API de Cloud Storage, acotado a `maxPages`. */
export class GcsObjectLister {
  constructor(private readonly apiBase: string, private readonly tokens: GcpTokenSource, private readonly fetcher: OutboundFetch) {}

  async list(bucket: string, prefix: string, maxPages = 10): Promise<Array<{name: string; size: number}>> {
    const found: Array<{name: string; size: number}> = [];
    let pageToken: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const query = new URLSearchParams({prefix, fields: 'items(name,size),nextPageToken'});
      if (pageToken) query.set('pageToken', pageToken);
      let response: Response;
      try {
        const token = await this.tokens.token();
        response = await this.fetcher(
          `${this.apiBase.replace(/\/$/, '')}/storage/v1/b/${encodeURIComponent(bucket)}/o?${query}`, {
            headers: {authorization: `Bearer ${token}`, accept: 'application/json'},
          });
      } catch {
        throw new ArchiveError('storage_unavailable');
      }
      if (!response.ok) {try {await response.body?.cancel();} catch {/* */} throw new ArchiveError(`storage_http_${response.status}`);}
      let body: unknown = null;
      try {body = await response.json();} catch {body = null;}
      const parsed = ListObjectsResponse.safeParse(body);
      if (!parsed.success) throw new ArchiveError('storage_invalid_response');
      for (const item of parsed.data.items ?? []) found.push({name: item.name, size: Number(item.size ?? 0)});
      pageToken = parsed.data.nextPageToken;
      if (!pageToken) break;
    }
    return found;
  }
}

/**
 * Último archivo de memorias del usuario entre los objetos de su prefijo
 * (D50): solo nombres `<user_id>/<YYYYMMDDTHHMMSSZ>.tgz` (los de
 * `archiveObjectName`) con bytes; el nombre ordena por fecha.
 */
export function latestArchiveObject(userId: string, objects: ReadonlyArray<{name: string; size: number}>): string | null {
  const prefix = `${userId}/`;
  const names = objects
    .filter(item => item.size > 0 && item.name.startsWith(prefix) && /^\d{8}T\d{6}Z\.tgz$/.test(item.name.slice(prefix.length)))
    .map(item => item.name)
    .sort();
  return names.at(-1) ?? null;
}

/** Archivador real: firma con IAM y comprueba en GCS. */
export class GcsMemoryArchiver implements MemoryArchiver {
  constructor(private readonly signer: BlobSigner, private readonly store: ArchiveStore) {}

  async signedUploadUrl(input: {bucket: string; object: string; now: Date; ttlSeconds: number}): Promise<string> {
    return (await signedPutUrlV4({...input, signer: this.signer})).url;
  }

  objectExists(bucket: string, object: string): Promise<boolean> {
    return this.store.objectExists(bucket, object);
  }
}
