import type {Database} from '../persistence/database';

/**
 * Escrituras de la IA (OCB-010). La base guarda solo proveedor, modelo y si la
 * prueba pasó: la key vive únicamente en la VM (metadata `hermes-env` y `.env`).
 */
export class AiRepository {
  constructor(private readonly database: Database) {}

  /** Prueba ok: ai_configured=true, status=ready y hito de `ready_since`. */
  async markConfigured(userId: string, provider: string, model: string, now: Date): Promise<boolean> {
    const result = await this.database.pool.query(`
      UPDATE assistant.assistants SET
        ai_provider = $2, ai_model = $3, ai_configured = true, status = 'ready', step = NULL,
        ready_since = $4, updated_at = $4
      WHERE user_id = $1 AND deleted_at IS NULL AND status IN ('activating', 'ready')
      RETURNING user_id`, [userId, provider, model, now]);
    return result.rows.length > 0;
  }

  /**
   * La prueba falló DESPUÉS de entregar la key nueva a la VM: la anterior ya se
   * descartó, así que el estado honesto es «Configura tu IA» sin IA configurada.
   * `ready_since` no se toca (no es un hito).
   */
  async markNeedsAi(userId: string, now: Date): Promise<void> {
    await this.database.pool.query(`
      UPDATE assistant.assistants SET
        ai_provider = NULL, ai_model = NULL, ai_configured = false, status = 'activating', step = 'configure_ai',
        updated_at = $2
      WHERE user_id = $1 AND deleted_at IS NULL AND status IN ('activating', 'ready')`, [userId, now]);
  }
}
