import type {AssistantRow} from '../persistence/assistant-repository';
import type {Database} from '../persistence/database';

type Status = AssistantRow['status'];
type Step = AssistantRow['step'];

/** Fila tras una transición, con el estado previo para poder deshacerla. */
export interface Transition { row: AssistantRow; previousStatus: Status; previousStep: Step }

const toBuffer = (value: unknown): Buffer | null =>
  value == null ? null : Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);

function normalize(row: Record<string, unknown>): AssistantRow {
  const rest = {...row};
  delete rest.previous_status;
  delete rest.previous_step;
  return {...rest, api_server_key_enc: toBuffer(rest.api_server_key_enc), attempts: Number(rest.attempts)} as AssistantRow;
}

/**
 * Transiciones del ciclo de vida (OCB-012) sobre `assistant.assistants`. Como
 * en `AssistantRepository`, cada una es UNA sentencia condicional: la carrera
 * entre clics la resuelve Postgres. Vive aparte para no tocar el repositorio
 * que comparten OCB-007/008/009/010.
 */
export class LifecycleStore {
  constructor(private readonly database: Database) {}

  private async query(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
    return (await this.database.pool.query(sql, params)).rows as Record<string, unknown>[];
  }

  private async transition(sql: string, params: unknown[]): Promise<Transition | null> {
    const [row] = await this.query(sql, params);
    return row ? {
      row: normalize(row),
      previousStatus: row.previous_status as Status,
      previousStep: (row.previous_step ?? null) as Step,
    } : null;
  }

  /**
   * Desactivar: solo con VM y Hermes ya instalado (ready, o activating en
   * installing_agent/configure_ai). La IP se olvida: al encender se relee.
   */
  markStopped(userId: string, now: Date): Promise<Transition | null> {
    return this.transition(`
      UPDATE assistant.assistants a SET status = 'stopped', step = NULL, private_ip = NULL, updated_at = $2
      FROM (SELECT user_id, status AS previous_status, step AS previous_step FROM assistant.assistants
            WHERE user_id = $1 AND deleted_at IS NULL FOR UPDATE) p
      WHERE a.user_id = p.user_id AND a.instance_name IS NOT NULL
        AND (a.status = 'ready' OR (a.status = 'activating' AND a.step IN ('installing_agent', 'configure_ai')))
      RETURNING a.*, p.previous_status, p.previous_step`, [userId, now]);
  }

  /** Deshace el stop si la operación de GCP falló (solo si nadie movió la fila). */
  async revertStop(userId: string, status: Status, step: Step, now: Date): Promise<void> {
    await this.query(`
      UPDATE assistant.assistants SET status = $2, step = $3, updated_at = $4
      WHERE user_id = $1 AND deleted_at IS NULL AND status = 'stopped'`, [userId, status, step, now]);
  }

  /**
   * Reactivar: stopped → activating/preparing_environment. El reloj de
   * preparación (slow a los 5 min) arranca de nuevo; ready_since, la IA y la
   * sesión se conservan. OCB-008 sigue con installing_agent → … y fija ready.
   */
  markStarting(userId: string, now: Date): Promise<Transition | null> {
    return this.transition(`
      UPDATE assistant.assistants a
      SET status = 'activating', step = 'preparing_environment', private_ip = NULL, activation_started_at = $2, updated_at = $2
      FROM (SELECT user_id, status AS previous_status, step AS previous_step FROM assistant.assistants
            WHERE user_id = $1 AND deleted_at IS NULL FOR UPDATE) p
      WHERE a.user_id = p.user_id AND a.status = 'stopped' AND a.instance_name IS NOT NULL
      RETURNING a.*, p.previous_status, p.previous_step`, [userId, now]);
  }

  /** El start falló en GCP: vuelve a stopped para que el dueño pueda reintentar. */
  async revertStart(userId: string, now: Date): Promise<void> {
    await this.query(`
      UPDATE assistant.assistants SET status = 'stopped', step = NULL, updated_at = $2
      WHERE user_id = $1 AND deleted_at IS NULL AND status = 'activating' AND step = 'preparing_environment'`, [userId, now]);
  }

  /** IP privada releída tras el start (instances.get networkInterfaces[0].networkIP). */
  async savePrivateIp(userId: string, ip: string, now: Date): Promise<void> {
    await this.query(`
      UPDATE assistant.assistants SET private_ip = $2, updated_at = $3
      WHERE user_id = $1 AND deleted_at IS NULL AND status = 'activating'`, [userId, ip, now]);
  }

  /** Borrar: cualquier estado vivo pasa a deleting (idempotente si ya lo estaba). */
  markDeleting(userId: string, now: Date): Promise<Transition | null> {
    return this.transition(`
      UPDATE assistant.assistants a SET status = 'deleting', step = NULL, updated_at = $2
      FROM (SELECT user_id, status AS previous_status, step AS previous_step FROM assistant.assistants
            WHERE user_id = $1 AND deleted_at IS NULL FOR UPDATE) p
      WHERE a.user_id = p.user_id
      RETURNING a.*, p.previous_status, p.previous_step`, [userId, now]);
  }

  /** El archivo o el borrado de la VM fallaron: status=failed, la VM y la fila se conservan. */
  async markDeleteFailed(userId: string, now: Date): Promise<void> {
    await this.query(`
      UPDATE assistant.assistants SET status = 'failed', updated_at = $2
      WHERE user_id = $1 AND deleted_at IS NULL AND status = 'deleting'`, [userId, now]);
  }

  /** Borra la credencial del asistente y sus flujos OAuth pendientes. */
  async deleteCredentials(userId: string): Promise<void> {
    await this.query('DELETE FROM assistant.assistant_credentials WHERE user_id = $1', [userId]);
    await this.query('DELETE FROM assistant.oauth_flows WHERE user_id = $1', [userId]);
  }

  /** Cierre del borrado: deleted_at y sin secretos en la fila. GET /me → status=none. */
  async finalizeDeletion(userId: string, now: Date): Promise<boolean> {
    const rows = await this.query(`
      UPDATE assistant.assistants SET deleted_at = $2, api_server_key_enc = NULL, private_ip = NULL, updated_at = $2
      WHERE user_id = $1 AND deleted_at IS NULL AND status = 'deleting'
      RETURNING user_id`, [userId, now]);
    return rows.length > 0;
  }

  /** Borrados que quedaron a medias (p. ej. el pod se reinició): se reanudan al arrancar. */
  async pendingDeletions(): Promise<string[]> {
    const rows = await this.query(
      "SELECT user_id FROM assistant.assistants WHERE status = 'deleting' AND deleted_at IS NULL ORDER BY updated_at", []);
    return rows.map(row => String(row.user_id));
  }
}
