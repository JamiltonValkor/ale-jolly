import {ComputeError, safeReason, type ComputeLocation} from '../compute/compute-client';
import type {GcpTokenSource} from '../compute/gcp-token';
import type {MetadataItem} from '../compute/metadata';
import type {OutboundFetch} from '../outbound/http-client';

/** Metadata actual de una instancia, con su fingerprint (control de concurrencia de GCE). */
export interface InstanceMetadata { fingerprint: string; items: MetadataItem[] }

/**
 * Puerto mínimo de Compute para resembrar `hermes-mcp-tokens`: leer la
 * metadata y escribirla con fingerprint. `conflict` = 412 (otro escritor, p. ej.
 * OCB-010 configurando la IA, cambió la metadata entre la lectura y la
 * escritura). Funciona con la VM encendida o apagada (TERMINATED).
 */
export interface InstanceMetadataApi {
  read(instance: string, zone: string): Promise<InstanceMetadata>;
  write(instance: string, zone: string, metadata: InstanceMetadata): Promise<'ok' | 'conflict'>;
}

/** Detalle de `instances.get` (estado crudo de GCE, IP privada y metadata). */
export interface InstanceDetails extends InstanceMetadata { status: string; privateIp: string | null; generation?: string }

const INSTANCE = /^sa-assistant-[a-f0-9]{32}$/;
const GUEST_KEY = /^[a-z0-9-]{1,63}\/[a-z0-9-]{1,63}$/;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const ZONE = /^[a-z]+-[a-z]+[0-9]-[a-z]$/;

export interface InstanceMetadataOptions {
  /** Cuánto se sigue la operación de setMetadata. 0 = no se sigue. */
  operationTimeoutMs: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * `instances.get` + `instances.setMetadata` de Compute v1 sobre el mismo
 * transporte que RestComputeClient (token del metadata server, User-Agent
 * explícito, sin registrar cuerpos ni URLs). Es el ÚNICO transporte de una
 * instancia existente: la renovación (OCB-009), la readiness (OCB-008) y la IA
 * (OCB-010, vía src/compute/instance-client.ts) lo comparten.
 */
export class RestInstanceMetadata implements InstanceMetadataApi {
  private readonly base: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly location: Pick<ComputeLocation, 'project' | 'apiBase'>,
    private readonly tokens: GcpTokenSource,
    private readonly fetcher: OutboundFetch,
    private readonly options: InstanceMetadataOptions = {operationTimeoutMs: 30_000},
  ) {
    this.base = location.apiBase.replace(/\/$/, '');
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms).unref()));
    this.now = options.now ?? Date.now;
  }

  async read(instance: string, zone: string): Promise<InstanceMetadata> {
    const {fingerprint, items} = await this.inspect(instance, zone);
    return {fingerprint, items};
  }

  /**
   * `instances.get` completo: estado, IP privada (networkInterfaces[0]) y
   * metadata con fingerprint. Lo usan la readiness (OCB-008) y la IA (OCB-010).
   */
  async inspect(instance: string, zone: string): Promise<InstanceDetails> {
    const body = await this.call('GET', `${this.instancePath(instance, zone)}`) as {
      id?: unknown; status?: unknown; networkInterfaces?: Array<{networkIP?: unknown}>;
      metadata?: {fingerprint?: unknown; items?: unknown};
    };
    const fingerprint = body.metadata?.fingerprint;
    if (typeof fingerprint !== 'string' || !fingerprint) throw new ComputeError(502, 'invalid_metadata');
    const raw = body.metadata?.items;
    const items = Array.isArray(raw) ? raw.filter((item): item is MetadataItem =>
      !!item && typeof item.key === 'string' && typeof item.value === 'string').map(item => ({key: item.key, value: item.value})) : [];
    const ip = body.networkInterfaces?.[0]?.networkIP;
    return {
      status: typeof body.status === 'string' && /^[A-Z_]{1,32}$/.test(body.status) ? body.status : 'UNKNOWN',
      privateIp: typeof ip === 'string' && IPV4.test(ip) ? ip : null,
      ...(typeof body.id==='string'&&/^\d{1,24}$/.test(body.id)?{generation:body.id}:{}),
      fingerprint,
      items,
    };
  }

  /** Guest attribute de la VM (p. ej. `hermes/applied-version`); null si aún no existe (404). */
  async guestAttribute(instance: string, zone: string, key: string): Promise<string | null> {
    if (!GUEST_KEY.test(key)) throw new ComputeError(0, 'invalid_guest_key');
    try {
      const body = await this.call('GET',
        `${this.instancePath(instance, zone)}/getGuestAttributes?${new URLSearchParams({variableKey: key})}`) as {variableValue?: unknown};
      return typeof body.variableValue === 'string' ? body.variableValue : null;
    } catch (error) {
      if (error instanceof ComputeError && error.status === 404) return null;
      throw error;
    }
  }

  async write(instance: string, zone: string, metadata: InstanceMetadata): Promise<'ok' | 'conflict'> {
    let operation: string;
    try {
      const body = await this.call('POST', `${this.instancePath(instance, zone)}/setMetadata`,
        {fingerprint: metadata.fingerprint, items: metadata.items}) as {name?: unknown};
      if (typeof body.name !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(body.name)) throw new ComputeError(502, 'invalid_operation');
      operation = body.name;
    } catch (error) {
      if (error instanceof ComputeError && error.status === 412) return 'conflict';
      throw error;
    }
    await this.follow(zone, operation);
    return 'ok';
  }

  private async follow(zone: string, operation: string): Promise<void> {
    if (this.options.operationTimeoutMs <= 0) return;
    const deadline = this.now() + this.options.operationTimeoutMs;
    for (;;) {
      const body = await this.call('GET', `/projects/${this.location.project}/zones/${zone}/operations/${operation}`) as {
        status?: unknown; error?: {errors?: Array<{code?: unknown}>};
      };
      if (body.status === 'DONE') {
        const code = body.error?.errors?.[0]?.code;
        if (code === undefined) return;
        if (code === 'CONDITION_NOT_MET') throw new ComputeError(412, 'conditionNotMet');
        throw new ComputeError(500, safeReason(code));
      }
      // Sin respuesta definitiva a tiempo: GCE la aplica igual; el watcher la recoge.
      if (this.now() >= deadline) return;
      await this.sleep(this.options.pollIntervalMs ?? 1000);
    }
  }

  private instancePath(instance: string, zone: string): string {
    if (!INSTANCE.test(instance) || !ZONE.test(zone)) throw new ComputeError(0, 'invalid_instance');
    return `/projects/${this.location.project}/zones/${zone}/instances/${instance}`;
  }

  private async call(method: 'GET' | 'POST', path: string, payload?: unknown): Promise<unknown> {
    let response: Response;
    try {
      const token = await this.tokens.token();
      response = await this.fetcher(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(payload === undefined ? {} : {'content-type': 'application/json'}),
        },
        ...(payload === undefined ? {} : {body: JSON.stringify(payload)}),
      });
    } catch {
      throw new ComputeError(0, 'unavailable');
    }
    let body: unknown = null;
    try {body = await response.json();} catch {body = null;}
    if (!response.ok) {
      const reason = (body as {error?: {errors?: Array<{reason?: unknown}>; status?: unknown}} | null)?.error;
      throw new ComputeError(response.status, safeReason(reason?.errors?.[0]?.reason ?? reason?.status));
    }
    return body ?? {};
  }
}
