import {Pool, type PoolConfig} from 'pg';

/**
 * Acceso a Postgres (`assistant_db`, schema `assistant`) por el sidecar
 * cloud-sql-proxy. El schema lo crea Flyway (migrations/); el servicio nunca
 * ejecuta DDL. Los repositorios de las tareas siguientes reciben esta clase.
 */
export class Database {
  constructor(readonly pool: Pick<Pool, 'query' | 'end'>) {}

  static connect(connectionString: string, max: number): Database {
    const config: PoolConfig = {
      connectionString, max,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
      query_timeout: 12000,
      application_name: 'sa-assistant-service',
      options: '-c search_path=assistant',
    };
    const pool = new Pool(config);
    // pg emite errores de clientes inactivos desconectados. Nunca se registra la cadena de conexión.
    pool.on('error', () => process.stderr.write('ASSISTANT_DATABASE_UNAVAILABLE\n'));
    return new Database(pool);
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
