import {Logger} from '@nestjs/common';
import {createHash, randomInt, randomUUID, timingSafeEqual} from 'node:crypto';
import type {
  AgentActivationDetailsV1, ApprovalCodeResponseV1, ApprovalCreateRequestV1, ApprovalDetailsV1, ApprovalItemV1, ApprovalKindV1, ApprovalV1,
  ApprovalVerificationV1,
} from '../contracts/v1';
import {
  approvalAlreadyDecided, approvalCodeAttempts, approvalCodeExpired, approvalCodeInvalid, approvalExpired, approvalStale, invalidRequest,
  notFound, serviceUnavailable,
} from '../domain/errors';
import type {ApprovalRow, ApprovalsRepository} from './approvals-repository';
import {AGENT_ACTIVATION_KIND, AGENT_ACTIVATION_TTL_MS, type AgentActivationActions} from './agent-activation';
import {isSpendKind, type SpendActions} from './spend';

export const APPROVALS_SERVICE = Symbol('APPROVALS_SERVICE');

/**
 * Ejecuta un tipo de aprobación (OSB-016 registra install/uninstall de skills
 * e install_mcp). `isStale` dice si el ítem cambió de versión desde la
 * propuesta; `execute` aplica el cambio (metadata de la VM) y devuelve un
 * resultado sin datos privados.
 */
export interface ApprovalExecutor {
  readonly kind: ApprovalKindV1;
  isStale(row: ApprovalRow): Promise<boolean>;
  execute(row: ApprovalRow): Promise<Record<string, unknown>>;
}

/**
 * Catálogo de habilidades y MCPs (OSB-016). Devuelve el ítem público vigente o
 * null si no existe o no aplica al negocio. Nunca texto libre del agente.
 */
export interface ApprovalCatalog {
  resolve(input: {userId: string; businessId: string; kind: ApprovalKindV1; itemId: string}): Promise<ApprovalItemV1 | null>;
  /** Registro de lo propuesto y lo rechazado, para no insistir (OSB-016). */
  onProposed?(row: ApprovalRow): Promise<void>;
  onRejected?(row: ApprovalRow): Promise<void>;
}

export interface ApprovalsDeps {
  repository: ApprovalsRepository;
  catalog?: ApprovalCatalog;
  /** MLB-013: recursos y ejecución de las aprobaciones de gasto. */
  spend?: Pick<SpendActions, 'resolve'>;
  /** AAB-012: encender lo que publicó el agente (un botón, sin código, D21). */
  agent?: Pick<AgentActivationActions, 'resolve' | 'onRejected' | 'options'>;
  executors?: readonly ApprovalExecutor[];
  ttlMs?: number;
  now?: () => Date;
}

export const DECISION_KEY = /^[A-Za-z0-9_-]{8,128}$/;
const DAY_MS = 24 * 3_600_000;
/** MLB-013: código de un solo uso (simulado, D8): 5 minutos, 3 intentos por código, 3 códigos por aprobación. */
const CODE_TTL_MS = 5 * 60_000;
const CODE_ATTEMPTS = 3;
const SPEND_TTL_MS = 6 * 3_600_000;

const primitive = (value: unknown): value is string | number | boolean | null =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value);

export function toApprovalV1(row: ApprovalRow): ApprovalV1 {
  const result = row.result && (isSpendKind(row.kind) || row.kind === AGENT_ACTIVATION_KIND)
    ? Object.fromEntries(Object.entries(row.result).filter(([, value]) => primitive(value))) as Record<string, string | number | boolean | null>
    : null;
  return {
    id: row.id,
    business_id: row.business_id,
    kind: row.kind,
    status: row.status,
    item: {id: row.item_id, name: row.item_name, version: row.item_version, summary: row.item_summary},
    // Solo en las de gasto: el front publicado (estricto) sigue leyendo las de instalación sin cambios.
    ...(row.details ? {details: {...row.details, result}} : {}),
    expires_at: row.expires_at.toISOString(),
    created_at: row.created_at.toISOString(),
    decided_at: row.decided_at ? row.decided_at.toISOString() : null,
  };
}

const codeHash = (approvalId: string, code: string) => createHash('sha256').update(`${approvalId}:${code}`).digest('hex');

/**
 * Aprobaciones de instalación (ORQA cliente, OSB-013).
 *
 * - El MCP propone por la ruta interna; una propuesta pendiente o rechazada del
 *   mismo ítem y versión se devuelve tal cual (no se duplica ni se insiste).
 * - El dueño decide en la web con su sesión: un solo uso, vence a las 24 h y
 *   queda STALE si el ítem cambió de versión. Repetir la misma decisión con la
 *   misma Idempotency-Key devuelve el mismo resultado.
 * - Ningún ejecutor corre sin una aprobación tomada en este servicio.
 */
