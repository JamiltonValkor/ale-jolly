import {Logger} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import {
  STOCK_CAUSES, StockProposalV1, StockProposeRequestV1, StockProposeResponseV1,
  type StockAreaV1, type StockRepartoV1, type StockCauseV1, type StockProposalKindV1, type StockProposalStatusV1,
} from '../contracts/stock-v1';
import {conflict, forbidden, invalidRequest, notFound, serviceUnavailable} from '../domain/errors';
import {argsHash, writeAudit} from './audit';
import {areaOf, autonomyTexts, type Autonomy, type AutonomyEvidence, type AutonomyState, type StockBlocked} from './autonomy';
import type {StockClock} from './clock';
import {STOCK_LIMITS} from './config';
import {
  canonicalOf, ledgerBalance, ledgerBalanceAt, lockVariants, recordMovement, StockNegativeError, variantGroup,
} from './ledger';
import type {Notices} from './notices';
import type {OfferingsReader} from './offerings';
import {expireAbandoned, openOrder} from './negotiation';
import {betReach, salesRhythm, type Rotation} from './rotation';
import {activeRun, businessCurrency, findVariant, nameSimilarity, normalizeName, withoutHidden, type StockDb, type StockQuery, type VariantRow} from './store';
import {proposalPhoto, type PhotoStore} from './photos';
import type {Suppliers} from './suppliers';
import type {WakeReason} from './wake';
import {optionNames, variantQuestion, type VariantOption} from './variant-question';

type Method = 'web' | 'voz' | 'canal' | 'semilla';
export interface StockPrincipal {userId: string}
export interface ProposalsDeps {
  db: StockDb; clock: StockClock; offerings: OfferingsReader; rotation: Rotation; suppliers: Suppliers; benchEnabled: boolean; autonomy: Autonomy; notices: Notices;
  wake(userId: string, businessId: string, reason: WakeReason): Promise<unknown>;
  /** `STOCK_WEB_BASE_URL`. Vacío, sin enlace. */
  webBaseUrl?: string;
  /** Idioma del asistente. El enlace lo arma el servidor, nunca el modelo. */
  locale?(userId: string): Promise<string | null>;
  /** Bucket de fotos (IVB-009). Sin él, una foto lista se declara perdida en la web: no se puede firmar. */
  photoStore?: PhotoStore;
  now?: () => Date;
}

/** Estado interno a contrato web: el front solo distingue ver la foto o no poder verla (IVF-004). */
const PHOTO_WIRE = {vigente: 'disponible', vencida: 'no_disponible', perdida: 'no_disponible', sin_foto: 'sin_foto'} as const;

/** Enlaces que escribe el agente: solo web, sin credenciales. Lo demás no sale. Texto de terceros, no confiable. */
export function webSources(value: unknown): Array<{url: string; fecha: string}> {
  if (!Array.isArray(value)) return [];
  const out: Array<{url: string; fecha: string}> = [];
  for (const item of value) {
    const {url, fecha} = (item ?? {}) as {url?: unknown; fecha?: unknown};
    if (typeof url !== 'string' || typeof fecha !== 'string' || !URL.canParse(url)) continue;
    const parsed = new URL(url);
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password) continue;
    out.push({url: parsed.href, fecha: cleanText(fecha)});
  }
  return out;
}

/** Quién puede confirmar qué. Es la decisión del owner leída de forma estricta: lo que no sea conteo va en pantalla. */
export const CONFIRMATION_MATRIX: Record<StockProposalKindV1, readonly Method[]> = {
  conteo: ['web', 'voz', 'canal', 'semilla'], entrada: ['web', 'semilla'], venta: ['web', 'semilla'], catalogo: ['web', 'semilla'],
  union_catalogo: ['web', 'semilla'], pedido: ['web', 'semilla'], kit: ['web', 'semilla'], apuesta: ['web', 'semilla'], autonomia: ['web'],
};

interface Payload {
  variante_id?: string; contado?: number; origen?: 'foto' | 'voz' | 'canal'; photo_id?: string | null; order_id?: string | null; conteo_en?: string;
  pendiente_pedido?: number; esperado?: number; diferencia?: number; causa_requerida?: boolean; producto?: string; cantidad?: number; kit_id?: string | null;
  document_id?: string; proveedor?: string | null; moneda?: string;
  lineas?: Array<{linea_id: string; variante_id: string | null; descripcion: string; cantidad: number; costo_unitario: string; dudoso: string[]; inventario?: string}>;
  variantes?: Array<{nombre: string; unidades_por_caja?: number}>; oferta?: {type: 'product' | 'service'; id: string; nombre: string} | null;
  similares?: Array<{producto_id: string; similitud: number}>; origen_id?: string; destino_id?: string; similitud?: number;
  subtipo?: 'kit' | 'complemento' | 'venta_adicional'; componentes?: Array<{variante_id: string; cantidad: number}>; precio_propuesto?: string | null;
  precio_fuente?: string | null; hipotesis?: string; diagnostico?: string; fuentes?: unknown[]; nombre?: string; presupuesto_diario?: string; tope?: string; duracion_dias?: number;
  unidades_semana_previstas?: number | null; fuente_prevision?: 'dato' | 'supuesto'; vista?: unknown;
  proveedor_id?: string; costo_esperado?: string; mandato?: {precio_objetivo: string; tope: string};
  area?: StockAreaV1; nivel_pedido?: number; monto_tope?: string; revision_nivel?: number; evidencia?: AutonomyEvidence[];
  /** R15: conteo por producto. Sin `variante_id`: el reparto entre `opciones` lo dice el dueño al confirmar. */
  variante_por_confirmar?: boolean; producto_id?: string; opciones?: VariantOption[]; reemplaza?: string[];
  /** R15: conteo por variante que el servidor no dejó repartir. Apunta a la propuesta por producto que lo reemplaza. */
  reemplazada_por?: string;
}

interface ProposalRow {
  id: string; business_id: string; user_id: string; kind: StockProposalKindV1; title: string; reason: string; payload: Payload; status: StockProposalStatusV1;
  revision: number; effects_yes: string[]; effects_no: string[]; expires_at: Date; request_hash: string; trace_id: string; recorded_at: Date; simulated: boolean; run_id: string | null;
}

interface Draft {title: string; reason: string; payload: Payload; effectsYes: string[]; effectsNo: string[]}
const COLUMNS = 'id,business_id,user_id,kind,title,reason,payload,status,revision,effects_yes,effects_no,expires_at,request_hash,trace_id,recorded_at,simulated,run_id';

/** Texto de terceros: dato, nunca instrucción. Una línea y máximo 300 caracteres. */
export const cleanText = (value: string): string => withoutHidden(value).replace(/\s+/g, ' ').trim().slice(0, STOCK_LIMITS.textMax);
const money = (value: string | number): string => Number(value).toFixed(2);
const KIT_LABELS = {kit: 'Kit', complemento: 'Complemento', venta_adicional: 'Venta adicional'} as const;
const tokens = (text: string): string[] => normalizeName(text).split(' ').filter(Boolean);

const NEGATIONS = new Set(['no', 'espera', 'mentira', 'nunca', 'tampoco']);
const STARTS = new Set(['confirmo', 'correcto', 'dale', 'listo']);

/** Regla conservadora: ante la duda no escribe. Una negación en cualquier parte anula; «si» solo vale sola. */
export function isAffirmative(text: string): boolean {
  const words = tokens(text);
  if (!words.length || words.some(word => NEGATIONS.has(word))) return false;
  if (words.length === 1 && words[0] === 'si') return true;
  if (words[0] === 'asi' && words[1] === 'es') return true;
  return STARTS.has(words[0]!);
}

/** El modelo liga cada línea a una variante: el dueño aprueba viendo a cuál, y cuál no entra. */
const entryLineText = (line: {descripcion: string; inventario?: string}): string =>
  `${line.descripcion} ${line.inventario ? `→ ${line.inventario}` : '(no entra al inventario)'}`;

const QUOTE_STARTS = new Set([...STARTS, 'si', 'ok', 'okey', 'claro', 'exacto']);

/** Una cita por canal puede traer más palabras que una frase al robot, pero debe empezar afirmando y no negar nada. */
export function isAffirmativeQuote(text: string): boolean {
  const words = tokens(text);
  if (words.some(word => NEGATIONS.has(word))) return false;
  return QUOTE_STARTS.has(words[0] ?? '') || (words[0] === 'asi' && words[1] === 'es');
}

interface Effect {
  variants(q: StockQuery, row: ProposalRow): Promise<string[]>;
  apply(context: EffectContext): Promise<void>;
}
interface EffectContext {
  proposals: Proposals; autonomy: Autonomy; tx: StockQuery; row: ProposalRow; confirmationId: string; actor: string; causa?: StockCauseV1; now: Date; reparto?: StockRepartoV1;
}

export class Proposals {
  private readonly logger = new Logger('StockProposals');

  constructor(private readonly deps: ProposalsDeps) {}

  /** Las consultas de esta instancia: dentro de `bench_seed` son las de su transacción. */
  queries(): StockQuery {
    return this.deps.db;
  }

  /** Hora del negocio con el reloj de esta instancia. */
  businessNow(businessId: string): Promise<Date> {
    return this.deps.clock.at(businessId);
  }

  // ---- Crear ---------------------------------------------------------------------------------------------------

  /** Los campos que el modelo no puede dictar no existen en el esquema: enviarlos da 400. */
  async create(userId: string, businessId: string, createdBy: string, body: unknown): Promise<StockProposeResponseV1> {
    const request = StockProposeRequestV1.parse(body);
    const {db} = this.deps;
    const runId = await activeRun(db, businessId);
    const hash = argsHash({kind: request.kind, detalle: request.detalle});
    const existing = await this.byKey(businessId, request.idempotency_key, runId);
    if (existing) {
      if (existing.request_hash !== hash) throw conflict();
      return this.created(userId, existing);
    }
    if (request.kind === 'autonomia') return this.askAutonomy({userId, businessId, runId, createdBy, hash, key: request.idempotency_key, detalle: request.detalle});
    const blocked = await this.deps.autonomy.blocked(db, businessId, areaOf(request));
    if (blocked) return blocked;
    const draft = await this.draft(userId, businessId, runId, request);
    if ('pregunta' in draft) return {estado: 'pregunta', pregunta: {codigo: 'unidades_por_caja', texto: draft.pregunta}};
    if (request.kind === 'conteo' && request.detalle.photo_id) {
      return this.createPhotoCount({userId, businessId, runId, createdBy, key: request.idempotency_key, hash, draft});
    }
    const insert = (q: StockQuery) => this.insert(q, {userId, businessId, runId, createdBy, kind: request.kind, key: request.idempotency_key, hash, draft});
    const row = request.kind === 'entrada' ? await db.tx(async tx => {
      await this.assertUnusedDocument(tx, businessId, request.detalle.document_id, runId);
      return insert(tx);
    }) : await insert(db);
    if (!row) {
      const raced = await this.byKey(businessId, request.idempotency_key, runId);
      if (!raced || raced.request_hash !== hash) throw conflict();
      return this.created(userId, raced);
    }
    await this.countNotice(row);
    return this.created(userId, row);
  }

