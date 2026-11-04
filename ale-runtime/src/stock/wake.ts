import {scopedJobName} from '../notifications/jobs';
import type {NativeManagedJobsClient} from '../notifications/native-jobs';
import type {AssistantRepository} from '../persistence/assistant-repository';
import type {InstanceApi} from '../compute/instance-client';
import type {FieldCipher} from '../security/field-cipher';
import {STOCK_LIMITS} from './config';
import type {WakeResult} from './device-ops';
import type {StockQuery} from './store';
import type {StockUsage} from './usage';

/**
 * S-19: el SOUL no se cumple en un tick, así que el trabajo que se despierta es `saleads:stock-tick`, cuyo prompt lleva
 * la orden. Cada despertar es un turno pagado, y en Hermes `trigger_job` borra la pausa del dueño: por eso se lee antes.
 */
export const STOCK_TICK_JOB = 'saleads:stock-tick';
const TIMEOUT_MS = 10_000;

export type WakeReason = 'pedido_aprobado' | 'respuesta_proveedor' | 'banco';
export interface WakeVm {
  jobs: Pick<NativeManagedJobsClient, 'list' | 'run'>;
  repository: Pick<AssistantRepository, 'findActive'>;
  instances: Pick<InstanceApi, 'getInstance'>;
  cipher: Pick<FieldCipher, 'open'>;
}
export interface WakeDeps {db: StockQuery; now: () => Date; vm?: WakeVm | undefined; usage: Pick<StockUsage, 'spend' | 'exhausted'>}

export class StockWake {
  private readonly recent = new Map<string, number>();

  constructor(private readonly deps: WakeDeps) {}

  /** Nunca lanza: quien aprobó ya terminó bien, y un fallo aquí solo deja el trabajo para el tick normal. */
  async wake(userId: string, businessId: string, _reason: WakeReason): Promise<WakeResult> {
    try {
      return await this.attempt(userId, businessId);
    } catch {
      return 'no_disponible';
    }
  }

  private async attempt(userId: string, businessId: string): Promise<WakeResult> {
    const {vm} = this.deps;
    const {db, usage} = this.deps;
    if (await usage.exhausted(db, businessId, 'despertares_ale') || await usage.exhausted(db, businessId, 'tokens_ale')) return 'tope';
    const at = this.deps.now().getTime();
    const last = this.recent.get(businessId);
    if (last !== undefined && at - last < STOCK_LIMITS.wakeDebounceSeconds * 1000) return 'antirrebote';
    // Sin espera entre leer y marcar: diez solicitudes juntas dejan pasar una.
    this.recent.set(businessId, at);
    const result = vm ? await this.run(vm, userId, businessId) : 'no_disponible';
    if (result !== 'solicitado') this.recent.delete(businessId);
    return result;
  }

  private async run(vm: WakeVm, userId: string, businessId: string): Promise<WakeResult> {
    const row = await vm.repository.findActive(userId);
    if (row?.status !== 'ready' || !row.instance_name || !row.api_server_key_enc) return 'vm_no_lista';
    const view = await vm.instances.getInstance(row.instance_name);
    if (view?.status !== 'RUNNING' || !view.privateIp) return 'vm_no_lista';
    const target = {ip: view.privateIp, apiServerKey: vm.cipher.open('assistants.api_server_key_enc', userId, row.api_server_key_enc)};
    const listed = await vm.jobs.list(target, TIMEOUT_MS);
    if (listed.kind !== 'ok') return 'no_disponible';
    const job = listed.jobs.find(item => item.name === scopedJobName(STOCK_TICK_JOB, businessId));
    if (!job || job.enabled !== true || job.paused_reason !== null) return 'sin_job';
    if (!await this.deps.usage.spend(this.deps.db, businessId, 'despertares_ale')) return 'tope';
    const outcome = await vm.jobs.run(target, job.id, TIMEOUT_MS);
    return outcome.kind === 'updated' ? 'solicitado' : 'no_disponible';
  }
}