export class ApprovalsService {
  private readonly logger = new Logger('approvals');
  private readonly executors: Map<ApprovalKindV1, ApprovalExecutor>;
  private readonly now: () => Date;

  constructor(private readonly deps: ApprovalsDeps) {
    this.executors = new Map((deps.executors ?? []).map(executor => [executor.kind, executor]));
    this.now = deps.now ?? (() => new Date());
  }

  async propose(userId: string, input: ApprovalCreateRequestV1): Promise<ApprovalV1> {
    const {repository, catalog, spend} = this.deps;
    let item: ApprovalItemV1 | null;
    let details: ApprovalDetailsV1 | AgentActivationDetailsV1 | null = null;
    if (input.kind === AGENT_ACTIVATION_KIND) {
      // C-31: apagado hasta que el front que entiende este tipo (AAF-001) esté desplegado.
      if (!this.deps.agent?.options.enabled) throw invalidRequest();
      const resource = await this.deps.agent.resolve({userId, businessId: input.business_id, itemId: input.item_id, params: input.params});
      item = resource.item;
      details = resource.details;
    } else if (isSpendKind(input.kind)) {
      if (!spend) throw serviceUnavailable();
      const resource = await spend.resolve({userId, businessId: input.business_id, kind: input.kind, itemId: input.item_id, params: input.params});
      item = resource.item;
      details = resource.details;
    } else {
      if (!catalog) throw serviceUnavailable();
      if (input.params && Object.keys(input.params).length) throw invalidRequest();
      item = await catalog.resolve({userId, businessId: input.business_id, kind: input.kind, itemId: input.item_id});
    }
    if (!item) throw notFound();
    const existing = await repository.latestForItem(userId, input.kind, item.id, item.version);
    if (existing && (existing.status === 'rejected' || existing.expires_at > this.now())) return toApprovalV1(existing);
    if (existing) await repository.markExpired(existing.id);
    // The owner sees ONE activation per publication: a new projection replaces the older pending one (dev E2E 2026-10-30).
    if (input.kind === AGENT_ACTIVATION_KIND) await repository.expireOtherPending(userId, input.kind, item.id, item.version);
    // El encendido del agente vive 24 h (el dueño lo ve en su panel cuando entra); las de gasto, 6 h.
    const ttl = input.kind === AGENT_ACTIVATION_KIND ? AGENT_ACTIVATION_TTL_MS : details ? SPEND_TTL_MS : (this.deps.ttlMs ?? DAY_MS);
    const row = await repository.insert(randomUUID(), userId,
      {business_id: input.business_id, kind: input.kind, item, details, params: details ? input.params ?? {} : null},
      new Date(this.now().getTime() + ttl));
    if (!details) await catalog?.onProposed?.(row);
    return toApprovalV1(row);
  }

  /**
   * MLB-013: código simulado (D8). Cada llamada invalida el anterior; como máximo 3 por aprobación.
   * Se guarda solo el hash; el código vuelve en la respuesta para que la web lo muestre como si llegara por mensaje.
   */
  async requestCode(userId: string, id: string): Promise<ApprovalCodeResponseV1> {
    const row = await this.owned(userId, id);
    if (!isSpendKind(row.kind) || row.status !== 'pending') throw invalidRequest();
    if (row.expires_at <= this.now()) {
      await this.deps.repository.markExpired(row.id);
      throw approvalExpired();
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = new Date(this.now().getTime() + CODE_TTL_MS);
    const issued = await this.deps.repository.issueCode(row.id, codeHash(row.id, code), expiresAt, this.now());
    if (!issued) throw approvalCodeAttempts();
    return {expires_at: expiresAt.toISOString(), attempts_left: CODE_ATTEMPTS, delivery: 'simulated', code};
  }

  /** Una pendiente vencida se presenta como `expired`: la web no ofrece decidir lo que ya no se puede. */
  async get(userId: string, id: string): Promise<ApprovalV1> {
    const row = await this.owned(userId, id);
    const approval = toApprovalV1(row);
    if (approval.status === 'pending' && new Date(approval.expires_at) <= this.now()) return {...approval, status: 'expired'};
    // El encendido del agente se muestra vencido si lo que encendería ya no es lo que dice (sin escribir: lo decide approve).
    if (approval.status === 'pending' && row.kind === AGENT_ACTIVATION_KIND) {
      try {
        if (await this.executors.get(row.kind)?.isStale(row)) return {...approval, status: 'stale'};
      } catch {
        return approval;
      }
    }
    return approval;
  }

  async approve(userId: string, id: string, key: string, code?: string): Promise<ApprovalV1> {
    const row = await this.owned(userId, id);
    const executor = this.executors.get(row.kind);
    if (!executor) throw serviceUnavailable();
    // Repetir con la misma clave devuelve lo ya decidido sin gastar intentos del código.
    if (row.status !== 'pending') return this.replay(row, key, ['executing', 'executed', 'failed']);
    if (isSpendKind(row.kind)) await this.checkCode(row, code);
    if (await executor.isStale(row)) {
      const stale = await this.deps.repository.claim(id, 'stale', key, this.now());
      if (stale) throw approvalStale();
      return this.replay(await this.owned(userId, id), key, ['executing', 'executed', 'failed']);
    }
    const claimed = await this.deps.repository.claim(id, 'executing', key, this.now());
    if (!claimed) return this.replay(await this.owned(userId, id), key, ['executing', 'executed', 'failed']);
    try {
      return toApprovalV1(await this.deps.repository.finish(id, 'executed', await executor.execute(claimed)));
    } catch (error) {
      const code = (error as {code?: unknown}).code;
      this.logger.warn(`approval execute failed kind=${row.kind} reason=${error instanceof Error ? error.name : 'other'}`);
      return toApprovalV1(await this.deps.repository.finish(id, 'failed',
        {reason: 'execute_failed', ...(typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,60}$/.test(code) ? {code} : {})}));
    }
  }

