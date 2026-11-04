import type {Database} from './database';

/** Fila de assistant.assistants (los *_enc vienen como bytea → Buffer). */
export interface AssistantRow {
  user_id: string;
  status: 'activating' | 'ready' | 'stopped' | 'failed' | 'deleting';
  step: 'preparing_access' | 'preparing_environment' | 'installing_agent' | 'configure_ai' | null;
  instance_name: string | null;
  zone: string | null;
  private_ip: string | null;
  api_server_key_enc: Buffer | null;
  bundle_version: string | null;
  ai_provider: string | null;
  ai_model: string | null;
  ai_configured: boolean;
  session_id: string | null;
  activation_started_at: Date | null;
  ready_since: Date | null;
  attempts: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  /** IANA del navegador del dueño (V2, OCB-016); null = fallback America/Bogota. */
  timezone: string | null;
}

export interface OAuthFlowRow { user_id: string; verifier_enc: Buffer; expires_at: Date }

/** Valores de assistant_events.cause_code (CHECK de V1). */
export type CauseCode =
  | 'oauth_failed' | 'login_required' | 'vm_create_failed' | 'vm_start_failed' | 'vm_stop_failed'
  | 'vm_delete_failed' | 'readiness_timeout' | 'config_apply_failed' | 'ai_test_failed'
  | 'mcp_unavailable' | 'refresh_failed' | 'revoke_failed' | 'archive_failed' | 'unknown';

/** Evento append-only. `detail_safe` solo lleva códigos y contadores, nunca valores. */
export interface AssistantEvent {
  userId: string;
  kind: string;
  phase?: string | null;
  cause?: CauseCode | null;
  detail?: string | null;
}

const toBuffer = (value: unknown): Buffer | null =>
  value == null ? null : Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);

function normalize(row: Record<string, unknown>): AssistantRow {
  return {
    ...row, api_server_key_enc: toBuffer(row.api_server_key_enc), attempts: Number(row.attempts),
    timezone: typeof row.timezone === 'string' ? row.timezone : null,
  } as AssistantRow;
}

/**
 * Acceso a las tablas del schema `assistant`. Cada operación es UNA sentencia
 * atómica (UPSERT, UPDATE condicional, DELETE … RETURNING o CTE), así la
 * concurrencia de clics y callbacks la resuelve Postgres sin leases ni locks.
 */
export class AssistantRepository {
  constructor(private readonly database: Database) {}

  private async query(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
    const result = await this.database.pool.query(sql, params);
    return result.rows as Record<string, unknown>[];
  }

  async findActive(userId: string): Promise<AssistantRow | null> {
    const [row] = await this.query('SELECT * FROM assistant.assistants WHERE user_id = $1 AND deleted_at IS NULL', [userId]);
    return row ? normalize(row) : null;
  }

  /**
   * Crea la fila del asistente, o la reinicia si estaba borrada (OCB-012).
   * Devuelve `started=false` y la fila vigente si ya existía un asistente.
   */
  async startActivation(userId: string, now: Date): Promise<{row: AssistantRow; started: boolean}> {
    const [created] = await this.query(`
      INSERT INTO assistant.assistants AS a (user_id, status, step, activation_started_at, attempts, created_at, updated_at)
      VALUES ($1, 'activating', 'preparing_access', $2, 0, $2, $2)
      ON CONFLICT (user_id) DO UPDATE SET
        status = 'activating', step = 'preparing_access', instance_name = NULL, zone = NULL, private_ip = NULL,
        api_server_key_enc = NULL, bundle_version = NULL, ai_provider = NULL, ai_model = NULL, ai_configured = false,
        session_id = NULL, activation_started_at = $2, ready_since = NULL, attempts = 0,
        created_at = $2, updated_at = $2, deleted_at = NULL, timezone = NULL
      WHERE a.deleted_at IS NOT NULL
      RETURNING *`, [userId, now]);
    if (created) return {row: normalize(created), started: true};
    const existing = await this.findActive(userId);
    if (!existing) throw new Error('ASSISTANT_ROW_RACE');
    return {row: existing, started: false};
  }

