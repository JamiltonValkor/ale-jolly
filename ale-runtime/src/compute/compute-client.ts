import type {OutboundFetch} from '../outbound/http-client';
import type {GcpTokenSource} from './gcp-token';
import type {MetadataItem} from './metadata';

/** Resultado de `instances.insert`. */
export type InsertResult = {kind: 'created'; operation: string} | {kind: 'exists'};
/** Estado de una operación zonal. `errorReason` es un código de GCP saneado. */
export interface OperationStatus { done: boolean; errorReason: string | null }

/**
 * Puerto de Compute Engine. OCB-008/010/012 lo amplían (instances.get,
 * setMetadata, stop/start/delete) sobre el mismo transporte.
 */
export interface ComputeApi {
  templateMetadata(): Promise<MetadataItem[]>;
  insertInstance(input: {name: string; items: MetadataItem[]; requestId: string}): Promise<InsertResult>;
  operationStatus(operation: string): Promise<OperationStatus>;
}

/**
 * Error de Compute sin el mensaje de GCP (puede citar valores): solo el status
 * HTTP y el `reason` saneado. status 0 = red, timeout o token.
 */
export class ComputeError extends Error {
  constructor(readonly status: number, readonly reason: string) {
    super(`COMPUTE_FAILED status=${status} reason=${reason}`);
    this.name = 'ComputeError';
  }
}

export const safeReason = (value: unknown): string =>
  typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : 'other';

export interface ComputeLocation { project: string; zone: string; template: string; apiBase: string }

/**
 * Transporte REST de Compute v1 (patrón de 9282e1b:src/provisioning/compute-transport.ts
 * sin STS/WIF ni regex de nombres): token del metadata server, User-Agent
 * explícito y timeout del cliente saliente. Nunca registra cuerpos ni URLs.
 */
export class RestComputeClient implements ComputeApi {
  private readonly base: string;

  constructor(
    private readonly location: ComputeLocation,
    private readonly tokens: GcpTokenSource,
    private readonly fetcher: OutboundFetch,
  ) {
    this.base = location.apiBase.replace(/\/$/, '');
  }

  async templateMetadata(): Promise<MetadataItem[]> {
    const body = await this.call('GET', `/${this.location.template}`) as {properties?: {metadata?: {items?: unknown}}};
    const items = body.properties?.metadata?.items;
    if (!Array.isArray(items)) return [];
    return items.filter((item): item is MetadataItem =>
      !!item && typeof item.key === 'string' && typeof item.value === 'string');
  }

  async insertInstance(input: {name: string; items: MetadataItem[]; requestId: string}): Promise<InsertResult> {
    const query = new URLSearchParams({sourceInstanceTemplate: this.location.template, requestId: input.requestId});
    // Solo nombre y metadata: discos, red, SA, tags y labels vienen de la plantilla.
    const payload = {name: input.name, metadata: {items: input.items}};
    try {
      const body = await this.call('POST', `${this.zonePath()}/instances?${query}`, payload) as {name?: unknown};
      if (typeof body.name !== 'string') throw new ComputeError(502, 'invalid_operation');
      return {kind: 'created', operation: body.name};
    } catch (error) {
      if (error instanceof ComputeError && error.status === 409 && error.reason === 'alreadyExists') return {kind: 'exists'};
      throw error;
    }
  }

  async operationStatus(operation: string): Promise<OperationStatus> {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(operation)) throw new ComputeError(0, 'invalid_operation');
    const body = await this.call('GET', `${this.zonePath()}/operations/${operation}`) as {
      status?: unknown; error?: {errors?: Array<{code?: unknown}>};
    };
    const code = body.error?.errors?.[0]?.code;
    return {done: body.status === 'DONE', errorReason: code === undefined ? null : safeReason(code)};
  }

  protected zonePath(): string {
    return `/projects/${this.location.project}/zones/${this.location.zone}`;
  }

  /** Transporte compartido; OCB-012 (src/lifecycle) lo reutiliza para get/setMetadata/stop/start/delete. */
  protected async call(method: 'GET' | 'POST' | 'DELETE', path: string, payload?: unknown): Promise<unknown> {
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
