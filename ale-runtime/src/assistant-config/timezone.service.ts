import {Logger} from '@nestjs/common';
import {ComputeError} from '../compute/compute-client';
import type {AssistantStateV1, TimezoneRequestV1} from '../contracts/v1';
import {invalidRequest, ServiceError} from '../domain/errors';
import type {AssistantRepository, AssistantRow} from '../persistence/assistant-repository';
import {toAssistantState} from '../state/assistant-state';
import type {ConfigWriteResult, HermesConfigWriter} from './hermes-config-writer';
import {canonicalTimezone} from './timezone';
import type {UserLocks} from './user-locks';

export const TIMEZONE_SERVICE = Symbol('TIMEZONE_SERVICE');

export interface TimezoneDeps {
  repository: AssistantRepository;
  writer: HermesConfigWriter;
  /** Los mismos de `PUT /ai`: no se pisan modelo y zona. */
  locks: UserLocks;
  onStateChanged?: (userId: string) => void;
  now?: () => Date;
}

/** Estados con una VM que puede recibir la config ahora. */
const LIVE = new Set<AssistantRow['status']>(['ready', 'activating']);

const detailOf = (error: unknown) => error instanceof ComputeError ? `status=${error.status} reason=${error.reason}` : 'reason=other';

/**
 * Zona horaria del dueño (OCB-016): `PUT /assistants/me/timezone` y la
 * sincronización previa al start.
 *
 * Guarda la zona canónica en la fila y reescribe `hermes-config` desde la fila
 * (modelo + zona) con setMetadata fusionado. Sin VM, o con la VM apagada, solo
 * se guarda: se aplica al crear la VM, en el próximo start o en el próximo
 * `PUT /ai`. Un fallo de Compute no rechaza el cambio (la zona ya está
 * guardada): queda en assistant_events y se reintenta en el próximo start o config.
 */
export class TimezoneService {
  private readonly logger = new Logger('timezone');
  private readonly now: () => Date;

  constructor(private readonly deps: TimezoneDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async update(userId: string, input: TimezoneRequestV1): Promise<AssistantStateV1> {
    const timezone = canonicalTimezone(input.timezone);
    if (!timezone) throw invalidRequest();
    return this.deps.locks.run(userId, async () => {
      const {repository} = this.deps;
      const row = await repository.saveTimezone(userId, timezone, this.now());
      if (!row) throw new ServiceError('NOT_FOUND', 404);
      let result: ConfigWriteResult | 'failed' = 'deferred';
      if (LIVE.has(row.status)) {
        try {
          result = await this.deps.writer.apply(row);
        } catch (error) {
          result = 'failed';
          await repository.appendEvent({userId, kind: 'timezone.apply_failed', phase: 'timezone', cause: 'config_apply_failed', detail: detailOf(error)});
          this.logger.warn(`timezone apply failed ${detailOf(error)}`);
        }
      }
      if (result !== 'failed') await repository.appendEvent({userId, kind: 'timezone.updated', phase: 'timezone', detail: `result=${result}`});
      this.deps.onStateChanged?.(userId);
      this.logger.log(`timezone updated result=${result}`);
      return toAssistantState(row, this.now());
    });
  }

  /**
   * Antes de `instances.start` (VM apagada): aplica la config de la fila si
   * cambió mientras estaba apagada. Nunca lanza; el llamador acota la espera.
   */
  async syncBeforeStart(userId: string): Promise<void> {
    try {
      await this.deps.locks.run(userId, async () => {
        const row = await this.deps.repository.findActive(userId);
        if (!row || row.status !== 'stopped') return;
        const result = await this.deps.writer.apply(row, {whenStopped: true});
        if (result === 'applied') await this.deps.repository.appendEvent({userId, kind: 'config.synced', phase: 'start', detail: 'result=applied'});
      });
    } catch (error) {
      await this.deps.repository.appendEvent({userId, kind: 'config.sync_failed', phase: 'start', cause: 'config_apply_failed', detail: detailOf(error)})
        .catch(() => undefined);
      this.logger.warn(`config sync before start failed ${detailOf(error)}`);
    }
  }
}
