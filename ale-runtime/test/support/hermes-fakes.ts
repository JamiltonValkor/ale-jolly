import {ComputeError} from '../../src/compute/compute-client';
import type {InstanceApi, InstanceStatus, InstanceView} from '../../src/compute/instance-client';
import {computeAppliedVersion, type MetadataItem} from '../../src/compute/metadata';
import type {HealthObservation, HermesApi, HermesTarget, ProbeOutcome} from '../../src/hermes/hermes-client';
import type {FieldCipher} from '../../src/security/field-cipher';
import type {Database} from '../../src/persistence/database';
import {TEMPLATE_ITEMS} from './fakes';

export const API_SERVER_KEY = 'apikey-SECRET-0123456789abcdef'; // gitleaks:allow -- synthetic test credential
export const INSTANCE = `sa-assistant-${'a'.repeat(32)}`;
export const VM_IP = '10.128.0.42';

/** Metadata de una VM ya creada: plantilla + hermes-* de OCB-007 (sin IA). */
export function createdVmItems(): MetadataItem[] {
  return [
    ...TEMPLATE_ITEMS.map(item => ({...item})),
    {key: 'hermes-api-key', value: API_SERVER_KEY},
    {key: 'hermes-bundle-version', value: 'saleads-sales-agent@1.1.0'},
    {key: 'hermes-config', value: 'mcp_servers:\n  saleads:\n    url: "https://dev.saleads.ai/mcp"\n'},
    {key: 'hermes-mcp-tokens', value: '{"tokens.json":{"access_token":"mcp-SECRET"}}'},
    {key: 'hermes-skills', value: '{"a/SKILL.md":"x"}'},
    {key: 'hermes-soul', value: '# SOUL\n'},
  ];
}

/**
 * Compute simulado para una instancia: guarda la metadata, cambia el
 * fingerprint en cada setMetadata y, como el watcher, publica el ack
 * `hermes/applied-version` después de `ackAfterPolls` lecturas.
 */
export class FakeInstances implements InstanceApi {
  view: InstanceView | null = {status: 'RUNNING', privateIp: VM_IP, fingerprint: 'fp-0', items: createdVmItems()};
  readonly sets: Array<{name: string; fingerprint: string; items: MetadataItem[]}> = [];
  getCalls = 0;
  /** null = el watcher nunca confirma. */
  ackAfterPolls: number | null = 1;
  /** Fuerza un 412 en el próximo setMetadata (otro escritor cambió la metadata). */
  conflictOnce = false;
  getDelay?: () => Promise<void>;
  private applied: string | null = null;
  private pendingAck: {version: string; polls: number} | null = null;
  private fingerprints = 0;

  constructor() {
    this.applied = computeAppliedVersion(this.view!.items);
  }

  setStatus(status: InstanceStatus): void {
    if (this.view) this.view.status = status;
  }

  async getInstance(name: string): Promise<InstanceView | null> {
    this.getCalls++;
    await this.getDelay?.();
    if (!this.view || name !== INSTANCE) return null;
    return {...this.view, items: this.view.items.map(item => ({...item}))};
  }

  async setMetadata(name: string, fingerprint: string, items: MetadataItem[]): Promise<void> {
    this.sets.push({name, fingerprint, items: items.map(item => ({...item}))});
    if (!this.view) throw new ComputeError(404, 'notFound');
    if (this.conflictOnce) {
      this.conflictOnce = false;
      this.view.fingerprint = `fp-${++this.fingerprints}`;
      throw new ComputeError(412, 'conditionNotMet');
    }
    if (fingerprint !== this.view.fingerprint) throw new ComputeError(412, 'conditionNotMet');
    this.view.items = items.map(item => ({...item}));
    this.view.fingerprint = `fp-${++this.fingerprints}`;
    if (this.ackAfterPolls !== null) this.pendingAck = {version: computeAppliedVersion(items), polls: this.ackAfterPolls};
  }

  async guestAttribute(name: string, key: string): Promise<string | null> {
    if (key !== 'hermes/applied-version' || name !== INSTANCE) return null;
    if (this.pendingAck) {
      if (this.pendingAck.polls <= 1) {this.applied = this.pendingAck.version; this.pendingAck = null;}
      else this.pendingAck.polls--;
    }
    return this.applied;
  }

  item(key: string): string | undefined {
    return this.view?.items.find(item => item.key === key)?.value;
  }
}

export const HEALTHY_CHECKS = {
  state_db: 'ok', session_store: 'ok', config: 'ok', model: 'ok', disk: 'ok', gateway: 'ok', background_queues: 'ok',
};
export const answered = (checks: Record<string, string>, platform = 'hermes-agent'): HealthObservation => ({
  kind: 'answered', platform, status: Object.values(checks).every(value => value === 'ok') ? 'ok' : 'degraded', checks,
});
export const NO_MODEL = answered({...HEALTHY_CHECKS, model: 'degraded'});
export const HEALTHY = answered(HEALTHY_CHECKS);

/** Hermes simulado: salud fija o guionada y turnos de prueba guionados. */
export class FakeHermes implements HermesApi {
  healthScript: Array<HealthObservation | (() => Promise<HealthObservation>)> = [];
  healthDefault: HealthObservation | (() => Promise<HealthObservation>) = NO_MODEL;
  probes: ProbeOutcome[] = [];
  readonly healthTargets: HermesTarget[] = [];
  readonly probeCalls: Array<{target: HermesTarget; message: string; timeoutMs: number}> = [];

  async health(target: HermesTarget): Promise<HealthObservation> {
    this.healthTargets.push(target);
    const next = this.healthScript.shift() ?? this.healthDefault;
    return typeof next === 'function' ? next() : next;
  }

  async probeTurn(target: HermesTarget, message: string, timeoutMs: number): Promise<ProbeOutcome> {
    this.probeCalls.push({target, message, timeoutMs});
    return this.probes.shift() ?? {kind: 'completed'};
  }
}

/** Inserta la fila de un asistente con su VM ya reclamada. */
export async function seedAssistant(database: Database, cipher: FieldCipher, row: {
  userId: string; status?: string; step?: string | null; startedAt: Date; updatedAt?: Date;
  aiConfigured?: boolean; provider?: string | null; model?: string | null; readySince?: Date | null; privateIp?: string | null;
}): Promise<void> {
  await database.pool.query(`
    INSERT INTO assistant.assistants (user_id, status, step, instance_name, zone, private_ip, api_server_key_enc, bundle_version,
      ai_provider, ai_model, ai_configured, activation_started_at, ready_since, attempts, created_at, updated_at)
    VALUES ($1, $2, $3, $4, 'us-central1-a', $5::inet, $6, 'saleads-sales-agent@1.1.0', $7, $8, $9, $10, $11, 1, $10, $12)`,
  [row.userId, row.status ?? 'activating', row.step === undefined ? 'preparing_environment' : row.step, INSTANCE, row.privateIp ?? null,
    cipher.seal('assistants.api_server_key_enc', row.userId, API_SERVER_KEY), row.provider ?? null, row.model ?? null,
    row.aiConfigured ?? false, row.startedAt, row.readySince ?? null, row.updatedAt ?? row.startedAt]);
}
