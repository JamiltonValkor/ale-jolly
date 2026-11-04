import {ComputeError, RestComputeClient, safeReason, type OperationStatus} from '../compute/compute-client';
import type {MetadataItem} from '../compute/metadata';

/** Lo que el ciclo de vida necesita de una instancia (instances.get). */
export interface InstanceInfo {
  /** PROVISIONING | STAGING | RUNNING | STOPPING | TERMINATED | SUSPENDED… (saneado). */
  status: string;
  /** Fingerprint de la metadata: setMetadata lo exige para no pisar cambios ajenos. */
  fingerprint: string;
  items: MetadataItem[];
  /** networkInterfaces[0].networkIP; null si todavía no tiene. */
  privateIp: string | null;
}

/**
 * Puerto de Compute del ciclo de vida (OCB-012): leer la instancia, reemplazar
 * su metadata con fingerprint, apagar, encender, borrar y leer guest
 * attributes. Las operaciones devuelven el nombre de la operación zonal.
 * Nunca registra cuerpos ni valores de metadata (la signed URL va ahí).
 */
export interface LifecycleComputeApi {
  instanceInfo(name: string): Promise<InstanceInfo | null>;
  /** `items` debe ser la metadata COMPLETA (setMetadata reemplaza, no fusiona). */
  replaceMetadata(name: string, fingerprint: string, items: MetadataItem[]): Promise<string>;
  stopInstance(name: string): Promise<string>;
  startInstance(name: string): Promise<string>;
  /** null si la instancia ya no existe (404). */
  deleteInstance(name: string): Promise<string | null>;
  /** Valor del guest attribute `<namespace>/<key>`, o null si no existe. */
  guestAttribute(name: string, namespace: string, key: string): Promise<string | null>;
  operationStatus(operation: string): Promise<OperationStatus>;
}

const INSTANCE_NAME = /^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

/**
 * Compute REST v1 sobre el transporte compartido de `RestComputeClient`
 * (token del metadata server, User-Agent de OCB-006, timeout y errores sin
 * mensaje de GCP). Agrega DELETE, :stop, :start, :setMetadata y
 * :getGuestAttributes (ancla de OCB-012 sobre 9282e1b compute-transport.ts:36).
 */
export class RestLifecycleCompute extends RestComputeClient implements LifecycleComputeApi {
  async instanceInfo(name: string): Promise<InstanceInfo | null> {
    let body: {
      status?: unknown;
      metadata?: {fingerprint?: unknown; items?: unknown};
      networkInterfaces?: Array<{networkIP?: unknown}>;
    };
    try {
      body = await this.call('GET', this.instancePath(name)) as typeof body;
    } catch (error) {
      if (error instanceof ComputeError && error.status === 404) return null;
      throw error;
    }
    const fingerprint = body.metadata?.fingerprint;
    if (typeof fingerprint !== 'string' || !fingerprint) throw new ComputeError(502, 'invalid_instance');
    const rawItems = Array.isArray(body.metadata?.items) ? body.metadata.items as unknown[] : [];
    const items = rawItems.filter((item): item is MetadataItem =>
      !!item && typeof (item as MetadataItem).key === 'string' && typeof (item as MetadataItem).value === 'string');
    const ip = body.networkInterfaces?.[0]?.networkIP;
    return {
      status: safeReason(body.status),
      fingerprint,
      items,
      privateIp: typeof ip === 'string' && IPV4.test(ip) ? ip : null,
    };
  }

  async replaceMetadata(name: string, fingerprint: string, items: MetadataItem[]): Promise<string> {
    return this.operation(await this.call('POST', `${this.instancePath(name)}/setMetadata`, {fingerprint, items}));
  }

  async stopInstance(name: string): Promise<string> {
    return this.operation(await this.call('POST', `${this.instancePath(name)}/stop`));
  }

  async startInstance(name: string): Promise<string> {
    return this.operation(await this.call('POST', `${this.instancePath(name)}/start`));
  }

  async deleteInstance(name: string): Promise<string | null> {
    try {
      return this.operation(await this.call('DELETE', this.instancePath(name)));
    } catch (error) {
      if (error instanceof ComputeError && error.status === 404) return null;
      throw error;
    }
  }

  async guestAttribute(name: string, namespace: string, key: string): Promise<string | null> {
    const query = new URLSearchParams({queryPath: `${namespace}/`});
    let body: {queryValue?: {items?: Array<{namespace?: unknown; key?: unknown; value?: unknown}>}};
    try {
      body = await this.call('GET', `${this.instancePath(name)}/getGuestAttributes?${query}`) as typeof body;
    } catch (error) {
      if (error instanceof ComputeError && error.status === 404) return null;
      throw error;
    }
    const item = body.queryValue?.items?.find(entry => entry.namespace === namespace && entry.key === key);
    return typeof item?.value === 'string' ? item.value : null;
  }

  private instancePath(name: string): string {
    if (!INSTANCE_NAME.test(name)) throw new ComputeError(0, 'invalid_instance_name');
    return `${this.zonePath()}/instances/${name}`;
  }

  private operation(body: unknown): string {
    const name = (body as {name?: unknown} | null)?.name;
    if (typeof name !== 'string') throw new ComputeError(502, 'invalid_operation');
    return name;
  }
}
