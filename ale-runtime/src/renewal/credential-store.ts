import type {CauseCode} from '../persistence/assistant-repository';
import type {Database} from '../persistence/database';

/**
 * Eventos que definen el estado de la credencial del asistente. El estado se
 * deriva del ÚLTIMO de ellos (assistant_events es append-only), así no hace
 * falta una migración nueva ni una columna extra:
 *
 * - `oauth.completed` (OCB-007), `credential.renewed`, `credential.recovered`:
 *   credencial sana.
 * - `credential_renewal_failed` + cause `login_required`: el refresh guardado ya
 *   no sirve; hace falta un salto SSO silencioso la próxima vez que el dueño
 *   abra «Mi asistente».
 * - `credential.reseed_requested` (o cualquier evento con cause
 *   `mcp_unavailable`) y `credential_renewal_failed` con `refresh_failed` o
 *   `config_apply_failed`: hay que reintentar la resiembra.
 */
export const CREDENTIAL_EVENT_KINDS = [
  'oauth.completed',
  'credential.renewed',
  'credential.recovered',
  'credential.reseed_requested',
  'credential_renewal_failed',
  'credential.revoked',
] as const;

export interface CredentialEvent { kind: string; cause: CauseCode | null }

export type CredentialHealth = 'healthy' | 'needs_sso' | 'retry';

export function credentialHealth(event: CredentialEvent | null): CredentialHealth {
  if (!event) return 'healthy';
  if (event.kind === 'credential_renewal_failed' && event.cause === 'login_required') return 'needs_sso';
  if (event.kind === 'credential.reseed_requested' || event.cause === 'mcp_unavailable') return 'retry';
  if (event.kind === 'credential_renewal_failed') return 'retry';
  return 'healthy';
}

const KINDS_SQL = CREDENTIAL_EVENT_KINDS.map(kind => `'${kind}'`).join(', ');
const LAST_EVENT_SQL = `
  SELECT e.kind, e.cause_code FROM assistant.assistant_events e
  WHERE e.user_id = %USER% AND (e.kind IN (${KINDS_SQL}) OR e.cause_code = 'mcp_unavailable')
  ORDER BY e.id DESC LIMIT 1`;

/**
 * SQL propio de la renovación (OCB-009). Vive aparte del repositorio de
 * OCB-007 para no tocar archivos compartidos; usa el mismo `Database`.
 */
export class CredentialStore {
  constructor(private readonly database: Database) {}

  private async query(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
    return (await this.database.pool.query(sql, params)).rows as Record<string, unknown>[];
  }

  async lastCredentialEvent(userId: string): Promise<CredentialEvent | null> {
    const [row] = await this.query(LAST_EVENT_SQL.replace('%USER%', '$1'), [userId]);
    return row ? {kind: String(row.kind), cause: (row.cause_code ?? null) as CauseCode | null} : null;
  }

  /**
   * Asistentes con VM cuya credencial guardada tiene más de `cutoff` de edad,
   * los más viejos primero. Excluye borrados, `deleting`, `failed` (la VM puede
   * no existir) y los que esperan el SSO silencioso (refrescar volvería a dar
   * invalid_grant).
   */
  async dueForRenewal(cutoff: Date, limit: number): Promise<string[]> {
    const rows = await this.query(`
      SELECT a.user_id FROM assistant.assistants a
      JOIN assistant.assistant_credentials c ON c.user_id = a.user_id
      WHERE a.deleted_at IS NULL AND a.status IN ('activating', 'ready', 'stopped')
        AND a.instance_name IS NOT NULL AND c.obtained_at <= $1
        AND NOT EXISTS (
          SELECT 1 FROM (${LAST_EVENT_SQL.replace('%USER%', 'a.user_id')}) last
          WHERE last.kind = 'credential_renewal_failed' AND last.cause_code = 'login_required')
      ORDER BY c.obtained_at ASC
      LIMIT $2`, [cutoff, limit]);
    return rows.map(row => String(row.user_id));
  }

  /** Guarda la credencial nueva (refresh cifrado), exista o no la fila. */
  async upsertCredential(userId: string, refreshEnc: Buffer, accessExpiresAt: Date, now: Date): Promise<void> {
    await this.query(`
      INSERT INTO assistant.assistant_credentials (user_id, refresh_token_enc, access_expires_at, obtained_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id) DO UPDATE SET
        refresh_token_enc = EXCLUDED.refresh_token_enc, access_expires_at = EXCLUDED.access_expires_at, obtained_at = EXCLUDED.obtained_at`,
    [userId, refreshEnc, accessExpiresAt, now]);
  }

  async deleteCredential(userId: string): Promise<void> {
    await this.query('DELETE FROM assistant.assistant_credentials WHERE user_id = $1', [userId]);
  }
}