  /**
   * Zona enviada al activar (OCB-016): solo si aún no hay una guardada o la VM
   * todavía no existe (después, la cambia `PUT /timezone`). Devuelve la fila.
   */
  async setActivationTimezone(userId: string, timezone: string, now: Date): Promise<AssistantRow | null> {
    const [row] = await this.query(`
      UPDATE assistant.assistants SET timezone = $2, updated_at = $3
      WHERE user_id = $1 AND deleted_at IS NULL AND (timezone IS NULL OR instance_name IS NULL)
      RETURNING *`, [userId, timezone, now]);
    return row ? normalize(row) : null;
  }

  /** `PUT /timezone` (OCB-016): guarda la zona de un asistente vigente y devuelve la fila. */
  async saveTimezone(userId: string, timezone: string, now: Date): Promise<AssistantRow | null> {
    const [row] = await this.query(`
      UPDATE assistant.assistants SET timezone = $2, updated_at = $3
      WHERE user_id = $1 AND deleted_at IS NULL AND status <> 'deleting'
      RETURNING *`, [userId, timezone, now]);
    return row ? normalize(row) : null;
  }

  /** Guarda (o renueva el TTL de) un flujo. Un state ajeno nunca se reasigna. */
  async saveFlow(stateHash: string, userId: string, verifierEnc: Buffer, expiresAt: Date): Promise<void> {
    await this.query(`
      INSERT INTO assistant.oauth_flows AS f (state_hash, user_id, verifier_enc, expires_at) VALUES ($1, $2, $3, $4)
      ON CONFLICT (state_hash) DO UPDATE SET expires_at = EXCLUDED.expires_at WHERE f.user_id = EXCLUDED.user_id`,
    [stateHash, userId, verifierEnc, expiresAt]);
  }

  async deleteExpiredFlows(userId: string, now: Date): Promise<void> {
    await this.query('DELETE FROM assistant.oauth_flows WHERE user_id = $1 AND expires_at <= $2', [userId, now]);
  }

  /** Consume el flujo SOLO si es de este usuario (un tercero no puede quemar el state de otro). */
  async consumeFlow(stateHash: string, userId: string): Promise<OAuthFlowRow | null> {
    const [row] = await this.query(
      'DELETE FROM assistant.oauth_flows WHERE state_hash = $1 AND user_id = $2 RETURNING user_id, verifier_enc, expires_at',
      [stateHash, userId]);
    return row ? {user_id: String(row.user_id), verifier_enc: toBuffer(row.verifier_enc)!, expires_at: row.expires_at as Date} : null;
  }

  async flowExists(stateHash: string): Promise<boolean> {
    return (await this.query('SELECT 1 FROM assistant.oauth_flows WHERE state_hash = $1', [stateHash])).length > 0;
  }

  /**
   * Pasa de preparing_access a preparing_environment y guarda el refresh cifrado,
   * en una sola sentencia. Solo si el asistente sigue activándose y aún no tiene
   * VM: un callback tardío nunca pisa la credencial de una VM existente.
   */
  async grantAccess(userId: string, refreshEnc: Buffer, accessExpiresAt: Date, now: Date): Promise<boolean> {
    const rows = await this.query(`
      WITH a AS (
        UPDATE assistant.assistants SET step = 'preparing_environment', updated_at = $4
        WHERE user_id = $1 AND deleted_at IS NULL AND status = 'activating' AND step = 'preparing_access' AND instance_name IS NULL
        RETURNING user_id
      )
      INSERT INTO assistant.assistant_credentials (user_id, refresh_token_enc, access_expires_at, obtained_at)
      SELECT user_id, $2, $3, $4 FROM a
      ON CONFLICT (user_id) DO UPDATE SET
        refresh_token_enc = EXCLUDED.refresh_token_enc, access_expires_at = EXCLUDED.access_expires_at, obtained_at = EXCLUDED.obtained_at
      RETURNING user_id`, [userId, refreshEnc, accessExpiresAt, now]);
    return rows.length > 0;
  }

  async readRefreshToken(userId: string): Promise<Buffer | null> {
    const [row] = await this.query('SELECT refresh_token_enc FROM assistant.assistant_credentials WHERE user_id = $1', [userId]);
    return row ? toBuffer(row.refresh_token_enc) : null;
  }