  /** Antes del claim: el código existe, no venció, no agotó intentos y coincide (y se consume). */
  private async checkCode(row: ApprovalRow, code: string | undefined): Promise<void> {
    if (!row.otp_hash || !row.otp_expires_at) throw approvalCodeInvalid();
    if (row.otp_attempts >= CODE_ATTEMPTS) throw approvalCodeAttempts();
    if (row.otp_expires_at <= this.now()) throw approvalCodeExpired();
    const given = code ? codeHash(row.id, code) : '';
    const ok = given.length === row.otp_hash.length && timingSafeEqual(Buffer.from(given), Buffer.from(row.otp_hash));
    if (!ok) {
      const attempts = await this.deps.repository.failedAttempt(row.id);
      throw attempts >= CODE_ATTEMPTS ? approvalCodeAttempts() : approvalCodeInvalid();
    }
    if (!await this.deps.repository.consumeCode(row.id, given)) throw approvalCodeInvalid();
  }

  async reject(userId: string, id: string, key: string): Promise<ApprovalV1> {
    const row = await this.owned(userId, id);
    if (row.status !== 'pending') return this.replay(row, key, ['rejected']);
    const claimed = await this.deps.repository.claim(id, 'rejected', key, this.now());
    if (!claimed) return this.replay(await this.owned(userId, id), key, ['rejected']);
    if (claimed.kind === AGENT_ACTIVATION_KIND) await this.deps.agent?.onRejected(claimed);
    else await this.deps.catalog?.onRejected?.(claimed);
    return toApprovalV1(claimed);
  }

  /**
   * C-5: integration confirma, antes de tocar Meta, que el dueño aprobó este encendido y que se está ejecutando.
   * Solo lectura; usuario ajeno → 404.
   */
  async verification(userId: string, id: string): Promise<ApprovalVerificationV1> {
    const row = await this.owned(userId, id);
    return {
      approval_id: row.id, kind: row.kind, business_id: row.business_id, user_id: row.user_id, item_id: row.item_id, status: row.status,
      decided_at: row.decided_at ? row.decided_at.toISOString() : null,
    };
  }

  /** Usuario ajeno o id inexistente → 404 (sin oráculo de existencia). */
  private async owned(userId: string, id: string): Promise<ApprovalRow> {
    const row = await this.deps.repository.find(id);
    if (!row || row.user_id !== userId) throw notFound();
    return row;
  }

  /** La misma decisión con la misma clave es idempotente; cualquier otra cosa falla con su código. */
  private async replay(row: ApprovalRow, key: string, same: readonly ApprovalRow['status'][]): Promise<ApprovalV1> {
    if (row.status === 'pending' && row.expires_at <= this.now()) {
      await this.deps.repository.markExpired(row.id);
      throw approvalExpired();
    }
    if (row.status === 'expired') throw approvalExpired();
    if (row.status === 'stale') throw approvalStale();
    if (row.decision_key === key && same.includes(row.status)) return toApprovalV1(row);
    throw approvalAlreadyDecided();
  }
}
