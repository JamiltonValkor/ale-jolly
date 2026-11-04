import {Logger} from '@nestjs/common';
import type {BusinessProfileV1, BusinessTypeV1} from '../contracts/v1';
import {notFound, serviceUnavailable} from '../domain/errors';
import type {McpToolClient} from '../orqa/mcp-client';
import {ownedBusinessIds} from '../orqa/seed';
import type {AssistantEvent} from '../persistence/assistant-repository';
import type {Database} from '../persistence/database';

export const BUSINESS_PROFILE_SERVICE = Symbol('BUSINESS_PROFILE_SERVICE');

export interface StoredBusinessProfile {
  business_type: BusinessTypeV1;
  source: 'bi' | 'owner';
  updated_at: Date;
}

/** `offering_type` de BI → tipo del equipo. `both`, vacío o desconocido = el dueño elige. */
export function typeFromOffering(offering: unknown): BusinessTypeV1 | null {
  if (offering === 'products') return 'physical_product';
  if (offering === 'services') return 'service';
  return null;
}

export class BusinessProfileStore {
  constructor(private readonly database: Database) {}

  async find(userId: string, businessId: string): Promise<StoredBusinessProfile | null> {
    const result = await this.database.pool.query(
      'SELECT business_type, source, updated_at FROM assistant.business_profiles WHERE user_id = $1 AND business_id = $2', [userId, businessId]);
    const row = result.rows[0] as {business_type: BusinessTypeV1; source: 'bi' | 'owner'; updated_at: string | Date} | undefined;
    return row ? {business_type: row.business_type, source: row.source, updated_at: new Date(row.updated_at)} : null;
  }

  /** Tipos confirmados en los negocios del dueño, sin repetir (MLB-003). */
  async typesOf(userId: string): Promise<BusinessTypeV1[]> {
    const result = await this.database.pool.query(
      'SELECT DISTINCT business_type FROM assistant.business_profiles WHERE user_id = $1 ORDER BY business_type', [userId]);
    return result.rows.map(row => (row as {business_type: BusinessTypeV1}).business_type);
  }

  /** Devuelve el tipo anterior (null si no había fila). */
  async upsert(userId: string, businessId: string, type: BusinessTypeV1, now: Date): Promise<BusinessTypeV1 | null> {
    const previous = await this.find(userId, businessId);
    await this.database.pool.query(
      `INSERT INTO assistant.business_profiles (user_id, business_id, business_type, source, updated_at) VALUES ($1, $2, $3, 'owner', $4)
       ON CONFLICT (user_id, business_id) DO UPDATE SET business_type = EXCLUDED.business_type, source = 'owner', updated_at = EXCLUDED.updated_at`,
      [userId, businessId, type, now]);
    return previous?.business_type ?? null;
  }
}

export interface BusinessProfileOptions {
  toolTimeoutMs: number;
}

export interface BusinessProfileDeps {
  store: BusinessProfileStore;
  mcp: McpToolClient;
  /** Token del dueño (renovación OCB-009); null = asistente sin activar o credencial vencida. */
  accessToken: (userId: string) => Promise<string | null>;
  repository: {appendEvent(event: AssistantEvent): Promise<void>};
  /** El tipo cambió: la sincronización del bundle del usuario queda vencida (MLB-003). */
  onTypeChanged?: (userId: string) => void;
  now?: () => Date;
}

/**
 * Tipo de negocio por negocio (MLB-002). La propiedad se verifica en cada
 * llamada con el MCP y el token del dueño: un negocio ajeno responde 404 y,
 * sin token o sin poder saber los negocios, 503 (nunca 200).
 */
export class BusinessProfileService {
  private readonly logger = new Logger('business-profile');
  private readonly now: () => Date;

  constructor(private readonly options: BusinessProfileOptions, private readonly deps: BusinessProfileDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async get(userId: string, businessId: string): Promise<BusinessProfileV1> {
    const token = await this.ownedToken(userId, businessId);
    const stored = await this.deps.store.find(userId, businessId);
    if (stored) return view(businessId, stored);
    const profile = await this.deps.mcp.call(token, 'saleads_get_business_profile', {business_id: businessId}, this.options.toolTimeoutMs);
    if (!profile.ok) this.logger.warn(`business profile prefill unavailable code=${profile.code}`);
    const type = profile.ok ? typeFromOffering(profile.data.offering_type) : null;
    return {business_id: businessId, business_type: type, needs_choice: type === null, source: type ? 'bi' : null, updated_at: null};
  }

  async update(userId: string, businessId: string, type: BusinessTypeV1): Promise<BusinessProfileV1> {
    await this.ownedToken(userId, businessId);
    const now = this.now();
    const previous = await this.deps.store.upsert(userId, businessId, type, now);
    if (previous !== type) {
      await this.deps.repository.appendEvent({userId, kind: 'business_profile.changed', phase: 'profile', detail: `from=${previous ?? 'none'} to=${type}`});
      this.deps.onTypeChanged?.(userId);
    }
    return view(businessId, {business_type: type, source: 'owner', updated_at: now});
  }

  /** AAB-012: misma comprobación de propiedad para otras rutas web por negocio (503 si no se sabe, 404 si es ajeno). */
  async assertOwned(userId: string, businessId: string): Promise<void> {
    await this.ownedToken(userId, businessId);
  }

  private async ownedToken(userId: string, businessId: string): Promise<string> {
    const token = await this.deps.accessToken(userId);
    if (!token) throw serviceUnavailable();
    const owned = await ownedBusinessIds(this.deps.mcp, token, this.options.toolTimeoutMs);
    if (!Array.isArray(owned)) throw serviceUnavailable();
    if (!owned.includes(businessId)) throw notFound();
    return token;
  }
}

const view = (businessId: string, stored: StoredBusinessProfile): BusinessProfileV1 => ({
  business_id: businessId, business_type: stored.business_type, needs_choice: false, source: stored.source,
  updated_at: stored.updated_at.toISOString(),
});
