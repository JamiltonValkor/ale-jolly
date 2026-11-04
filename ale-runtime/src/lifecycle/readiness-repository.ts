import type {Database} from '../persistence/database';
import type {Transition} from './readiness';

/**
 * Escrituras de la readiness (OCB-008) sobre assistant.assistants. Cada una es
 * UNA sentencia con compare-and-set sobre (status=activating, step observado):
 * si otra escritura (PUT /ai, stop, delete…) cambió la fila entre la lectura y
 * la observación, esta no pisa nada.
 */
export class ReadinessRepository {
  constructor(private readonly database: Database) {}

  /**
   * `ready_since` se mueve en cada hito (lo exige el indicador del front, OCF-001):
   * al llegar a ready siempre; al llegar a configure_ai si aún no tiene hito en
   * esta activación (NULL o anterior a `activation_started_at`).
   */
  async apply(userId: string, observedStep: string | null, transition: Transition, now: Date): Promise<boolean> {
    const result = await this.database.pool.query(`
      UPDATE assistant.assistants SET
        status = $3,
        step = $4,
        private_ip = $5::inet,
        ready_since = CASE
          WHEN $6::text = 'ready' THEN $7
          WHEN $6::text = 'configure_ai' AND (ready_since IS NULL OR ready_since < activation_started_at) THEN $7
          ELSE ready_since END,
        updated_at = $7
      WHERE user_id = $1 AND deleted_at IS NULL AND status = 'activating' AND step IS NOT DISTINCT FROM $2
      RETURNING user_id`,
    [userId, observedStep, transition.status, transition.step, transition.privateIp, transition.milestone, now]);
    return result.rows.length > 0;
  }
}
