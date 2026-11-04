import type {InstanceDetails, InstanceMetadata} from '../renewal/instance-metadata';
import {ComputeError} from './compute-client';
import type {MetadataItem} from './metadata';

/** Estado de la VM según `instances.get` (OCB-008). */
export type InstanceStatus =
  | 'PROVISIONING' | 'STAGING' | 'RUNNING' | 'STOPPING' | 'STOPPED' | 'SUSPENDING' | 'SUSPENDED'
  | 'REPAIRING' | 'TERMINATED' | 'UNKNOWN';

export interface InstanceView {
  /** Compute's immutable instance id; a recreated same-name host has a new generation. */
  generation?: string;
  status: InstanceStatus;
  /** networkInterfaces[0].networkIP; null si todavía no tiene. */
  privateIp: string | null;
  /** metadata.fingerprint: obligatorio para setMetadata. */
  fingerprint: string;
  items: MetadataItem[];
}

/**
 * Vista de UNA instancia existente para la readiness (OCB-008) y la IA
 * (OCB-010): `instances.get`, `instances.setMetadata` (con fingerprint) y el
 * guest attribute del ack. La zona ya va fijada.
 */
export interface InstanceApi {
  /** null = 404 (la instancia no existe). */
  getInstance(name: string): Promise<InstanceView | null>;
  /** Lanza ComputeError 412 si el fingerprint ya no es el vigente. */
  setMetadata(name: string, fingerprint: string, items: MetadataItem[]): Promise<void>;
  /** Valor del guest attribute (`hermes/applied-version`…); null si aún no existe. */
  guestAttribute(name: string, key: string): Promise<string | null>;
}

/** Lo que se usa del transporte compartido (src/renewal/instance-metadata.ts, RestInstanceMetadata). */
export interface InstanceTransport {
  inspect(instance: string, zone: string): Promise<InstanceDetails>;
  write(instance: string, zone: string, metadata: InstanceMetadata): Promise<'ok' | 'conflict'>;
  guestAttribute(instance: string, zone: string, key: string): Promise<string | null>;
}

const STATUSES: readonly InstanceStatus[] = [
  'PROVISIONING', 'STAGING', 'RUNNING', 'STOPPING', 'STOPPED', 'SUSPENDING', 'SUSPENDED', 'REPAIRING', 'TERMINATED',
];

/**
 * Adaptador sobre el ÚNICO transporte REST de instancia (el de OCB-009): no
 * duplica la llamada a Compute, solo fija la zona, tipa el estado y traduce
 * 404 → null y `conflict` → ComputeError 412.
 */
export class RestInstanceClient implements InstanceApi {
  constructor(private readonly transport: InstanceTransport, private readonly zone: string) {}

  async getInstance(name: string): Promise<InstanceView | null> {
    let details: InstanceDetails;
    try {
      details = await this.transport.inspect(name, this.zone);
    } catch (error) {
      if (error instanceof ComputeError && error.status === 404) return null;
      throw error;
    }
    const status = STATUSES.find(value => value === details.status) ?? 'UNKNOWN';
    return {status, privateIp: details.privateIp, fingerprint: details.fingerprint, items: details.items,
      ...(details.generation?{generation:details.generation}:{})};
  }

  async setMetadata(name: string, fingerprint: string, items: MetadataItem[]): Promise<void> {
    if (await this.transport.write(name, this.zone, {fingerprint, items}) === 'conflict') throw new ComputeError(412, 'conditionNotMet');
  }

  guestAttribute(name: string, key: string): Promise<string | null> {
    return this.transport.guestAttribute(name, this.zone, key);
  }
}