  /** Conteos vivos (pendientes sin vencer o aprobados) de otra variante del mismo producto que comparten objetos con esta foto. */
  private async sharedPhotoCounts(tx: StockQuery, businessId: string, runId: string | null, variant: VariantRow, photo: PhotoObjects): Promise<ProposalRow[]> {
    const now = await this.deps.clock.at(businessId, tx);
    const {rows} = await tx.query<ProposalRow & {photo_id: string}>(
      `SELECT ${COLUMNS.split(',').map(column => `p.${column}`).join(',')}, f.id AS photo_id
         FROM assistant.stock_proposals p JOIN assistant.stock_photos f ON f.id::text = p.payload->>'photo_id'
        WHERE p.business_id = $1 AND p.kind = 'conteo' AND p.run_id IS NOT DISTINCT FROM $2 AND COALESCE(f.parent_photo_id, f.id) = $3
          AND (p.status = 'aprobada' OR (p.status = 'pendiente' AND p.expires_at > $4))
        ORDER BY p.recorded_at, p.id`, [businessId, runId, photo.root, now]);
    const shared: ProposalRow[] = [];
    for (const row of rows) {
      if (row.payload.variante_por_confirmar) {
        if (row.payload.producto_id !== variant.product_id) continue;
      } else {
        const canonical = await canonicalOf(tx, row.payload.variante_id!);
        const other = await findVariant(tx, businessId, canonical, runId);
        if (!other || other.product_id !== variant.product_id || canonical === variant.id) continue;
      }
      if (sharesObjects(photo, await photoObjects(tx, row.photo_id))) shared.push(row);
    }
    return shared;
  }

  /** Las propuestas por variante se vencen y nace una por producto, con el total que vio SAM y sin reparto. */
  private async mergeCounts(tx: StockQuery, input: {userId: string; businessId: string; runId: string | null; createdBy: string; key: string; hash: string; draft: Draft},
    variant: VariantRow, photo: PhotoObjects, pending: ProposalRow[]): Promise<ProposalRow | null> {
    const {businessId, runId, draft} = input;
    const ids: string[] = [];
    let claimed = draft.payload.contado!;
    let seen = photo.total;
    for (const row of pending) {
      const canonical = await canonicalOf(tx, row.payload.variante_id!);
      if (!ids.includes(canonical)) ids.push(canonical);
      claimed += row.payload.contado ?? 0;
      seen = Math.max(seen, (await photoObjects(tx, row.payload.photo_id!)).total);
    }
    if (!ids.includes(variant.id)) ids.push(variant.id);
    const opciones: VariantOption[] = [];
    let esperado = 0;
    const conteoEn = new Date(draft.payload.conteo_en!);
    for (const id of ids) {
      const option = (await findVariant(tx, businessId, id, runId))!;
      opciones.push({variante_id: id, nombre: cleanText(option.variant_name)});
      esperado += await ledgerBalanceAt(tx, businessId, id, runId, conteoEn);
    }
    // Lo que Stock atribuyó al producto, sin pasar de lo que vio SAM: dos variantes no cuentan dos veces los mismos objetos.
    const contado = Math.min(claimed, seen);
    const producto = cleanText(variant.product_name);
    const payload: Payload = {variante_por_confirmar: true, producto_id: variant.product_id, opciones, reemplaza: pending.map(row => row.id), contado, origen: draft.payload.origen,
      photo_id: draft.payload.photo_id, order_id: null, pendiente_pedido: 0, conteo_en: draft.payload.conteo_en, esperado, diferencia: contado - esperado,
      causa_requerida: contado !== esperado, producto};
    const row = await this.insert(tx, {...input, kind: 'conteo', draft: {
      title: `Conteo de ${producto}: variante por confirmar`, reason: `Se contaron ${contado} y no se distingue ${optionNames(opciones)}. Falta que el dueño diga cuántos hay de cada una.`,
      payload, effectsYes: ['Se registra el conteo de cada variante con el reparto que diga el dueño y, si hay diferencia, un ajuste con su causa.'], effectsNo: ['El stock no cambia.']}});
    if (!row) return null;
    for (const old of pending) {
      await tx.query(
        `UPDATE assistant.stock_proposals SET status = 'vencida', revision = revision + 1, payload = payload || jsonb_build_object('reemplazada_por', $2::text) WHERE id = $1`, [old.id, row.id]);
      await writeAudit(tx, {businessId, traceId: old.trace_id, actor: 'servidor', action: 'reemplazada_r15', entity: 'stock_proposals', entityId: old.id, args: {por: row.id}});
    }
    // La plantilla «Conté 5 de Reparador, ¿lo confirmo?» ya no debe sonar: diría un reparto que nadie hizo.
    await tx.query(
      `UPDATE assistant.stock_robot_events SET status = 'descartado'
        WHERE kind = 'decir' AND proposal_id = ANY($1::uuid[]) AND status = 'pendiente' AND payload->>'plantilla' = 'conteo'`, [pending.map(old => old.id)]);
    return row;
  }

