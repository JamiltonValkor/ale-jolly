import {hermesConfig, modelOfRow, type McpConfig, type ModelConfig} from '../activation/hermes-files';
import {ComputeError} from '../compute/compute-client';
import type {InstanceApi} from '../compute/instance-client';
import {withMetadataValues} from '../compute/metadata';
import type {AssistantRow} from '../persistence/assistant-repository';
import {isManagedMetaUser, MIN_META_WATCHER_VERSION, type ManagedMetaScope} from '../ai/meta-model';

export type ConfigWriteResult = 'applied' | 'unchanged' | 'deferred';

const STOPPED = new Set(['TERMINATED', 'STOPPED']);

/**
 * Escribe `hermes-config` en la metadata de la VM a partir de la fila (OCB-016):
 * MCP + modelo de la fila (o el que se está configurando) + zona de la fila.
 * `instances.get` → fusiona solo `hermes-config` sobre TODA la metadata →
 * `setMetadata` con el fingerprint (un 412 relee y reintenta una vez). El
 * watcher fusiona config.yaml y reinicia el contenedor. No espera el ack.
 */
export class HermesConfigWriter {
  constructor(private readonly mcp: McpConfig, private readonly instances: InstanceApi,
    private readonly requiredModel?: ModelConfig & Pick<ManagedMetaScope, 'userId' | 'allUsers'>) {}

  build(row: Pick<AssistantRow, 'ai_provider' | 'ai_model' | 'timezone'> & {user_id?: string}, model?: ModelConfig): string {
    const required = this.manages(row.user_id) ? this.requiredModel : undefined;
    return hermesConfig({mcp: this.mcp, model: required ?? model ?? modelOfRow(row), timezone: row.timezone, userId: row.user_id});
  }

  /**
   * `deferred`: sin VM, o VM que no está RUNNING (con `whenStopped`, también
   * apagada): la fila ya guarda el valor y se aplica en el próximo start o config.
   */
  async apply(row: AssistantRow, options: {whenStopped?: boolean} = {}): Promise<ConfigWriteResult> {
    const name = row.instance_name;
    if (!name) return 'deferred';
    if (this.manages(row.user_id)) {
      const watcher = await this.instances.guestAttribute(name, 'hermes/watcher-version');
      if (!watcher || !/^\d+$/.test(watcher) || Number(watcher) < MIN_META_WATCHER_VERSION) return 'deferred';
    }
    const config = this.build(row);
    for (let attempt = 1; ; attempt++) {
      const view = await this.instances.getInstance(name);
      if (!view) return 'deferred';
      if (view.status !== 'RUNNING' && !(options.whenStopped && STOPPED.has(view.status))) return 'deferred';
      if (view.items.find(item => item.key === 'hermes-config')?.value === config) return 'unchanged';
      try {
        await this.instances.setMetadata(name, view.fingerprint, withMetadataValues(view.items, {'hermes-config': config}));
        return 'applied';
      } catch (error) {
        if (error instanceof ComputeError && error.status === 412 && attempt === 1) continue;
        throw error;
      }
    }
  }

  private manages(userId: string | undefined): boolean {
    return !!this.requiredModel && isManagedMetaUser({...this.requiredModel, enabled: true}, userId);
  }
}