  async updateCredential(userId: string, refreshEnc: Buffer, accessExpiresAt: Date, now: Date): Promise<void> {
    await this.query(`
      UPDATE assistant.assistant_credentials SET refresh_token_enc = $2, access_expires_at = $3, obtained_at = $4
      WHERE user_id = $1`, [userId, refreshEnc, accessExpiresAt, now]);
  }

  /**
   * Reclama la creación de la VM: fija nombre, zona, API_SERVER_KEY cifrada y
   * versión del bundle si todavía no hay instancia. Solo un llamador gana; los
   * demás reciben false y no llaman a instances.insert.
   */
  async claimProvisioning(input: {
    userId: string; instanceName: string; zone: string; apiServerKeyEnc: Buffer; bundleVersion: string; now: Date;
  }): Promise<boolean> {
    const rows = await this.query(`
      UPDATE assistant.assistants
      SET instance_name = $2, zone = $3, api_server_key_enc = $4, bundle_version = $5, updated_at = $6
      WHERE user_id = $1 AND deleted_at IS NULL AND status = 'activating' AND step = 'preparing_environment' AND instance_name IS NULL
      RETURNING user_id`, [input.userId, input.instanceName, input.zone, input.apiServerKeyEnc, input.bundleVersion, input.now]);
    return rows.length > 0;
  }

  /** Cuenta un intento de instances.insert y devuelve su número (1, 2…). */
  async recordAttempt(userId: string, now: Date): Promise<number> {
    const [row] = await this.query(`
      UPDATE assistant.assistants SET attempts = attempts + 1, updated_at = $2
      WHERE user_id = $1 AND deleted_at IS NULL RETURNING attempts`, [userId, now]);
    if (!row) throw new Error('ASSISTANT_ROW_MISSING');
    return Number(row.attempts);
  }

  /** status=failed sin borrar nada (ni la fila, ni la credencial, ni la VM). */
  async markFailed(userId: string, now: Date): Promise<void> {
    await this.query(`
      UPDATE assistant.assistants SET status = 'failed', updated_at = $2
      WHERE user_id = $1 AND deleted_at IS NULL AND status = 'activating'`, [userId, now]);
  }

  /**
   * MCB-003 (D24): versiones del bundle con las que ESTA VM quedó sincronizada (`orqa.synced`, que solo se emite
   * con todos los trabajos del bundle presentes). Cuenta desde que existe la fila (`created_at`, que se reinicia al
   * reactivar) y desde la última creación de VM, así una VM nueva nunca hereda la historia de la anterior.
   */
  async syncedBundleVersions(userId: string, since: Date): Promise<string[]> {
    const rows = await this.query(`
      SELECT DISTINCT substring(e.detail_safe FROM '^bundle=([^ ]+)') AS version
      FROM assistant.assistant_events e
      WHERE e.user_id = $1 AND e.kind = 'orqa.synced' AND e.at >= $2
        AND e.at > COALESCE((SELECT max(c.at) FROM assistant.assistant_events c
                             WHERE c.user_id = $1 AND c.kind = 'vm.create_requested'), '-infinity'::timestamptz)`,
    [userId, since]);
    return rows.map(row => row.version).filter((version): version is string => typeof version === 'string' && version.length > 0).sort();
  }

  /** MCB-020: asistentes listos para el barrido de sincronización (solo lectura). */
  async listReady(): Promise<Array<{user_id: string; instance_name: string; ready_since: Date | null}>> {
    const rows = await this.query(`
      SELECT user_id, instance_name, ready_since FROM assistant.assistants
      WHERE status = 'ready' AND deleted_at IS NULL AND instance_name IS NOT NULL
      ORDER BY user_id`, []);
    return rows.map(row => ({
      user_id: row.user_id as string, instance_name: row.instance_name as string,
      ready_since: row.ready_since instanceof Date ? row.ready_since : row.ready_since ? new Date(row.ready_since as string) : null,
    }));
  }

  async appendEvent(event: AssistantEvent): Promise<void> {
    await this.query(
      'INSERT INTO assistant.assistant_events (user_id, kind, phase, cause_code, detail_safe) VALUES ($1, $2, $3, $4, $5)',
      [event.userId, event.kind, event.phase ?? null, event.cause ?? null, event.detail ?? null]);
  }
}
