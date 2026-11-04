import type {Database} from '../persistence/database';

/** Escrituras del chat (OCB-011): solo el id de la sesión única del usuario, nunca mensajes. */
export class ChatRepository {
  constructor(private readonly database: Database) {}

  /** Guarda el session_id si aún no hay uno (el primero gana; un borrado lo vuelve a NULL). */
  async saveSessionId(userId: string, sessionId: string): Promise<void> {
    await this.database.pool.query(`
      UPDATE assistant.assistants SET session_id = $2, updated_at = now()
      WHERE user_id = $1 AND deleted_at IS NULL AND session_id IS NULL`, [userId, sessionId]);
  }
}
