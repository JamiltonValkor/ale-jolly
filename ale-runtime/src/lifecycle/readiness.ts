import type {InstanceStatus} from '../compute/instance-client';
import type {HealthObservation} from '../hermes/hermes-client';
import type {AssistantRow} from '../persistence/assistant-repository';

/**
 * Reglas puras de readiness (OCB-008). Sin E/S: el lector las aplica a lo que
 * observó en Compute y en `GET /health/detailed`.
 *
 * Hermes v0.21.6 (gateway/readiness.py:106-119) reporta los checks state_db,
 * session_store, config, model, disk, gateway y background_queues, y su
 * `status` es ok solo si todos lo están. Sin modelo, `model` siempre sale
 * degraded, así que «Configura tu IA» = todos ok salvo `model`. El endpoint
 * responde 200 también cuando está degradado: por eso se miran los checks.
 */
export type HermesReadiness = 'not_responding' | 'unauthorized' | 'agent_degraded' | 'needs_model' | 'healthy';

export function classifyHealth(observation: HealthObservation): HermesReadiness {
  if (observation.kind === 'unauthorized') return 'unauthorized';
  if (observation.kind !== 'answered' || observation.platform !== 'hermes-agent') return 'not_responding';
  const names = Object.keys(observation.checks);
  if (!names.length) return 'agent_degraded';
  const othersOk = names.filter(name => name !== 'model').every(name => observation.checks[name] === 'ok');
  if (!othersOk) return 'agent_degraded';
  return observation.checks.model === 'ok' ? 'healthy' : 'needs_model';
}

/** Lo que se vio de la VM en una observación. */
export type VmObservation =
  | {vm: 'unknown'}
  | {vm: 'missing'}
  | {vm: 'booting'}
  | {vm: 'stopped'}
  | {vm: 'running'; ip: string | null; hermes: HermesReadiness | null};

const BOOTING: readonly InstanceStatus[] = ['PROVISIONING', 'STAGING', 'REPAIRING'];
const STOPPED: readonly InstanceStatus[] = ['STOPPING', 'STOPPED', 'SUSPENDING', 'SUSPENDED', 'TERMINATED'];

export function vmPhase(status: InstanceStatus): 'booting' | 'stopped' | 'running' | 'unknown' {
  if (status === 'RUNNING') return 'running';
  if (BOOTING.includes(status)) return 'booting';
  if (STOPPED.includes(status)) return 'stopped';
  return 'unknown';
}

/** Cambio a persistir. `milestone` = hito que mueve `ready_since` (requisito de OCF-001). */
export interface Transition {
  status: 'activating' | 'stopped' | 'failed' | 'ready';
  step: AssistantRow['step'];
  privateIp: string | null;
  milestone: 'configure_ai' | 'ready' | null;
  event: {kind: string; cause: 'vm_create_failed' | 'unknown' | null; detail: string} | null;
}

/** ¿Hay algo que observar? Solo una activación que ya reclamó su VM. */
export function needsObservation(row: AssistantRow | null): row is AssistantRow {
  return !!row && !row.deleted_at && row.status === 'activating' && !!row.instance_name
    && row.step !== 'preparing_access' && !!row.api_server_key_enc;
}

/**
 * Siguiente estado de una activación (status=activating) según la observación.
 * Devuelve null si no cambia nada.
 *
 * - VM PROVISIONING/STAGING → preparing_environment.
 * - RUNNING y Hermes sin respuesta válida (o con algún check ≠ ok salvo model) → installing_agent.
 * - RUNNING y todos ok salvo model → configure_ai (primer hito: ready_since).
 * - RUNNING, todo ok y `ai_configured` (el turno de prueba de OCB-010 ya pasó,
 *   p. ej. al reactivar en OCB-012) → status=ready (hito: ready_since). Sin
 *   `ai_configured` nunca se dice ready: ni por archivos ni por una VM encendida.
 * - 401 de Hermes → sin avance (el evento lo registra el lector).
 * - STOPPING/TERMINATED → status=stopped; 404 → status=failed + evento. Ambos
 *   solo tras la gracia, para no pisar una creación o un start recién pedidos.
 */
export function nextTransition(row: AssistantRow, observation: VmObservation, now: Date, graceMs: number): Transition | null {
  const ip = row.private_ip;
  const settled = now.getTime() - row.updated_at.getTime() > graceMs;
  const to = (step: AssistantRow['step'], extra: Partial<Transition> = {}): Transition | null => {
    const next: Transition = {status: 'activating', step, privateIp: ip, milestone: null, event: null, ...extra};
    if (next.status === row.status && next.step === row.step && next.privateIp === row.private_ip) return null;
    return next;
  };
  switch (observation.vm) {
  case 'unknown':
    return null;
  case 'booting':
    return to('preparing_environment');
  case 'missing': {
    const seen = row.step === 'installing_agent' || row.step === 'configure_ai';
    if (!seen && !settled) return null;
    return {
      status: 'failed', step: row.step, privateIp: ip, milestone: null,
      event: {kind: 'readiness.vm_missing', cause: seen ? 'unknown' : 'vm_create_failed', detail: `step=${row.step ?? 'none'}`},
    };
  }
  case 'stopped':
    if (!settled) return null;
    return {
      status: 'stopped', step: null, privateIp: ip, milestone: null,
      event: {kind: 'readiness.vm_stopped', cause: null, detail: `step=${row.step ?? 'none'}`},
    };
  case 'running': {
    const privateIp = observation.ip ?? ip;
    switch (observation.hermes) {
    case 'unauthorized':
      return to(row.step, {privateIp});
    case 'needs_model':
      return to('configure_ai', {privateIp, milestone: row.step === 'configure_ai' ? null : 'configure_ai'});
    case 'healthy':
      if (row.ai_configured) return {status: 'ready', step: null, privateIp, milestone: 'ready', event: null};
      return to('configure_ai', {privateIp, milestone: row.step === 'configure_ai' ? null : 'configure_ai'});
    default:
      return to('installing_agent', {privateIp});
    }
  }
  }
}
