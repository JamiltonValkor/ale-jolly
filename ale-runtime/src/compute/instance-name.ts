import {createHash} from 'node:crypto';

/** Empty scope preserves legacy names; isolated deployments use their own stable scope. */
export function instanceNameFor(userId: string, runtimeNamespace = ''): string {
  const identity = runtimeNamespace ? `${runtimeNamespace}\0${userId}` : userId;
  return `sa-assistant-${createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 32)}`;
}

/** Namespace fijo de los requestId de Compute de este servicio. */
const REQUEST_NAMESPACE = 'c0a3b7e2-5d41-5f0e-9b8a-6a1f2d3e4c5b';

/** UUIDv5 (RFC 9562) de `name` en `namespace`. */
export function uuidv5(name: string, namespace = REQUEST_NAMESPACE): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(ns).update(name, 'utf8').digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * requestId de `instances.insert`: UUIDv5(user_id + generación + intento).
 * Repetir un intento lo deduplica GCP. La generación (activation_started_at en
 * ms) separa un asistente nuevo tras un borrado (OCB-012): GCP recuerda un
 * requestId al menos 60 min y, sin ella, la VM nueva no se crearía.
 */
export const insertRequestId = (userId: string, attempt: number, generation?: number, runtimeNamespace = '') => {
  const identity = generation === undefined ? `instances.insert:${userId}:${attempt}` : `instances.insert:${userId}:${generation}:${attempt}`;
  return uuidv5(runtimeNamespace ? `runtime:${runtimeNamespace}:${identity}` : identity);
};