  /** Una factura entra una sola vez: dos propuestas vivas aprobadas sumarían dos veces las mismas unidades. */
  private async assertUnusedDocument(tx: StockQuery, businessId: string, documentId: string, runId: string | null): Promise<void> {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [documentId]);
    const {rows} = await tx.query(
      `SELECT 1 FROM assistant.stock_proposals WHERE business_id = $1 AND kind = 'entrada' AND payload->>'document_id' = $2 AND status IN ('pendiente','aprobada') AND run_id IS NOT DISTINCT FROM $3`,
      [businessId, documentId, runId]);
    if (rows[0]) throw conflict();
  }

  private async created(userId: string, stored: ProposalRow): Promise<StockProposeResponseV1> {
    // Repetir la clave de un conteo que R15 no dejó repartir devuelve la propuesta por producto que lo reemplazó.
    const row = stored.payload.reemplazada_por ? await this.read(stored.business_id, stored.payload.reemplazada_por) : stored;
    const [propuesta, enlace] = [await this.view(row), await this.link(userId, row)];
    if (!row.payload.variante_por_confirmar) return {estado: 'creada', propuesta, enlace};
    return {estado: 'variante_por_confirmar', propuesta, enlace, pregunta: {codigo: 'variante', texto: variantQuestion(row.payload), opciones: row.payload.opciones ?? []}};
  }

  /**
   * R15: un conteo desde una foto no se reparte entre variantes del mismo producto. Si otro conteo vivo de otra variante
   * usa los mismos objetos de la misma imagen (§ «Qué cuenta como evidencia» en `docs/stock-contract-v1.md`), los dos se
   * vuelven una sola propuesta por producto con el total, y el reparto lo dice el dueño al confirmar.
   */
  private async createPhotoCount(input: {userId: string; businessId: string; runId: string | null; createdBy: string; key: string; hash: string; draft: Draft}): Promise<StockProposeResponseV1> {
    const {db} = this.deps;
    const {userId, businessId, runId, draft} = input;
    const photo = await photoObjects(db, draft.payload.photo_id!);
    const variant = (await findVariant(db, businessId, draft.payload.variante_id!, runId))!;
    const outcome = await db.tx(async (tx): Promise<{row: ProposalRow | null; fresh: boolean} | {pregunta: string}> => {
      // Mismo candado para toda la imagen: dos conteos simultáneos de la misma foto no se escapan uno del otro.
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`stock_r15:${photo.root}`]);
      const rivals = await this.sharedPhotoCounts(tx, businessId, runId, variant, photo);
      const open = rivals.find(rival => rival.payload.variante_por_confirmar && rival.status === 'pendiente');
      if (open) return {row: open, fresh: false};
      const decided = rivals.find(rival => rival.status === 'aprobada');
      if (decided) {
        return {pregunta: cleanText(`Esa foto ya sirvió para confirmar el conteo de ${decided.payload.producto}. Con la misma foto no se distingue `
          + `${variant.variant_name}: pregúntale al dueño cuántos hay y propón ese conteo con origen voz o canal, sin la foto.`)};
      }
      const pending = rivals.filter(rival => rival.status === 'pendiente');
      if (!pending.length) return {row: await this.insert(tx, {...input, kind: 'conteo'}), fresh: true};
      return {row: await this.mergeCounts(tx, input, variant, photo, pending), fresh: true};
    });
    if ('pregunta' in outcome) return {estado: 'pregunta', pregunta: {codigo: 'variante', texto: outcome.pregunta}};
    if (!outcome.row) {
      const raced = await this.byKey(businessId, input.key, runId);
      if (!raced || raced.request_hash !== input.hash) throw conflict();
      return this.created(userId, raced);
    }
    if (outcome.fresh) await this.countNotice(outcome.row);
    return this.created(userId, outcome.row);
  }

  private async link(userId: string, row: ProposalRow): Promise<string | null> {
    const {webBaseUrl, locale} = this.deps;
    if (!webBaseUrl) return null;
    const language = (await locale?.(userId))?.split('-')[0] || 'es';
    const query = new URLSearchParams({tab: 'stock', vista: 'por-aprobar', negocio: row.business_id, propuesta: row.id});
    return `${webBaseUrl.replace(/\/$/, '')}/${language}/dashboard/meta-assistant?${query}`;
  }

  /**
   * Respaldo de S-20 (R6): si nadie despierta a Ale, el conteo de una foto igual llega al dueño. No lleva texto del modelo
   * y espera un momento: `robot_say` de Ale la reemplaza. Lo que nace de una conversación ya lo está preguntando Ale.
   * Un fallo aquí no tumba la propuesta.
   */
  private async countNotice(row: ProposalRow): Promise<void> {
    const {payload} = row;
    if (row.kind !== 'conteo' || payload.origen !== 'foto') return;
    const {contado, esperado, diferencia, producto} = payload;
    const texto = payload.variante_por_confirmar ? variantQuestion(payload) : diferencia
      ? `Conté ${contado} de ${producto} y esperaba ${esperado}. ¿Qué pasó con la diferencia de ${Math.abs(diferencia)}?`
      : `Conté ${contado} de ${producto}. ¿Lo confirmo?`;
    await this.deps.db.tx(async tx => {
      const product = payload.producto_id ? {rows: [{product_id: payload.producto_id}]}
        : await tx.query<{product_id: string}>('SELECT product_id FROM assistant.stock_variants WHERE id = $1', [payload.variante_id]);
      await this.deps.notices.template(tx, {
        userId: row.user_id, businessId: row.business_id, proposalId: row.id, productId: product.rows[0]?.product_id ?? null, texto: texto.slice(0, 240), pregunta: true, plantilla: 'conteo',
        dedupeKey: `conteo:${row.id}`, esperaSeconds: STOCK_LIMITS.noticeTemplateHoldSeconds,
      });
    }).catch(error => this.logger.warn(`aviso de conteo sin crear: ${(error as Error).name}`));
  }

  /** R34: pedir subir. El servidor decide si se puede, calcula la evidencia y escribe el aviso, todo bajo el candado del área. */
  private async askAutonomy(input: {
    userId: string; businessId: string; runId: string | null; createdBy: string; hash: string; key: string; detalle: {area: StockAreaV1; nivel_pedido: number; monto_tope: string};
  }): Promise<StockProposeResponseV1> {
    const {userId, businessId, runId, createdBy, hash, key, detalle: {area, nivel_pedido: nivel, monto_tope: monto}} = input;
    const {db, autonomy} = this.deps;
    const outcome = await db.tx(async (tx): Promise<ProposalRow | StockBlocked> => {
      const state = await autonomy.lock(tx, businessId, area);
      const blocked = await autonomy.blocked(tx, businessId, area);
      if (blocked) return blocked;
      if (nivel !== state.level + 1 || Number(monto) <= 0) throw invalidRequest();
      const repeated = await this.repeatedRequest(tx, businessId, runId, area, nivel, state);
      if (repeated) return repeated;
      const evidence = await autonomy.evidence(tx, businessId, runId);
      if (!evidence) throw conflict();
      const moneda = await businessCurrency(tx, businessId);
      const efectivo = await autonomy.effective(tx, businessId, area);
      const texts = autonomyTexts({area, nivel, efectivo, monto, ahorro: evidence.ahorro, moneda});
      const row = await this.insert(tx, {userId, businessId, runId, createdBy, kind: 'autonomia', key, hash, draft: {title: texts.title, reason: texts.reason, effectsYes: texts.effectsYes, effectsNo: texts.effectsNo,
        payload: {area, nivel_pedido: nivel, monto_tope: money(monto), revision_nivel: state.revision, evidencia: evidence.items}}});
      if (!row) throw conflict();
      await this.deps.notices.template(tx, {userId, businessId, proposalId: row.id, productId: null, texto: texts.notice, pregunta: false, plantilla: 'autonomia', dedupeKey: `autonomia:${area}:${nivel}`});
      return row;
    });
    if ('estado' in outcome) return outcome;
    return this.created(userId, outcome);
  }

  /** La misma solicitud no se repite en 7 días, y una ya aprobada no se vuelve a pedir mientras siga vigente. */
  private async repeatedRequest(tx: StockQuery, businessId: string, runId: string | null, area: StockAreaV1, nivel: number, state: AutonomyState): Promise<ProposalRow | null> {
    const since = new Date((await this.deps.clock.at(businessId, tx)).getTime() - STOCK_LIMITS.autonomyRepeatDays * 86_400_000);
    const {rows} = await tx.query<ProposalRow>(
      `SELECT ${COLUMNS} FROM assistant.stock_proposals
        WHERE business_id = $1 AND kind = 'autonomia' AND run_id IS NOT DISTINCT FROM $2 AND payload->>'area' = $3 AND (payload->>'nivel_pedido')::int = $4
          AND (status = 'aprobada' OR occurred_at > $5)
        ORDER BY recorded_at DESC, id LIMIT 1`, [businessId, runId, area, nivel, since]);
    const last = rows[0];
    if (!last) return null;
    return last.status !== 'aprobada' || await this.deps.autonomy.grantStands(tx, last.id, state) ? last : null;
  }

  private async byKey(businessId: string, key: string, runId: string | null): Promise<ProposalRow | null> {
    const {rows} = await this.deps.db.query<ProposalRow>(
      `SELECT ${COLUMNS} FROM assistant.stock_proposals WHERE business_id = $1 AND idempotency_key = $2 AND run_id IS NOT DISTINCT FROM $3`, [businessId, key, runId]);
    return rows[0] ?? null;
  }

  private async insert(q: StockQuery, input: {
    userId: string; businessId: string; runId: string | null; createdBy: string; kind: StockProposalKindV1; key: string; hash: string; draft: Draft;
  }): Promise<ProposalRow | null> {
    const now = await this.deps.clock.at(input.businessId, q);
    const expires = new Date(now.getTime() + STOCK_LIMITS.proposalTtlHours * 3_600_000);
    const traceId = await cardTrace(q, input.businessId, input.key)
      ?? (input.kind === 'entrada' ? await invoiceCardTrace(q, input.businessId, input.draft.payload.document_id, input.runId) : null) ?? randomUUID();
    const {rows} = await q.query<ProposalRow>(
      `INSERT INTO assistant.stock_proposals(id,business_id,user_id,kind,title,reason,payload,effects_yes,effects_no,expires_at,idempotency_key,request_hash,trace_id,created_by,occurred_at,simulated,run_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (business_id, idempotency_key, (COALESCE(run_id, '00000000-0000-0000-0000-000000000000'::uuid))) DO NOTHING
       RETURNING ${COLUMNS}`,
      [randomUUID(), input.businessId, input.userId, input.kind, cleanText(input.draft.title), cleanText(input.draft.reason), JSON.stringify(input.draft.payload),
        JSON.stringify(input.draft.effectsYes), JSON.stringify(input.draft.effectsNo), expires, input.key, input.hash, traceId, input.createdBy, now, input.runId !== null, input.runId]);
    return rows[0] ?? null;
  }

  private async variantOr404(q: StockQuery, businessId: string, variantId: string, runId: string | null): Promise<VariantRow> {
    const variant = await findVariant(q, businessId, variantId, runId);
    if (!variant) throw notFound();
    return variant;
  }

  private async assertOwnPhoto(q: StockQuery, businessId: string, id: string, runId: string | null): Promise<void> {
    const {rows} = await q.query('SELECT 1 FROM assistant.stock_photos WHERE id = $1 AND business_id = $2 AND run_id IS NOT DISTINCT FROM $3', [id, businessId, runId]);
    if (!rows.length) throw notFound();
  }

  private async draft(userId: string, businessId: string, runId: string | null, request: Exclude<StockProposeRequestV1, {kind: 'autonomia'}>): Promise<Draft | {pregunta: string}> {
    const {db} = this.deps;
    switch (request.kind) {
      case 'conteo': {
        const {detalle} = request;
        const variant = await this.variantOr404(db, businessId, detalle.variante_id, runId);
        if (variant.is_kit) throw invalidRequest();
        let conteoEn = await this.deps.clock.at(businessId);
        if (detalle.photo_id) {
          await this.assertOwnPhoto(db, businessId, detalle.photo_id, runId);
          const {rows} = await db.query<{occurred_at: Date; total: number | null}>('SELECT occurred_at, total FROM assistant.stock_photos WHERE id = $1', [detalle.photo_id]);
          conteoEn = new Date(rows[0]!.occurred_at);
          // R12: SAM cuenta. Lo que diga un cartel en la foto no sube el número; Stock solo puede descartar objetos ajenos.
          if (rows[0]!.total === null) throw conflict();
          if ((detalle.cajas ?? detalle.contado!) > rows[0]!.total) throw invalidRequest();
        }
        // R16: en caja cerrada se cuenta la caja; las unidades salen del dato confirmado, nunca de una suposición.
        if (detalle.cajas !== undefined && !variant.units_per_box) return {pregunta: `¿Cuántas unidades trae cada caja de ${cleanText(variant.product_name)}?`};
        const contado = detalle.cajas !== undefined ? detalle.cajas * variant.units_per_box! : detalle.contado;
        const canonical = await canonicalOf(db, variant.id);
        const saldo = await ledgerBalanceAt(db, businessId, canonical, runId, conteoEn);
        // IVB-024 (P8): sin `order_id`, un conteo que sube sobre el saldo con un único pedido acordado de la variante es su
        // recepción. Si no se liga, entra como ajuste y se pierde el ahorro confirmado (R31, R32).
        const orderId = detalle.order_id ?? (contado > saldo ? await soleAgreedOrder(db, businessId, canonical, runId) : null);
        const order = orderId ? await receivingOrder(db, businessId, orderId, runId, canonical) : null;
        const esperado = saldo + (order?.quantity ?? 0); // Lo que trae el pedido también se espera en el estante (R32).
        const producto = cleanText(`${variant.product_name} ${variant.variant_name}`);
        const payload: Payload = {variante_id: canonical, contado, origen: detalle.origen, photo_id: detalle.photo_id ?? null, order_id: orderId,
          pendiente_pedido: order?.quantity ?? 0, conteo_en: conteoEn.toISOString(), esperado, diferencia: contado - esperado, causa_requerida: contado !== esperado, producto};
        return {title: `Conteo de ${producto}`, reason: order ? `Llegaron ${receivedOf(contado, saldo)} de ${order.quantity} pedidas.${detalle.order_id ? '' : ' Se ligó al pedido acordado de este producto.'}` : `Se contaron ${contado} y el libro espera ${esperado}.`, payload,
          effectsYes: [order ? 'Se registra lo recibido. Las unidades entran al confirmar la factura.' : 'Se registra el conteo y, si hay diferencia, un ajuste con su causa.'], effectsNo: ['El stock no cambia.']};
      }
      case 'entrada': {
        const {detalle} = request;
        const {rows: documents} = await db.query<{kind: string; status: string; extraction: {proveedor?: {nombre?: string}; moneda?: string} | null}>(
          'SELECT kind, status, extraction FROM assistant.stock_documents WHERE id = $1 AND business_id = $2 AND run_id IS NOT DISTINCT FROM $3', [detalle.document_id, businessId, runId]);
        if (!documents[0]) throw notFound();
        if (documents[0].kind !== 'factura' || documents[0].status !== 'extraido') throw conflict(); // Sin factura extraída no hay propuesta.
        const {rows: stored} = await db.query<{id: string; description: string; quantity: number | null; unit_cost: string | null; doubtful: string[]}>(
          'SELECT id, description, quantity, unit_cost, doubtful FROM assistant.stock_document_lines WHERE document_id = $1', [detalle.document_id]);
        // Propuesta parcial: una línea omitida o repetida cambiaría las unidades sin que el dueño lo vea.
        if (new Set(detalle.lineas.map(line => line.linea_id)).size !== detalle.lineas.length || detalle.lineas.length !== stored.length) throw invalidRequest();
        const lineas: NonNullable<Payload['lineas']> = [];
        for (const line of detalle.lineas) {
          const source = stored.find(item => item.id === line.linea_id);
          if (!source) throw notFound();
          if (source.quantity === null || source.unit_cost === null) throw invalidRequest();
          let inventario: string | undefined;
          if (line.variante_id) {
            const variant = await this.variantOr404(db, businessId, line.variante_id, runId);
            if (variant.is_kit) throw invalidRequest();
            inventario = cleanText(`${variant.product_name} ${variant.variant_name}`);
          }
          lineas.push({linea_id: line.linea_id, variante_id: line.variante_id, descripcion: cleanText(source.description), cantidad: source.quantity,
            costo_unitario: money(source.unit_cost), dudoso: source.doubtful, ...(inventario ? {inventario} : {})});
        }
        if (!lineas.some(line => line.variante_id)) throw invalidRequest();
        if (detalle.order_id) {
          const order = await receivingOrder(db, businessId, detalle.order_id, runId);
          if (order.received_qty === null) throw conflict(); // Primero se cuenta: el ahorro sale de lo recibido (R31, R32).
          const covered = await Promise.all(lineas.filter(line => line.variante_id).map(line => canonicalOf(db, line.variante_id!)));
          if (!covered.includes(await canonicalOf(db, order.variant_id))) throw invalidRequest();
        }
        const proveedor = documents[0].extraction?.proveedor?.nombre;
        const moneda = documents[0].extraction?.moneda;
        return {title: 'Entrada de mercancía', reason: `Factura con ${lineas.length} líneas por confirmar.`,
          payload: {document_id: detalle.document_id, order_id: detalle.order_id ?? null, lineas, proveedor: proveedor ? cleanText(proveedor) : null,
            moneda: moneda && /^[A-Z]{3}$/.test(moneda) ? moneda : await businessCurrency(db, businessId)},
          effectsYes: ['Entran las unidades y queda registrado el costo.'], effectsNo: ['Ni el stock ni el costo cambian.']};
      }
      case 'venta': {
        const {detalle} = request;
        const variant = await this.variantOr404(db, businessId, detalle.variante_id, runId);
        const producto = cleanText(`${variant.product_name} ${variant.variant_name}`);
        return {title: `Venta de ${producto}`, reason: `Venta reportada de ${detalle.cantidad} ${detalle.cantidad === 1 ? 'unidad' : 'unidades'}.`,
          payload: {variante_id: variant.id, cantidad: detalle.cantidad, kit_id: variant.is_kit ? variant.id : null, producto},
          effectsYes: [variant.is_kit ? 'Se descuentan los componentes del kit.' : 'Se descuentan las unidades.'], effectsNo: ['El stock no cambia.']};
      }
      case 'catalogo': {
        const {detalle} = request;
        const offering = await this.deps.offerings.find(userId, businessId, detalle.oferta);
        if (!offering) throw notFound();
        const producto = cleanText(detalle.producto);
        const normalized = normalizeName(producto);
        if (!normalized) throw invalidRequest();
        const {rows: products} = await db.query<{id: string; normalized_name: string}>(
          'SELECT id, normalized_name FROM assistant.stock_products WHERE business_id = $1 AND run_id IS NOT DISTINCT FROM $2 AND NOT is_kit', [businessId, runId]);
        if (products.some(row => row.normalized_name === normalized)) throw conflict();
        const similares = products.map(row => ({producto_id: row.id, similitud: Number(nameSimilarity(normalized, row.normalized_name).toFixed(4))}))
          .filter(item => item.similitud >= STOCK_LIMITS.similarityThreshold).sort((a, b) => b.similitud - a.similitud).slice(0, 3);
        return {title: `Producto nuevo: ${producto}`, reason: similares.length ? 'Se parece a un producto existente: al aprobar se propone unirlos.' : 'Producto nuevo para el catálogo.',
          payload: {producto, variantes: detalle.variantes.map(item => ({...item, nombre: cleanText(item.nombre)})), oferta: {...detalle.oferta, nombre: cleanText(offering.name)}, similares},
          effectsYes: ['Se crea el producto ligado a su oferta, sin cambiar la oferta.'], effectsNo: ['El catálogo no cambia.']};
      }
      case 'union_catalogo': {
        const {detalle} = request;
        const [origin, target] = [await this.variantOr404(db, businessId, detalle.origen_id, runId), await this.variantOr404(db, businessId, detalle.destino_id, runId)];
        if (origin.is_kit || target.is_kit || (await canonicalOf(db, origin.id)) === (await canonicalOf(db, target.id))) throw conflict();
        return this.unionDraft(origin, target);
      }
      case 'kit': {
        const {detalle} = request;
        // Un alias cuenta como su variante canónica: el costo y el saldo son los de esa, y repetirla no suma dos componentes.
        const parts: Array<{variant: VariantRow; cantidad: number}> = [];
        for (const item of detalle.componentes) {
          const variant = await this.variantOr404(db, businessId, await canonicalOf(db, item.variante_id), runId);
          if (variant.is_kit || parts.some(part => part.variant.id === variant.id)) throw invalidRequest();
          parts.push({variant, cantidad: item.cantidad});
        }
        if (new Set(parts.map(part => part.variant.currency)).size > 1) throw invalidRequest();
        const names = parts.map(({variant, cantidad}) => `${cantidad > 1 ? `${cantidad} x ` : ''}${variant.product_name} ${variant.variant_name}`);
        const nombre = cleanText(`${KIT_LABELS[detalle.subtipo]} ${names.join(' + ')}`);
        const isKit = detalle.subtipo === 'kit';
        return {title: `Propuesta: ${nombre}`, reason: 'Propuesta para mover producto parado, con margen del servidor.',
          payload: {subtipo: detalle.subtipo, componentes: parts.map(({variant, cantidad}) => ({variante_id: variant.id, cantidad})),
            // Precio cero es precio sin definir: da margen pendiente, nunca un kit regalado.
            precio_propuesto: Number(detalle.precio_propuesto ?? 0) > 0 ? detalle.precio_propuesto! : null, precio_fuente: detalle.precio_fuente ? cleanText(detalle.precio_fuente) : null,
            hipotesis: cleanText(detalle.hipotesis), diagnostico: cleanText(detalle.diagnostico), fuentes: webSources(detalle.fuentes), nombre, moneda: parts[0]!.variant.currency},
          effectsYes: [isKit ? 'Se crea el kit en el inventario, sin oferta todavía.' : 'Queda aprobada la propuesta.'], effectsNo: ['No se crea ningún kit ni oferta.']};
      }
      case 'apuesta': {
        const {detalle} = request;
        // R19 es del servidor y usa la misma compuerta que `bet-signal`: sin producto o sin unidades no existe la propuesta.
        const {variant, stock, se_puede_pautar: allowed} = await this.deps.rotation.availability(db, businessId, detalle.variante_id, runId);
        if (!allowed) throw conflict();
        const producto = cleanText(`${variant!.product_name} ${variant!.variant_name}`);
        const reach = betReach({saldo: stock!.saldo, unidadesSemana: detalle.unidades_semana_previstas, dias: detalle.duracion_dias, presupuestoDiario: detalle.presupuesto_diario});
        const note = {
          alcanza: '', sin_dato: ' Sin unidades previstas no se sabe si el stock alcanza.',
          no_alcanza: ` El stock no alcanza: hay ${reach.unidades_disponibles} y se prevén ${reach.unidades_necesarias}.`,
        }[reach.estado];
        return {title: `Apuesta de pauta: ${producto}`, reason: `Propuesta de pauta con presupuesto y tope, para decidir en la pantalla.${note}`,
          payload: {...detalle, producto, moneda: await businessCurrency(db, businessId)},
          effectsYes: ['Se guarda el ritmo base. No lanza campañas ni gasta.'], effectsNo: ['No pasa nada con la pauta.']};
      }
      case 'pedido': return this.deps.suppliers.orderDraft(businessId, runId, request.detalle);
    }
  }

  private unionDraft(origin: VariantRow, target: VariantRow): Draft {
    const [from, to] = [`${origin.product_name} ${origin.variant_name}`, `${target.product_name} ${target.variant_name}`];
    return {title: `Unir ${cleanText(from)} con ${cleanText(to)}`, reason: 'Parecen el mismo producto.',
      payload: {origen_id: origin.id, destino_id: target.id, similitud: Number(nameSimilarity(from, to).toFixed(4))},
      effectsYes: ['Sus saldos se suman. Ningún movimiento cambia.'], effectsNo: ['Siguen como productos separados.']};
  }

  // ---- Decidir -------------------------------------------------------------------------------------------------

  async approveWeb(actor: StockPrincipal, businessId: string, id: string, revision: number, key: string, causa?: StockCauseV1, motivo?: string, reparto?: StockRepartoV1): Promise<StockProposalV1> {
    // Sin reparto la clave hashea igual que antes: las repeticiones de clientes viejos siguen dando lo mismo.
    const args = reparto ? ['aprobada', id, causa ?? null, motivo ?? null, reparto] : ['aprobada', id, causa ?? null, motivo ?? null];
    const decided = await this.decideWithKey(businessId, id, key, argsHash(args), hash =>
      this.approve({businessId, id, revision, causa, method: 'web', actor: actor.userId, key, hash, reason: motivo, reparto}));
    return this.forWeb(businessId, decided);
  }

  /** La respuesta a la web lleva la foto firmada, igual que la lista. */
  private async forWeb(businessId: string, proposal: StockProposalV1): Promise<StockProposalV1> {
    return proposal.tipo === 'conteo' && proposal.detalle.foto_estado === 'disponible' ? this.get(businessId, proposal.id, {web: true}) : proposal;
  }

  async reject(actor: StockPrincipal, businessId: string, id: string, revision: number, key: string, reason?: string): Promise<StockProposalV1> {
    return this.forWeb(businessId, await this.decideWithKey(businessId, id, key, argsHash(['rechazada', id, reason ?? null]), async hash => {
      const row = await this.deps.db.tx(async tx => {
        const current = await this.lockedPending(tx, businessId, id, revision);
        await this.confirmation(tx, current, {decision: 'rechazada', method: 'web', actor: actor.userId, key, hash, reason});
        return this.resolve(tx, current, 'rechazada', actor.userId);
      });
      return this.view(row);
    }));
  }

  /** El servidor resuelve la frase: Ale no aporta ningún id. */
  async confirmByVoice(userId: string, businessId: string, id: string, revision: number, causa?: StockCauseV1, reparto?: StockRepartoV1): Promise<StockProposalV1> {
    const row = await this.read(businessId, id);
    if (row.user_id !== userId) throw notFound();
    if (!CONFIRMATION_MATRIX[row.kind].includes('voz')) throw forbidden();
    assertRepartoShape(row, reparto);
    const utteranceId = await this.resolveUtterance(row, text => reparto ? saysReparto(text, repartoNames(row, reparto), optionList(row)) : isAffirmative(text));
    return this.approve({businessId, id, revision, causa, method: 'voz', actor: userId, utteranceId, reparto});
  }

  /** Canal declarado por Ale: atestiguado, solo sin plata y reversible con otro conteo. */
  async confirmByChannel(userId: string, businessId: string, id: string, revision: number, quote: string, sessionId: string, causa?: StockCauseV1, reparto?: StockRepartoV1): Promise<StockProposalV1> {
    const row = await this.read(businessId, id);
    if (row.user_id !== userId) throw notFound();
    if (!CONFIRMATION_MATRIX[row.kind].includes('canal')) throw forbidden();
    if (!quote || quote.length > STOCK_LIMITS.textMax || !sessionId) throw invalidRequest();
    if (row.payload.order_id) throw forbidden(); // Lo recibido alimenta el ahorro confirmado: eso es plata.
    assertRepartoShape(row, reparto);
    if (!(reparto ? saysReparto(quote, repartoNames(row, reparto), optionList(row)) : isAffirmativeQuote(quote))) throw conflict();
    return this.approve({businessId, id, revision, causa, method: 'canal', actor: userId, quote, sessionId, channel: 'whatsapp', reparto});
  }

  /** Historia simulada del banco: nunca cuenta como confirmación real. */
  async confirmSeed(businessId: string, id: string, revision: number, runId: string, causa?: StockCauseV1): Promise<StockProposalV1> {
    const row = await this.read(businessId, id);
    if (!this.deps.benchEnabled || !row.simulated || row.run_id !== runId) throw forbidden();
    return this.approve({businessId, id, revision, causa, method: 'semilla', actor: 'banco'});
  }

  private async read(businessId: string, id: string): Promise<ProposalRow> {
    const runId = await activeRun(this.deps.db, businessId);
    const {rows} = await this.deps.db.query<ProposalRow>(
      `SELECT ${COLUMNS} FROM assistant.stock_proposals WHERE id = $1 AND business_id = $2 AND run_id IS NOT DISTINCT FROM $3`, [id, businessId, runId]);
    if (!rows[0]) throw notFound();
    return rows[0];
  }

  /** La idempotencia va antes que la revisión: repetir la misma decisión devuelve lo mismo. */
  private async decideWithKey(businessId: string, id: string, key: string, hash: string, decide: (hash: string) => Promise<StockProposalV1>): Promise<StockProposalV1> {
    const repeated = async () => {
      const runId = await activeRun(this.deps.db, businessId);
      const {rows} = await this.deps.db.query<{proposal_id: string; request_hash: string}>(
        `SELECT proposal_id, request_hash FROM assistant.stock_confirmations WHERE business_id = $1 AND idempotency_key = $2 AND run_id IS NOT DISTINCT FROM $3`, [businessId, key, runId]);
      if (!rows[0]) return null;
      if (rows[0].request_hash !== hash || rows[0].proposal_id !== id) throw conflict();
      return this.view(await this.read(businessId, id));
    };
    const earlier = await repeated();
    if (earlier) return earlier;
    try {
      return await decide(hash);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await repeated();
      if (raced) return raced;
      throw conflict();
    }
  }

  private async lockedPending(tx: StockQuery, businessId: string, id: string, revision: number): Promise<ProposalRow> {
    const runId = await activeRun(tx, businessId);
    const {rows} = await tx.query<ProposalRow>(
      `SELECT ${COLUMNS} FROM assistant.stock_proposals WHERE id = $1 AND business_id = $2 AND run_id IS NOT DISTINCT FROM $3 FOR UPDATE`, [id, businessId, runId]);
    const row = rows[0];
    if (!row) throw notFound();
    const now = await this.deps.clock.at(businessId, tx);
    if (row.status !== 'pendiente' || new Date(row.expires_at) <= now || row.revision !== revision) throw conflict();
    return row;
  }

  private async confirmation(tx: StockQuery, row: ProposalRow, proof: {
    decision: 'aprobada' | 'rechazada'; method: Method; actor: string; key?: string; hash?: string; reason?: string;
    utteranceId?: string; quote?: string; sessionId?: string; channel?: string;
  }): Promise<string> {
    const id = randomUUID();
    await tx.query(
      `INSERT INTO assistant.stock_confirmations(id,proposal_id,business_id,method,actor,utterance_id,quote,channel,session_id,decision,reason,idempotency_key,request_hash,simulated,run_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [id, row.id, row.business_id, proof.method, proof.actor, proof.utteranceId ?? null, proof.quote ?? null, proof.channel ?? null, proof.sessionId ?? null,
        proof.decision, proof.reason ? cleanText(proof.reason) : null, proof.key ?? null, proof.hash ?? null, row.simulated, row.run_id]);
    return id;
  }

  private async resolve(tx: StockQuery, row: ProposalRow, status: 'aprobada' | 'rechazada', actor: string): Promise<ProposalRow> {
    const {rows} = await tx.query<ProposalRow>(
      `UPDATE assistant.stock_proposals SET status = $2, revision = revision + 1 WHERE id = $1 RETURNING ${COLUMNS}`, [row.id, status]);
    await writeAudit(tx, {businessId: row.business_id, traceId: row.trace_id, actor, action: status, entity: 'stock_proposals', entityId: row.id, args: {kind: row.kind}});
    return rows[0]!;
  }

  private async approve(input: {
    businessId: string; id: string; revision: number; causa?: StockCauseV1; method: Method; actor: string; key?: string; hash?: string; reason?: string;
    utteranceId?: string; quote?: string; sessionId?: string; channel?: string; reparto?: StockRepartoV1;
  }): Promise<StockProposalV1> {
    const {businessId, id, revision, causa, method, actor, reparto} = input;
    const peek = await this.read(businessId, id);
    if (!CONFIRMATION_MATRIX[peek.kind].includes(method)) throw forbidden();
    assertRepartoShape(peek, reparto);
    const effect = EFFECTS[peek.kind];
    try {
      const row = await this.deps.db.tx(async tx => {
        // Primero los candados del libro y luego la fila: al revés, dos aprobaciones se bloquearían entre sí.
        await lockVariants(tx, await effect.variants(tx, peek));
        const current = await this.lockedPending(tx, businessId, id, revision);
        if (method === 'canal') await this.assertChannelBurst(tx, businessId, current.run_id);
        const confirmationId = await this.confirmation(tx, current, {...input, decision: 'aprobada'});
        const now = await this.deps.clock.at(businessId, tx);
        await effect.apply({proposals: this, autonomy: this.deps.autonomy, tx, row: current, confirmationId, actor, causa, now, reparto});
        if (method === 'canal') await writeAudit(tx, {businessId, traceId: current.trace_id, actor, action: 'canal_atestiguado', entity: 'stock_confirmations', entityId: confirmationId, args: {proposal: id}});
        return this.resolve(tx, current, 'aprobada', actor);
      });
      if (row.kind === 'pedido') await this.wakeForOrder(row);
      if (method === 'canal') await this.channelNotice(row);
      return await this.view(row);
    } catch (error) {
      if (error instanceof StockNegativeError) {
        await this.suggestRecount(peek, error.variantId);
        throw error.serviceError;
      }
      if (input.utteranceId && isUniqueViolation(error)) throw conflict();
      throw error;
    }
  }

  /** Con candado: varias confirmaciones a la vez no se saltan el tope. */
  private async assertChannelBurst(tx: StockQuery, businessId: string, runId: string | null): Promise<void> {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`stock_canal:${businessId}`]);
    const {rows} = await tx.query<{n: number}>(
      `SELECT count(*)::int AS n FROM assistant.stock_confirmations
        WHERE business_id = $1 AND method = 'canal' AND run_id IS NOT DISTINCT FROM $2 AND recorded_at > now() - make_interval(secs => $3)`, [businessId, runId, STOCK_LIMITS.channelBurstSeconds]);
    if ((rows[0]?.n ?? 0) >= STOCK_LIMITS.channelBurstMax) throw conflict();
  }

  /** La confirmación por canal la declara Ale. Jolly se lo dice al dueño por otra vía, para que un conteo forjado se note. */
  private async channelNotice(row: ProposalRow): Promise<void> {
    await this.deps.db.tx(tx => this.deps.notices.template(tx, {
      userId: row.user_id, businessId: row.business_id, proposalId: row.id, productId: null, pregunta: false, plantilla: 'pedido', dedupeKey: `canal:${row.id}`,
      texto: `Quedó confirmado por mensaje el conteo de ${row.payload.producto}: ${row.payload.contado}. Si no fuiste tú, cuéntalo otra vez.`.slice(0, 240),
    })).catch(error => this.logger.warn(`aviso de canal sin crear: ${(error as Error).name}`));
  }

  /** Vence negociaciones abandonadas antes de abrir otra. */
  expireAbandoned(tx: StockQuery): Promise<void> {
    return expireAbandoned(tx, this.deps);
  }

  /** Tras confirmar: el dueño ya decidió, y si Ale no despierta queda el tick de 3 horas. */
  private async wakeForOrder(row: ProposalRow): Promise<void> {
    await this.deps.wake(row.user_id, row.business_id, 'pedido_aprobado').catch(error => this.logger.warn(`despertar sin hacer: ${(error as Error).name}`));
  }

  /** Fuera de la transacción fallida: el rechazo no inserta nada en el libro, pero sí deja la tarea de contar. */
  private async suggestRecount(row: ProposalRow, variantId: string): Promise<void> {
    const now = await this.deps.clock.at(row.business_id);
    await this.deps.db.query(
      `INSERT INTO assistant.stock_robot_events(business_id,user_id,kind,payload,proposal_id,expires_at) VALUES ($1,$2,'recount',$3,$4,$5)`,
      [row.business_id, row.user_id, JSON.stringify({variante_id: variantId, motivo: 'stock_negativo'}), row.id, new Date(now.getTime() + STOCK_LIMITS.recountEventTtlMinutes * 60_000)]);
  }

  /** Última frase del usuario, posterior a la propuesta, reciente, afirmativa y sin usar. Con varios conteos, debe nombrarlo la última pregunta. */
  private async resolveUtterance(row: ProposalRow, accept: (text: string) => boolean): Promise<string> {
    const {db} = this.deps;
    const {rows} = await db.query<{id: string; text: string; after: boolean; fresh: boolean; used: boolean}>(
      `SELECT u.id, u.text, u.recorded_at > $2 AS after, now() - u.recorded_at <= make_interval(secs => $3) AS fresh,
              EXISTS (SELECT 1 FROM assistant.stock_confirmations c WHERE c.utterance_id = u.id) AS used
         FROM assistant.stock_owner_utterances u WHERE u.user_id = $1 ORDER BY u.recorded_at DESC LIMIT 1`,
      [row.user_id, row.recorded_at, STOCK_LIMITS.voiceWindowSeconds]);
    const said = rows[0];
    if (!said || !said.after || !said.fresh || said.used || !accept(said.text)) throw conflict();
    const {rows: pending} = await db.query<{n: number}>(
      `SELECT count(*)::int AS n FROM assistant.stock_proposals
        WHERE business_id = $1 AND kind = 'conteo' AND status = 'pendiente' AND expires_at > $2 AND run_id IS NOT DISTINCT FROM $3`,
      [row.business_id, await this.deps.clock.at(row.business_id), row.run_id]);
    if ((pending[0]?.n ?? 0) > 1) {
      const {rows: asked} = await db.query<{proposal_id: string | null}>(
        `SELECT proposal_id FROM assistant.stock_robot_events
          WHERE business_id = $1 AND kind = 'decir' AND payload->>'pregunta' = 'true' ORDER BY id DESC LIMIT 1`, [row.business_id]);
      if (asked[0]?.proposal_id !== row.id) throw conflict();
    }
    return said.id;
  }

  // ---- Leer ----------------------------------------------------------------------------------------------------

  /** `web`: la foto sale firmada. El modelo (MCP) nunca recibe esa URL: la imagen la pide con `get_photo`. */
  async list(businessId: string, status?: StockProposalStatusV1, limit = 50, options: {web?: boolean} = {}): Promise<StockProposalV1[]> {
    const {db} = this.deps;
    const [runId, now] = [await activeRun(db, businessId), await this.deps.clock.at(businessId)];
    // Vencer se aplica al leer: `status` guardado sigue pendiente y la vista dice vencida.
    const {rows} = await db.query<ProposalRow>(
      `SELECT ${COLUMNS} FROM assistant.stock_proposals
        WHERE business_id = $1 AND run_id IS NOT DISTINCT FROM $2
          AND ($3::text IS NULL OR (CASE WHEN status = 'pendiente' AND expires_at <= $4 THEN 'vencida' ELSE status END) = $3)
        ORDER BY recorded_at DESC, id LIMIT $5`, [businessId, runId, status ?? null, now, limit]);
    return Promise.all(rows.map(row => this.view(row, options.web)));
  }

  async get(businessId: string, id: string, options: {web?: boolean} = {}): Promise<StockProposalV1> {
    return this.view(await this.read(businessId, id), options.web);
  }

  private async view(row: ProposalRow, web = false): Promise<StockProposalV1> {
    const now = await this.deps.clock.at(row.business_id);
    const expired = row.status === 'pendiente' && new Date(row.expires_at) <= now;
    const payload = row.payload;
    return StockProposalV1.parse({
      id: row.id, tipo: row.kind, titulo: row.title, motivo: row.reason, creada_en: new Date(row.recorded_at).toISOString(), estado: expired ? 'vencida' : row.status,
      simulado: row.simulated, revision: row.revision, vence_en: new Date(row.expires_at).toISOString(), efectos_si: row.effects_yes, efectos_no: row.effects_no,
      detalle: await this.detail(row, payload, web),
    });
  }

  private async detail(row: ProposalRow, payload: Payload, web: boolean): Promise<unknown> {
    const {db} = this.deps;
    switch (row.kind) {
      case 'conteo': {
        // URL GET firmada al leer, de corta vida. Nunca se guarda ni se loguea.
        const foto = await proposalPhoto({db, store: this.deps.photoStore, now: this.deps.now ?? (() => new Date()),
          onSignError: error => this.logger.warn(`foto ${payload.photo_id} sin firma: ${(error as Error).name}`)}, row.business_id, payload.photo_id, web);
        return {producto: payload.producto, esperado: payload.esperado, contado: payload.contado, diferencia: payload.diferencia, causa_requerida: payload.causa_requerida,
          causa_opciones: payload.causa_requerida ? STOCK_CAUSES : [], origen: payload.origen,
          foto_estado: PHOTO_WIRE[foto.estado], foto_url: foto.url, foto_expira_en: foto.expira_en,
          foto_tomada_en: foto.tomada_en, total_objetos: foto.total, variante_dudosa: payload.variante_por_confirmar ? optionNames(payload.opciones ?? []) : null, conteo_en: payload.conteo_en};
      }
      case 'entrada':
        return {lineas: (payload.lineas ?? []).map(line => ({descripcion: entryLineText(line), cantidad: line.cantidad, costo_unitario: line.costo_unitario, dudoso: line.dudoso})),
          proveedor: payload.proveedor ?? null, documento_id: payload.document_id, moneda: payload.moneda};
      case 'venta': return {producto: payload.producto, cantidad: payload.cantidad, kit_id: payload.kit_id ?? null};
      case 'catalogo': return {producto: payload.producto, variantes: (payload.variantes ?? []).map(item => item.nombre), oferta: payload.oferta ?? null};
      case 'union_catalogo': return {origen_id: payload.origen_id, destino_id: payload.destino_id, similitud: payload.similitud};
      case 'kit': return this.kitDetail(row, payload);
      case 'apuesta': {
        const {stock} = await this.deps.rotation.availability(db, row.business_id, payload.variante_id!, row.run_id);
        return {producto: payload.producto, presupuesto_diario: payload.presupuesto_diario, tope: payload.tope, duracion_dias: payload.duracion_dias,
          unidades_semana_previstas: payload.unidades_semana_previstas ?? null, fuente_prevision: payload.fuente_prevision, moneda: payload.moneda,
          senal: {saldo: stock!.saldo, esperado: stock!.esperado}};
      }
      case 'pedido': return payload.vista;
      case 'autonomia': {
        const {nivel, nivel_efectivo: efectivo} = await this.deps.autonomy.levels(row.business_id, payload.area!);
        return {area: payload.area, nivel_actual: nivel, nivel_pedido: payload.nivel_pedido, nivel_efectivo: efectivo, monto_tope: payload.monto_tope, evidencia: payload.evidencia};
      }
    }
  }

  /** Margen y alcance los calcula el servidor; sin costo o sin precio se dice, nunca se inventa (R20d). */
  private async kitDetail(row: ProposalRow, payload: Payload): Promise<unknown> {
    const {db} = this.deps;
    const componentes: Array<{nombre: string; cantidad: number; costo: string | null}> = [];
    let total = 0;
    let incomplete = false;
    let reach = Number.POSITIVE_INFINITY;
    for (const item of payload.componentes ?? []) {
      const variant = await findVariant(db, row.business_id, await canonicalOf(db, item.variante_id), row.run_id);
      if (!variant) throw serviceUnavailable();
      if (variant.unit_cost === null) incomplete = true;
      else total += Math.round(Number(variant.unit_cost) * 100) * item.cantidad;
      const saldo = await ledgerBalance(db, row.business_id, variant.id, row.run_id);
      reach = Math.min(reach, Math.floor(Math.max(saldo, 0) / item.cantidad));
      componentes.push({nombre: cleanText(`${variant.product_name} ${variant.variant_name}`), cantidad: item.cantidad, costo: variant.unit_cost === null ? null : money(variant.unit_cost)});
    }
    const price = payload.precio_propuesto ?? null;
    const known = !incomplete && price !== null;
    const margin = known ? Math.round(Number(price) * 100) - total : null;
    return {subtipo: payload.subtipo, componentes, costo_total: incomplete ? null : (total / 100).toFixed(2), precio_propuesto: price === null ? null : money(price),
      margen_dinero: margin === null ? null : (margin / 100).toFixed(2), margen_pct: margin === null ? null : Number((margin / Math.round(Number(price) * 100) * 100).toFixed(2)),
      unidades_alcanzan: Number.isFinite(reach) ? reach : 0, costo_incompleto: incomplete, precio_pendiente: price === null, hipotesis: payload.hipotesis,
      // Lo escribió el agente con datos de terceros: se muestra como supuesto, nunca como hecho. Limpio otra vez por si es una fila anterior.
      diagnostico: cleanText(payload.diagnostico ?? ''), precio_fuente: payload.precio_fuente ? cleanText(payload.precio_fuente) : null, fuentes: webSources(payload.fuentes),
      moneda: payload.moneda};
  }

  /** Efecto de `catalogo`: al aprobar un producto parecido nace la propuesta de unir, nunca la unión (R7). */
  async proposeUnions(tx: StockQuery, row: ProposalRow, created: Array<{id: string; name: string}>): Promise<void> {
    for (const similar of row.payload.similares ?? []) {
      const {rows} = await tx.query<{id: string; name: string}>('SELECT id, name FROM assistant.stock_variants WHERE product_id = $1 ORDER BY recorded_at, id', [similar.producto_id]);
      for (const variant of created) {
        const match = rows.length === 1 && created.length === 1 ? rows[0]
          : rows.find(item => nameSimilarity(item.name, variant.name) >= STOCK_LIMITS.similarityThreshold);
        if (!match) continue;
        const [origin, target] = [await findVariant(tx, row.business_id, variant.id, row.run_id), await findVariant(tx, row.business_id, match.id, row.run_id)];
        if (!origin || !target) continue;
        const key = `union-${variant.id}-${match.id}`;
        await this.insert(tx, {userId: row.user_id, businessId: row.business_id, runId: row.run_id, createdBy: 'servidor', kind: 'union_catalogo', key, hash: argsHash({key}),
          draft: this.unionDraft(origin, target)});
      }
    }
  }
}

export const isUniqueViolation = (error: unknown): boolean =>
  (error as {code?: string} | null)?.code === '23505' || (error instanceof Error && /duplicate key|unique constraint/i.test(error.message));

type Box = [number, number, number, number];
interface PhotoObjects {id: string; root: string; concept: string; total: number; boxes: Box[]}

async function photoObjects(q: StockQuery, photoId: string): Promise<PhotoObjects> {
  const {rows} = await q.query<{id: string; root: string; concept: string; total: number | null; sam: {objetos?: Array<{caja?: Box}>} | null}>(
    'SELECT id, COALESCE(parent_photo_id, id) AS root, concept, total, sam FROM assistant.stock_photos WHERE id = $1', [photoId]);
  const row = rows[0];
  if (!row) throw notFound();
  return {id: row.id, root: row.root, concept: row.concept, total: row.total ?? 0, boxes: (row.sam?.objetos ?? []).flatMap(item => item.caja ? [item.caja] : [])};
}

/** «bottle» y «bottles» son el mismo concepto: el plural no le pide a SAM otra cosa. */
const conceptKey = (concept: string): string => normalizeName(concept).split(' ').map(word => word.length > 3 ? word.replace(/(es|s)$/, '') : word).join(' ');

function iou(a: Box, b: Box): number {
  const [w, h] = [Math.min(a[2], b[2]) - Math.max(a[0], b[0]), Math.min(a[3], b[3]) - Math.max(a[1], b[1])];
  if (w <= 0 || h <= 0) return 0;
  const area = (box: Box) => Math.max(box[2] - box[0], 0) * Math.max(box[3] - box[1], 0);
  return w * h / (area(a) + area(b) - w * h);
}

/**
 * R15. Dos fotos de la misma imagen comparten objetos si son la misma foto, si SAM buscó el mismo concepto o si una caja de
 * una se solapa (IoU ≥ 0,5) con una de la otra. Una foto sin objetos no comparte nada. Imágenes distintas nunca comparten.
 */
export function sharesObjects(a: PhotoObjects, b: PhotoObjects): boolean {
  if (a.root !== b.root || a.total === 0 || b.total === 0) return false;
  if (a.id === b.id || conceptKey(a.concept) === conceptKey(b.concept)) return true;
  return a.boxes.some(box => b.boxes.some(other => iou(box, other) >= STOCK_LIMITS.variantOverlapIou));
}

const UNIT_WORDS = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce', 'trece', 'catorce', 'quince',
  'dieciseis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte', 'veintiuno', 'veintidos', 'veintitres', 'veinticuatro', 'veinticinco', 'veintiseis',
  'veintisiete', 'veintiocho', 'veintinueve'];
const NUMBER_WORDS = new Map<string, number>([...UNIT_WORDS.map((word, value) => [word, value] as [string, number]),
  ['un', 1], ['una', 1], ['veintiun', 21], ['ninguno', 0], ['ninguna', 0], ['cien', 100]]);
const TENS = new Map([['treinta', 30], ['cuarenta', 40], ['cincuenta', 50], ['sesenta', 60], ['setenta', 70], ['ochenta', 80], ['noventa', 90]]);

/** Números dichos en español o con cifras: «treinta y dos» es 32. */
export function spokenNumbers(text: string): number[] {
  const words = tokens(text);
  const out: number[] = [];
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    if (/^\d+$/.test(word)) out.push(Number(word));
    else if (NUMBER_WORDS.has(word)) out.push(NUMBER_WORDS.get(word)!);
    else if (TENS.has(word)) {
      const unit = words[index + 1] === 'y' ? NUMBER_WORDS.get(words[index + 2] ?? '') : undefined;
      if (unit !== undefined && unit >= 1 && unit <= 9) {
        out.push(TENS.get(word)! + unit);
        index += 2;
      } else out.push(TENS.get(word)!);
    }
  }
  return out;
}

/**
 * R15: la frase del dueño (voz) o su cita (canal) debe traer el reparto: cada cantidad y cada variante, sin negaciones.
 * Un «sí» a un reparto que propuso Jolly no sirve: ese reparto sería del modelo. Ante la duda no escribe: va a pantalla.
 */
export function saysReparto(text: string, reparto: Array<{contado: number; nombre: string}>, all: string[]): boolean {
  const words = tokens(text);
  if (!words.length || words.some(word => NEGATIONS.has(word))) return false;
  const numbers = spokenNumbers(text);
  for (const entry of reparto) {
    const own = tokens(entry.nombre);
    const others = new Set(all.filter(name => name !== entry.nombre).flatMap(tokens));
    const marks = own.filter(word => !others.has(word));
    if (!marks.length || !marks.some(mark => words.some(word => word === mark || (mark.length >= 4 && word.startsWith(mark))))) return false;
    const at = numbers.indexOf(entry.contado);
    if (at < 0) return false;
    numbers.splice(at, 1);
  }
  return true;
}

const payloadVariant = async (q: StockQuery, row: ProposalRow): Promise<string[]> => {
  if (row.payload.variante_por_confirmar) return Promise.all((row.payload.opciones ?? []).map(option => canonicalOf(q, option.variante_id)));
  return row.payload.variante_id ? [await canonicalOf(q, row.payload.variante_id)] : [];
};

async function kitParts(q: StockQuery, kitVariantId: string): Promise<Array<{variantId: string; quantity: number}>> {
  const {rows} = await q.query<{component_variant_id: string; quantity: number}>(
    'SELECT component_variant_id, quantity FROM assistant.stock_kit_components WHERE kit_variant_id = $1', [kitVariantId]);
  const parts: Array<{variantId: string; quantity: number}> = [];
  for (const row of rows) parts.push({variantId: await canonicalOf(q, row.component_variant_id), quantity: row.quantity});
  return parts;
}

const CARD_KEY = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-/;

/** Stock arma la clave como `<tarjeta.id>-<n>`. Solo vale si el servidor reservó esa tarjeta para este negocio. */
async function cardTrace(q: StockQuery, businessId: string, key: string): Promise<string | null> {
  const id = CARD_KEY.exec(key)?.[1];
  if (!id) return null;
  const {rows} = await q.query<{trace_id: string}>(`SELECT trace_id FROM assistant.stock_audit WHERE business_id = $1 AND trace_id = $2 AND action = 'tarjeta_reservada' LIMIT 1`, [businessId, id]);
  return rows[0]?.trace_id ?? null;
}

/**
 * IVB-024 (cierre): una entrada cuya clave no trae `tarjeta.id` igual se rastrea hasta su tarjeta `factura`, que el servidor
 * reservó con el mismo `document_id` (clave `stock:<negocio>:factura:<document_id>`). Sin esa reserva no se inventa.
 */
async function invoiceCardTrace(q: StockQuery, businessId: string, documentId: string | undefined, runId: string | null): Promise<string | null> {
  if (!documentId) return null;
  const clave = `stock:${businessId}:factura:${documentId}`;
  const {rows} = await q.query<{trace_id: string}>(
    `SELECT trace_id FROM assistant.stock_audit WHERE business_id = $1 AND action = 'tarjeta_reservada' AND entity_id = $2 ORDER BY recorded_at DESC LIMIT 1`,
    [businessId, runId ? `${clave}@${runId}` : clave]);
  return rows[0]?.trace_id ?? null;
}

interface OrderForReceipt {status: string; quantity: number; variant_id: string; received_qty: number | null}

/** Solo se recibe lo acordado. Un producto distinto al del pedido no llena lo recibido. */
async function receivingOrder(q: StockQuery, businessId: string, orderId: string, runId: string | null, variantId?: string, lock = ''): Promise<OrderForReceipt> {
  const {rows} = await q.query<OrderForReceipt>(
    `SELECT status, quantity, variant_id, received_qty FROM assistant.stock_orders WHERE id = $1 AND business_id = $2 AND run_id IS NOT DISTINCT FROM $3 ${lock}`, [orderId, businessId, runId]);
  const order = rows[0];
  if (!order) throw notFound();
  if (order.status !== 'acordado') throw conflict();
  if (variantId && await canonicalOf(q, order.variant_id) !== variantId) throw invalidRequest();
  return order;
}

/** El único pedido `acordado` de la variante en la corrida. Con dos o más no se adivina: el conteo sigue sin pedido. */
async function soleAgreedOrder(q: StockQuery, businessId: string, variantId: string, runId: string | null): Promise<string | null> {
  const {rows} = await q.query<{id: string; variant_id: string}>(
    `SELECT id, variant_id FROM assistant.stock_orders WHERE business_id = $1 AND run_id IS NOT DISTINCT FROM $2 AND status = 'acordado'`, [businessId, runId]);
  const mine: string[] = [];
  for (const row of rows) if (await canonicalOf(q, row.variant_id) === variantId) mine.push(row.id);
  return mine.length === 1 ? mine[0]! : null;
}

/** El estante trae lo que ya había: lo recibido es lo que sobra sobre el saldo previo. */
const receivedOf = (contado: number, saldo: number): number => Math.max(contado - saldo, 0);

/** R31: ahorro por unidad contra la factura previa, sobre lo recibido. Sin base o sin acuerdo no se inventa. */
export function confirmedSaving(baseUnit: string | null, agreedUnit: string | null, received: number): string | null {
  if (baseUnit === null || agreedUnit === null) return null;
  return ((Math.round(Number(baseUnit) * 100) - Math.round(Number(agreedUnit) * 100)) * received / 100).toFixed(2);
}

async function lastOrderCount(q: StockQuery, orderId: string) {
  const {rows} = await q.query<{counted: number; counted_at: Date; cause: StockCauseV1 | null}>(
    'SELECT counted, counted_at, cause FROM assistant.stock_counts WHERE order_id = $1 AND confirmation_id IS NOT NULL ORDER BY counted_at DESC, recorded_at DESC LIMIT 1', [orderId]);
  return rows[0] ?? null;
}

async function orderSaving(q: StockQuery, orderId: string, received: number): Promise<string | null> {
  const {rows} = await q.query<{base_unit_cost: string | null; last_offer: string | null}>(
    'SELECT o.base_unit_cost, n.last_offer FROM assistant.stock_orders o LEFT JOIN assistant.stock_negotiations n ON n.order_id = o.id WHERE o.id = $1', [orderId]);
  return confirmedSaving(rows[0]?.base_unit_cost ?? null, rows[0]?.last_offer ?? null, received);
}

const movementBase = ({row, confirmationId, actor}: EffectContext) => ({
  businessId: row.business_id, confirmationId, proposalId: row.id, traceId: row.trace_id, actor, runId: row.run_id, simulated: row.simulated,
});

/** Un conteo de una variante: fila en `stock_counts` y, si hay diferencia sin pedido, un ajuste con su causa (R5, R6). */
async function applyCount(context: EffectContext, input: {variantId: string; contado: number; causa?: StockCauseV1; orderId: string | null}): Promise<void> {
  const {tx, row, confirmationId, now} = context;
  const {variantId, contado, causa, orderId} = input;
  const countedAt = new Date(row.payload.conteo_en!);
  const group = await variantGroup(tx, variantId);
  const newer = await tx.query(
    `SELECT 1 FROM assistant.stock_counts WHERE business_id = $1 AND variant_id = ANY($2::uuid[]) AND run_id IS NOT DISTINCT FROM $3
       AND confirmation_id IS NOT NULL AND counted_at > $4 LIMIT 1`, [row.business_id, group, row.run_id, countedAt]);
  if (newer.rows.length) throw conflict(); // Un conteo posterior ya fijó la base: este quedó superado.
  const saldo = await ledgerBalanceAt(tx, row.business_id, variantId, row.run_id, countedAt);
  const order = orderId ? await receivingOrder(tx, row.business_id, orderId, row.run_id, variantId, 'FOR UPDATE') : null;
  const esperado = saldo + (order?.quantity ?? 0);
  const delta = contado - esperado; // Contra saldo_a(conteo_en): una aprobación tardía no borra lo que entró después.
  if (delta !== 0 && !causa) throw invalidRequest();
  await tx.query(
    `INSERT INTO assistant.stock_counts(id,business_id,proposal_id,variant_id,counted_at,expected,counted,difference,origin,photo_id,cause,order_id,confirmation_id,occurred_at,simulated,run_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [randomUUID(), row.business_id, row.id, variantId, countedAt, esperado, contado, delta, row.payload.origen, row.payload.photo_id ?? null, delta ? causa : null,
      orderId, confirmationId, now, row.simulated, row.run_id]);
  // Con pedido el libro no se mueve aquí: la mercancía aún no entró, y un ajuste la sumaría dos veces con la factura.
  if (order) {
    await tx.query('UPDATE assistant.stock_orders SET received_qty = $2 WHERE id = $1', [orderId, receivedOf(contado, saldo)]);
  } else if (delta !== 0) {
    await recordMovement(tx, {...movementBase(context), variantId, kind: 'ajuste', delta, occurredAt: countedAt, origin: `conteo:${row.payload.origen}`, cause: causa});
  }
}

/** R15: el reparto va solo, y siempre, en un conteo con variante por confirmar. */
function assertRepartoShape(row: ProposalRow, reparto: StockRepartoV1 | undefined): void {
  if (Boolean(row.payload.variante_por_confirmar) !== Boolean(reparto)) throw invalidRequest();
}
const optionList = (row: ProposalRow): string[] => (row.payload.opciones ?? []).map(option => option.nombre);
/** Nombre de cada variante del reparto. Una que no sea opción no tiene nombre y la frase no la puede respaldar. */
const repartoNames = (row: ProposalRow, reparto: StockRepartoV1): Array<{contado: number; nombre: string}> =>
  reparto.map(entry => ({contado: entry.contado, nombre: row.payload.opciones?.find(option => option.variante_id === entry.variante_id)?.nombre ?? ''}));

/** Lo que pasa al aprobar, en la misma transacción. */
const EFFECTS: Record<StockProposalKindV1, Effect> = {
  conteo: {
    variants: payloadVariant,
    async apply(context) {
      const {tx, row, causa, reparto} = context;
      if (!row.payload.variante_por_confirmar) {
        await applyCount(context, {variantId: await canonicalOf(tx, row.payload.variante_id!), contado: row.payload.contado!, causa, orderId: row.payload.order_id ?? null});
        return;
      }
      // R15: el reparto del dueño, entre las opciones de la propuesta y con la suma del total. Cada variante con su conteo y su causa.
      const options = await payloadVariant(tx, row);
      const entries: Array<{variantId: string; contado: number; causa?: StockCauseV1}> = [];
      for (const entry of reparto!) {
        const variantId = await canonicalOf(tx, entry.variante_id);
        if (!options.includes(variantId) || entries.some(item => item.variantId === variantId)) throw invalidRequest();
        entries.push({variantId, contado: entry.contado, causa: entry.causa ?? causa});
      }
      if (entries.reduce((sum, item) => sum + item.contado, 0) !== row.payload.contado) throw invalidRequest();
      for (const entry of entries) await applyCount(context, {variantId: entry.variantId, contado: entry.contado, causa: entry.causa, orderId: null});
    },
  },
  entrada: {
    async variants(q, row) {
      const ids: string[] = [];
      for (const line of row.payload.lineas ?? []) if (line.variante_id) ids.push(await canonicalOf(q, line.variante_id));
      return ids;
    },
    async apply(context) {
      const {tx, row, now} = context;
      const orderId = row.payload.order_id;
      const order = orderId ? await receivingOrder(tx, row.business_id, orderId, row.run_id, undefined, 'FOR UPDATE') : null;
      const orderVariant = order ? await canonicalOf(tx, order.variant_id) : null;
      const count = order ? await lastOrderCount(tx, orderId!) : null;
      if (order && !count) throw conflict();
      for (const line of row.payload.lineas ?? []) {
        if (!line.variante_id || line.cantidad <= 0) continue;
        const variantId = await canonicalOf(tx, line.variante_id);
        // Lo del pedido ya estaba en el estante al contar: con esa fecha el conteo no lo suma otra vez (R5).
        await recordMovement(tx, {...movementBase(context), variantId, kind: 'entrada', delta: line.cantidad, occurredAt: variantId === orderVariant ? new Date(count!.counted_at) : now, origin: 'factura',
          unitCost: line.costo_unitario, currency: row.payload.moneda, orderId});
        // R10: solo tras confirmar. Otra moneda queda en el movimiento y no pisa el costo: no se convierte.
        await tx.query('UPDATE assistant.stock_variants SET unit_cost = $2 WHERE id = $1 AND currency = $3', [variantId, line.costo_unitario, row.payload.moneda]);
      }
      if (!order) return;
      const countedAt = new Date(count!.counted_at);
      const delta = count!.counted - await ledgerBalanceAt(tx, row.business_id, orderVariant!, row.run_id, countedAt);
      if (delta !== 0) {
        await recordMovement(tx, {...movementBase(context), variantId: orderVariant!, kind: 'ajuste', delta, occurredAt: countedAt, origin: 'conteo:pedido', cause: count!.cause ?? 'otra', orderId});
      }
      await tx.query(
        `UPDATE assistant.stock_orders o SET status = 'recibido', novedad = NULL, saving_confirmed = $2 WHERE o.id = $1`,
        [orderId, await orderSaving(tx, orderId!, order.received_qty!)]);
    },
  },
  venta: {
    async variants(q, row) {
      if (!row.payload.kit_id) return payloadVariant(q, row);
      return (await kitParts(q, row.payload.kit_id)).map(part => part.variantId);
    },
    async apply(context) {
      const {tx, row, now} = context;
      const cantidad = row.payload.cantidad!;
      if (!row.payload.kit_id) {
        await recordMovement(tx, {...movementBase(context), variantId: row.payload.variante_id!, kind: 'venta', delta: -cantidad, occurredAt: now, origin: 'venta_reportada'});
        return;
      }
      // Todos los componentes o ninguno: un saldo insuficiente aborta la transacción completa (R2).
      for (const part of await kitParts(tx, row.payload.kit_id)) {
        await recordMovement(tx, {...movementBase(context), variantId: part.variantId, kind: 'venta', delta: -cantidad * part.quantity, occurredAt: now, origin: 'venta_reportada', kitVariantId: row.payload.kit_id});
      }
    },
  },
  catalogo: {
    variants: async () => [],
    async apply({proposals, tx, row, now}) {
      const producto = row.payload.producto!;
      const normalized = normalizeName(producto);
      const {rows} = await tx.query('SELECT 1 FROM assistant.stock_products WHERE business_id = $1 AND normalized_name = $2 AND run_id IS NOT DISTINCT FROM $3', [row.business_id, normalized, row.run_id]);
      if (rows.length) throw conflict();
      const productId = randomUUID();
      const oferta = row.payload.oferta!;
      await tx.query(
        `INSERT INTO assistant.stock_products(id,business_id,user_id,name,normalized_name,offering_type,offering_id,offering_name,occurred_at,simulated,run_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [productId, row.business_id, row.user_id, producto, normalized, oferta.type, oferta.id, oferta.nombre, now, row.simulated, row.run_id]);
      const currency = await businessCurrency(tx, row.business_id);
      const created: Array<{id: string; name: string}> = [];
      for (const variant of row.payload.variantes ?? []) {
        const id = randomUUID();
        await tx.query('INSERT INTO assistant.stock_variants(id,product_id,name,units_per_box,currency) VALUES ($1,$2,$3,$4,$5)',
          [id, productId, variant.nombre, variant.unidades_por_caja ?? null, currency]);
        created.push({id, name: variant.nombre});
      }
      await proposals.proposeUnions(tx, row, created);
    },
  },
  union_catalogo: {
    async variants(q, row) {return [await canonicalOf(q, row.payload.origen_id!), await canonicalOf(q, row.payload.destino_id!)];},
    async apply({tx, row, confirmationId}) {
      const [origin, target] = [await canonicalOf(tx, row.payload.origen_id!), await canonicalOf(tx, row.payload.destino_id!)];
      if (origin === target) throw conflict();
      await tx.query('INSERT INTO assistant.stock_variant_aliases(alias_variant_id,canonical_variant_id,confirmation_id) VALUES ($1,$2,$3)', [origin, target, confirmationId]);
    },
  },
  kit: {
    variants: async () => [],
    async apply({tx, row, now}) {
      if (row.payload.subtipo !== 'kit') return; // Complemento y venta adicional solo guardan la propuesta aprobada.
      const name = row.payload.nombre!;
      const normalized = normalizeName(name);
      const {rows} = await tx.query('SELECT 1 FROM assistant.stock_products WHERE business_id = $1 AND normalized_name = $2 AND run_id IS NOT DISTINCT FROM $3', [row.business_id, normalized, row.run_id]);
      if (rows.length) throw conflict();
      const [productId, variantId] = [randomUUID(), randomUUID()];
      await tx.query(
        `INSERT INTO assistant.stock_products(id,business_id,user_id,name,normalized_name,is_kit,occurred_at,simulated,run_id) VALUES ($1,$2,$3,$4,$5,true,$6,$7,$8)`,
        [productId, row.business_id, row.user_id, name, normalized, now, row.simulated, row.run_id]);
      await tx.query('INSERT INTO assistant.stock_variants(id,product_id,name,sale_price,currency,is_kit) VALUES ($1,$2,$3,$4,$5,true)',
        [variantId, productId, name, row.payload.precio_propuesto ?? null, row.payload.moneda]);
      for (const part of row.payload.componentes ?? []) {
        await tx.query('INSERT INTO assistant.stock_kit_components(kit_variant_id,component_variant_id,quantity) VALUES ($1,$2,$3)', [variantId, part.variante_id, part.cantidad]);
      }
    },
  },
  apuesta: {
    variants: async () => [],
    async apply({tx, row, now}) {
      // Aprobar no lanza ni gasta: solo congela el ritmo base previo a la apuesta (R17, R36).
      const variantId = await canonicalOf(tx, row.payload.variante_id!);
      const {base, weeks} = await salesRhythm(tx, row.business_id, variantId, row.run_id, now);
      await tx.query('INSERT INTO assistant.stock_rotation_baselines(variant_id,computed_at,weekly_rate,weeks,before_bet,proposal_id) VALUES ($1,$2,$3,$4,true,$5)',
        [variantId, now, base, weeks, row.id]);
    },
  },
  pedido: {
    variants: async () => [],
    // Pedido y negociación nacen juntos: no hay estado intermedio. El mandato no se toca después: lo impide un trigger.
    async apply({proposals, tx, row, now}) {
      const {variante_id: variantId, proveedor_id: supplierId, cantidad, costo_esperado: expectedCost, moneda, mandato} = row.payload;
      const {rows} = await tx.query<{unit_cost: string | null; currency: string}>('SELECT unit_cost, currency FROM assistant.stock_variants WHERE id = $1', [variantId]);
      await openOrder(tx, {businessId: row.business_id, userId: row.user_id, variantId: variantId!, supplierId: supplierId!, quantity: cantidad!, expectedCost: expectedCost!,
        baseUnitCost: rows[0]?.currency === moneda ? rows[0]!.unit_cost : null, currency: moneda!, proposalId: row.id, now, simulated: row.simulated, runId: row.run_id,
        target: mandato!.precio_objetivo, max: mandato!.tope, sweep: q => proposals.expireAbandoned(q)});
    },
  },
  autonomia: {
    variants: async () => [],
    // R35: registra el permiso del dueño. `stock_autonomy.level` no cambia.
    async apply({autonomy, tx, row}) {
      const {area, nivel_pedido: level, monto_tope: montoTope, revision_nivel: revision} = row.payload;
      await autonomy.grant(tx, {businessId: row.business_id, runId: row.run_id, proposalId: row.id, area: area!, level: level!, montoTope: montoTope!, revision: revision!});
    },
  },
};
