import {Controller, Get, Header} from '@nestjs/common';
import {serviceUnavailable} from '../domain/errors';
import {Database} from '../persistence/database';

/** Salud sin autenticación (probes del kubelet, puerto 8060). */
@Controller()
export class HealthController {
  constructor(private readonly database: Database) {}

  /** Liveness: el proceso responde. No toca dependencias. */
  @Get('healthz')
  @Header('Cache-Control', 'no-store')
  live(): {status: 'ok'} {
    return {status: 'ok'};
  }

  /** Readiness: `SELECT 1` contra la base. */
  @Get('readyz')
  @Header('Cache-Control', 'no-store')
  async ready(): Promise<{status: 'ok'}> {
    try {
      await this.database.ping();
    } catch {
      throw serviceUnavailable();
    }
    return {status: 'ok'};
  }
}
