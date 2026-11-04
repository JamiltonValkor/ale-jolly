import {randomUUID} from 'node:crypto';
import type {z} from 'zod';
import type {SamResultV1, StockPhotoResultV1, StockTakePhotoInputV1} from '../contracts/stock-v1';
import {conflict, notFound, serviceUnavailable} from '../domain/errors';
import {signedGetUrlV4, signedPutUrlV4, type BlobSigner} from '../lifecycle/memory-archive';
import {writeAudit} from './audit';
import {STOCK_LIMITS} from './config';
import type {StockClock} from './clock';
import {activeRun, type StockDb, type StockQuery} from './store';
import type {StockUsage} from './usage';

type PhotoResult = z.infer<typeof StockPhotoResultV1>;
type PhotoRow = {
  id: string; business_id: string; user_id: string; request_id: string; status: string; concept: string; label: string; parent_photo_id: string | null;
  object_original: string | null; object_numerada: string | null; sam: SamResultV1 | null; total: number | null; fuente: string | null; imagen_sha256: string | null; occurred_at: Date;
  error: string | null; simulated: boolean;
};

/** Bucket de fotos. Las URLs firmadas son credenciales: nunca van a logs, auditoría ni Postgres. */
export interface PhotoStore {
  signPut(object: string, contentType: string, ttlSeconds: number, now: Date): Promise<string>;
  signGet(object: string, ttlSeconds: number, now: Date): Promise<string>;
}

export function gcsPhotoStore(bucket: string, signer: BlobSigner): PhotoStore {
  return {
    signPut: async (object, contentType, ttlSeconds, now) => (await signedPutUrlV4({bucket, object, now, ttlSeconds, signer, contentType})).url,
    signGet: async (object, ttlSeconds, now) => (await signedGetUrlV4({bucket, object, now, ttlSeconds, signer})).url,
  };
}

/** Estado de la foto de un conteo. `vencida`: pasó el ciclo de vida del bucket. `perdida`: nunca quedó lista, o no se puede firmar. */
export type ProposalPhotoState = 'vigente' | 'vencida' | 'perdida' | 'sin_foto';
export interface ProposalPhoto {estado: ProposalPhotoState; url: string | null; expira_en: string | null; tomada_en: string | null; total: number | null}

/**
 * Foto de una propuesta de conteo. Con `sign` devuelve una URL GET firmada de corta vida, y solo para la web: la ruta
 * del objeto nunca sale como dato, y el modelo sigue viendo la imagen solo por `get_photo` (`image_url`).
 */
export async function proposalPhoto(
  deps: {db: StockQuery; store?: PhotoStore; now: () => Date; onSignError?: (error: unknown) => void},
  businessId: string, photoId: string | null | undefined, sign: boolean,
): Promise<ProposalPhoto> {
  const none = {url: null, expira_en: null};
  if (!photoId) return {estado: 'sin_foto', ...none, tomada_en: null, total: null};
  const {rows} = await deps.db.query<{status: string; object_numerada: string | null; total: number | null; occurred_at: Date; recorded_at: Date}>(
    'SELECT status, object_numerada, total, occurred_at, recorded_at FROM assistant.stock_photos WHERE id = $1 AND business_id = $2', [photoId, businessId]);
  const row = rows[0];
  if (!row) return {estado: 'perdida', ...none, tomada_en: null, total: null};
  const facts = {tomada_en: new Date(row.occurred_at).toISOString(), total: row.total};
  if (row.status !== 'lista' || !row.object_numerada) return {estado: 'perdida', ...none, ...facts};
  const now = deps.now();
  if (now.getTime() - new Date(row.recorded_at).getTime() >= STOCK_LIMITS.photoRetentionDays * 86_400_000) return {estado: 'vencida', ...none, ...facts};
  if (!sign) return {estado: 'vigente', ...none, ...facts};
  if (!deps.store) return {estado: 'perdida', ...none, ...facts};
  const ttl = STOCK_LIMITS.photoGetTtlSeconds;
  try {
    const url = await deps.store.signGet(row.object_numerada, ttl, now);
    return {estado: 'vigente', url, expira_en: new Date(now.getTime() + ttl * 1000).toISOString(), ...facts};
  } catch (error) {
    deps.onSignError?.(error);
    return {estado: 'perdida', ...none, ...facts};
  }
}

export interface PhotosDeps {db: StockDb; clock: StockClock; store?: PhotoStore; waitMs: number; now: () => Date; usage: Pick<StockUsage, 'spend'>}

/** Deshace la foto y su evento: agotado el tope no queda una orden al robot que nadie pagó. */
class PhotoBudgetSpent extends Error {}

const COLUMNS = 'id,business_id,user_id,request_id,status,concept,label,parent_photo_id,object_original,object_numerada,sam,total,fuente,imagen_sha256,error,simulated,occurred_at';
const EXTENSION = {'image/jpeg': 'jpg', 'image/png': 'png'} as const;

/** R11 y R14: la foto siempre la pide Stock. La espera vive en memoria; tras reiniciar queda la lectura por base. */
export class StockPhotos {
  private readonly waiters = new Map<string, Set<() => void>>();
  /** Lo pone `DeviceOps`: despierta la conexión de eventos del usuario. */
  onEvent: (userId: string) => void = () => undefined;

  constructor(private readonly deps: PhotosDeps) {}

  private async byId(id: string): Promise<PhotoRow | null> {
    const {rows} = await this.deps.db.query<PhotoRow>(`SELECT ${COLUMNS} FROM assistant.stock_photos WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  private async byRequest(userId: string, requestId: string): Promise<PhotoRow> {
    const {rows} = await this.deps.db.query<PhotoRow>(`SELECT ${COLUMNS} FROM assistant.stock_photos WHERE request_id = $1 AND user_id = $2`, [requestId, userId]);
    if (!rows[0]) throw notFound();
    return rows[0];
  }

  /** El hilo de eventos vivo, no los turnos de voz: `robot_devices.last_seen_at` lo toca cualquier petición. */
  private async online(userId: string): Promise<boolean> {
    const {rows} = await this.deps.db.query<{events_seen_at: Date}>(
      'SELECT events_seen_at FROM assistant.stock_device_presence WHERE user_id = $1 ORDER BY events_seen_at DESC LIMIT 1', [userId]);
    return !!rows[0] && this.deps.now().getTime() - new Date(rows[0].events_seen_at).getTime() <= STOCK_LIMITS.presenceTimeoutSeconds * 1000;
  }

  async take(userId: string, businessId: string, input: StockTakePhotoInputV1): Promise<PhotoResult> {
    const {db, clock, store} = this.deps;
    if (!store) throw serviceUnavailable();
    const runId = await activeRun(db, businessId);
    const found = async () => (await db.query<PhotoRow>(
      `SELECT ${COLUMNS} FROM assistant.stock_photos WHERE business_id = $1 AND idempotency_key = $2 AND run_id IS NOT DISTINCT FROM $3`,
      [businessId, input.idempotency_key, runId])).rows[0];
    const same = (row: PhotoRow) => {
      if (row.concept !== input.concepto || row.label !== input.etiqueta) throw conflict();
      return this.settle(row.id);
    };
    const existing = await found();
    if (existing) return same(existing);

    const retry = input.photo_id ? await this.retryParent(businessId, runId, input.photo_id) : null;
    if (retry && 'refused' in retry) return retry.refused;
    const origin = retry?.root ?? null;
    if (!origin && await this.countFull(businessId, runId, input.etiqueta)) return {status: 'fallida', motivo: 'tope_fotos_conteo'};
    if (!await this.online(userId)) return {status: 'robot_offline'};

    // Mismo valor: el robot guarda la foto por `solicitud_id`, y el reintento se la pide por `foto_id` (R14).
    const id = randomUUID();
    const requestId = id;
    const expires = new Date(this.deps.now().getTime() + STOCK_LIMITS.eventTtlMinutes * 60_000);
    const occurred = origin?.occurred_at ?? await clock.at(businessId); // R14: la foto es la misma, y su fecha también.
    const inserted = await db.tx(async tx => {
      // Cada foto, y cada reintento, es una corrida de SAM en el robot. Se cobra al crearla y nunca por una repetida.
      const {rows} = await tx.query<{id: string}>(
        `INSERT INTO assistant.stock_photos(id,business_id,user_id,request_id,status,concept,label,parent_photo_id,object_original,imagen_sha256,idempotency_key,occurred_at,simulated,run_id)
         VALUES ($1,$2,$3,$4,'solicitada',$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (business_id, idempotency_key, (COALESCE(run_id, '00000000-0000-0000-0000-000000000000'::uuid))) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id`,
        [id, businessId, userId, requestId, input.concepto, input.etiqueta, origin?.id ?? null, origin?.object_original ?? null, origin?.imagen_sha256 ?? null,
          input.idempotency_key, occurred, runId !== null, runId]);
      if (!rows[0]) return false;
      if (!await this.deps.usage.spend(tx, businessId, 'sam_llamadas')) throw new PhotoBudgetSpent();
      await tx.query(
        `INSERT INTO assistant.stock_robot_events(business_id,user_id,kind,payload,expires_at) VALUES ($1,$2,'foto',$3,$4)`,
        [businessId, userId, JSON.stringify({solicitud_id: requestId, concepto: input.concepto, etiqueta: input.etiqueta, foto_id: origin?.id ?? null}), expires]);
      await writeAudit(tx, {businessId, traceId: id, actor: userId, action: 'take_photo', entity: 'stock_photos', entityId: id, args: {concepto: input.concepto, reintento: !!origin}});
      return true;
    }).catch((error: unknown) => {
      if (error instanceof PhotoBudgetSpent) return 'tope' as const;
      throw error;
    });
    if (inserted === 'tope') return {status: 'tope_diario'};
    if (!inserted) return same((await found())!);
    this.onEvent(userId);
    return this.settle(id, expires);
  }

  /** `fotos_por_conteo`: sin esto, Stock esquivaría el tope de reintentos con una foto nueva de lo mismo. */
  private async countFull(businessId: string, runId: string | null, label: string): Promise<boolean> {
    const {rows} = await this.deps.db.query<{n: number}>(
      `SELECT count(*)::int AS n FROM assistant.stock_photos WHERE business_id = $1 AND label = $2 AND run_id IS NOT DISTINCT FROM $3 AND recorded_at > now() - make_interval(mins => $4)`,
      [businessId, label, runId, STOCK_LIMITS.photoCountWindowMinutes]);
    return (rows[0]?.n ?? 0) >= STOCK_LIMITS.photoRetries + 1;
  }

  /** R14: reusa el original. El reintento se cuenta sobre la foto raíz, y un original que no llegó no se reemplaza. */
  private async retryParent(businessId: string, runId: string | null, photoId: string): Promise<{root: PhotoRow} | {refused: PhotoResult}> {
    const {db} = this.deps;
    const {rows} = await db.query<PhotoRow>(
      `SELECT ${COLUMNS} FROM assistant.stock_photos WHERE id = $1 AND business_id = $2 AND run_id IS NOT DISTINCT FROM $3`, [photoId, businessId, runId]);
    const asked = rows[0];
    // Con modelo real (IVB-027), Stock inventa `photo_id` en fotos nuevas. Un 404 llegaba como «negocio no encontrado»
    // y Stock bloqueaba la tarjeta. Respuesta propia, igual para ajena o inexistente: no revela si la foto existe.
    if (!asked) return {refused: {status: 'fallida', motivo: 'foto_desconocida'}};
    const root = asked.parent_photo_id ? await this.byId(asked.parent_photo_id) : asked;
    if (!root?.object_original || root.status !== 'lista') return {refused: {status: 'fallida', motivo: 'sin_original'}};
    const {rows: retries} = await db.query<{n: number}>('SELECT count(*)::int AS n FROM assistant.stock_photos WHERE parent_photo_id = $1', [root.id]);
    if ((retries[0]?.n ?? 0) >= STOCK_LIMITS.photoRetries) return {refused: {status: 'fallida', motivo: 'tope_reintentos'}};
    return {root};
  }

  /** Espera hasta `waitMs` o hasta que venza el evento. Nunca bloquea más allá: al vencer queda `pending`. */
  private settle(id: string, expires?: Date): Promise<PhotoResult> {
    return new Promise((resolve, reject) => {
      const answer = async () => {
        const row = await this.byId(id);
        return row ? this.result(row) : {status: 'pending', photo_id: id} as PhotoResult;
      };
      answer().then(first => {
        if (first.status !== 'pending') return resolve(first);
        const left = expires ? Math.max(0, expires.getTime() - this.deps.now().getTime()) : Infinity;
        const set = this.waiters.get(id) ?? new Set();
        this.waiters.set(id, set);
        const finish = () => {
          clearTimeout(timer);
          set.delete(finish);
          if (!set.size) this.waiters.delete(id);
          this.sweep().then(answer).then(resolve, reject);
        };
        const timer = setTimeout(finish, Math.min(this.deps.waitMs, left));
        timer.unref();
        set.add(finish);
      }, reject);
    });
  }

  private notify(id: string): void {
    for (const finish of [...this.waiters.get(id) ?? []]) finish();
  }

  async get(businessId: string, id: string): Promise<PhotoResult> {
    await this.sweep();
    const row = await this.byId(id);
    if (!row || row.business_id !== businessId) throw notFound();
    return this.result(row);
  }

  private async result(row: PhotoRow): Promise<PhotoResult> {
    if (row.status === 'fallida' || row.status === 'vencida') return {status: 'fallida', motivo: row.error ?? 'desconocido'};
    if (row.status !== 'lista') return {status: 'pending', photo_id: row.id};
    if (!this.deps.store || !row.object_numerada || !row.sam) throw serviceUnavailable();
    return {
      status: 'ok', photo_id: row.id, total: row.total ?? 0, objetos: row.sam.objetos, fuente: row.fuente ?? 'camara', simulado: row.simulated || row.fuente === 'simulada',
      image_url: await this.deps.store.signGet(row.object_numerada, STOCK_LIMITS.photoGetTtlSeconds, this.deps.now()), image_expires_in: STOCK_LIMITS.photoGetTtlSeconds,
    };
  }

  // ---- Lado del robot ---------------------------------------------------------------------------------------------

  async photoUrl(userId: string, input: {request_id: string; role: 'original' | 'numerada'; content_type: 'image/jpeg' | 'image/png'}) {
    if (!this.deps.store) throw serviceUnavailable();
    const row = await this.byRequest(userId, input.request_id);
    if (row.status !== 'solicitada' && row.status !== 'entregada') throw conflict();
    if (input.role === 'original' && row.parent_photo_id) throw conflict(); // R14: el reintento no sube otra imagen.
    const object = `${row.business_id}/${row.id}/${input.role}.${EXTENSION[input.content_type]}`;
    const column = input.role === 'original' ? 'object_original' : 'object_numerada';
    await this.deps.db.query(`UPDATE assistant.stock_photos SET ${column} = $2 WHERE id = $1`, [row.id, object]);
    const ttl = STOCK_LIMITS.photoPutTtlSeconds;
    return {url: await this.deps.store.signPut(object, input.content_type, ttl, this.deps.now()), object, expires_in: ttl, content_type: input.content_type};
  }

  /** No abre turno: solo guarda y despierta la espera. Un turno de voz en curso sigue intacto. */
  async done(userId: string, input: {request_id: string; sam: SamResultV1; fuente: 'camara' | 'simulada'; imagen_sha256: string}): Promise<void> {
    const row = await this.byRequest(userId, input.request_id);
    if (row.status === 'lista' || row.status === 'fallida' || row.status === 'vencida') return;
    if (!row.object_numerada || !row.object_original) throw conflict();
    if (row.parent_photo_id && row.imagen_sha256 !== input.imagen_sha256) throw conflict(); // R14: misma foto.
    await this.deps.db.tx(async tx => {
      await tx.query(
        `UPDATE assistant.stock_photos SET status='lista', sam=$2, total=$3, fuente=$4, imagen_sha256=$5, simulated = simulated OR $6 WHERE id = $1`,
        [row.id, JSON.stringify(input.sam), input.sam.total, input.fuente, input.imagen_sha256, input.fuente === 'simulada']);
      await this.closeEvent(tx, row);
      await writeAudit(tx, {businessId: row.business_id, traceId: row.id, actor: 'robot', action: 'photo_done', entity: 'stock_photos', entityId: row.id, args: {total: input.sam.total, sha: input.imagen_sha256}});
    });
    this.notify(row.id);
  }

  async failed(userId: string, input: {request_id: string; motivo: string}): Promise<void> {
    const row = await this.byRequest(userId, input.request_id);
    if (row.status === 'lista' || row.status === 'fallida' || row.status === 'vencida') return;
    await this.deps.db.tx(async tx => {
      await tx.query(`UPDATE assistant.stock_photos SET status='fallida', error=$2 WHERE id = $1`, [row.id, input.motivo]);
      await this.closeEvent(tx, row);
    });
    this.notify(row.id);
  }

  private async closeEvent(tx: StockQuery, row: PhotoRow): Promise<void> {
    await tx.query(
      `UPDATE assistant.stock_robot_events SET status='hecho', acked_at = COALESCE(acked_at, $3)
        WHERE user_id = $1 AND kind = 'foto' AND payload->>'solicitud_id' = $2 AND status IN ('pendiente','entregado','recibido')`,
      [row.user_id, row.request_id, this.deps.now()]);
  }

  /** Evento vencido: pasa a `vencido`, la foto a `vencida`, y quien espere recibe `fallida`. */
  async sweep(): Promise<void> {
    const {rows} = await this.deps.db.query<{kind: string; payload: {solicitud_id?: string}}>(
      `UPDATE assistant.stock_robot_events SET status='vencido'
        WHERE status IN ('pendiente','entregado','recibido') AND expires_at <= $1 RETURNING kind, payload`, [this.deps.now()]);
    for (const event of rows) {
      if (event.kind !== 'foto' || !event.payload.solicitud_id) continue;
      const {rows: photos} = await this.deps.db.query<{id: string}>(
        `UPDATE assistant.stock_photos SET status='vencida', error='vencido' WHERE request_id = $1 AND status IN ('solicitada','entregada') RETURNING id`, [event.payload.solicitud_id]);
      for (const photo of photos) this.notify(photo.id);
    }
  }

  /** La conexión de eventos entregó la orden. */
  async delivered(requestId: string, deviceId: string): Promise<void> {
    await this.deps.db.query(`UPDATE assistant.stock_photos SET status='entregada', device_id=$2 WHERE request_id = $1 AND status='solicitada'`, [requestId, deviceId]);
  }
}
