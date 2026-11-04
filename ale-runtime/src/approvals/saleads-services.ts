import type {OutboundFetch} from '../outbound/http-client';

/**
 * Cliente HTTP del servicio hacia strategy y campaign dentro del clúster
 * (MLB-013). Solo lo usan los ejecutores de aprobaciones de gasto, después de
 * que el dueño aprobó con su código. Reutiliza los endpoints de la web.
 *
 * Siempre manda `x-user-id` = el dueño de la aprobación y falla cerrado sin él:
 * campaign se salta la verificación de propiedad cuando falta ese header
 * (campaign.controller.ts:2344-2349). Nunca registra cuerpos ni headers.
 */
export interface ServicesResponse {
  status: number;
  body: Record<string, unknown> | null;
  etag: string | null;
}

export class MissingUserError extends Error {
  constructor() {
    super('SERVICES_USER_REQUIRED');
    this.name = 'MissingUserError';
  }
}

export class ServicesUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`SERVICES_UNAVAILABLE:${reason}`);
    this.name = 'ServicesUnavailableError';
  }
}

const USER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

export interface ServicesConfig {
  strategyUrl: string;
  campaignUrl: string;
  /** AAB-012 (C-15): cuota de campañas. Sin URL, las llamadas a subscription fallan cerrado. */
  subscriptionUrl?: string;
  /** Proyección de gasto del agente en integration (AAB-026), para que una aprobación de encendido no quede vieja. */
  integrationUrl?: string;
  /**
   * AAB-012 (C-9, V-A7): token interno común (`saleads-dev-common-INTERNAL_API_TOKEN`) para las rutas
   * `/internal` de campaign, strategy y subscription. Solo se manda cuando la llamada lo pide (`internal: true`).
   */
  internalToken?: string;
  timeoutMs: number;
}

/** Cabecera del token interno que lee cada servicio (V-A7). */
const INTERNAL_HEADER: Record<'strategy' | 'campaign' | 'subscription' | 'integration', string> = {
  campaign: 'x-internal-api-token', strategy: 'x-internal-token', subscription: 'x-internal-api-token', integration: 'x-internal-token',
};

export class SaleadsServicesClient {
  constructor(private readonly config: ServicesConfig, private readonly fetcher: OutboundFetch) {}

  async call(input: {
    service: 'strategy' | 'campaign' | 'subscription' | 'integration';
    method: 'GET' | 'POST' | 'PATCH';
    /** Parámetros de consulta (valores cortos, se codifican). */
    query?: Record<string, string>;
    /** Rutas `/internal` del servicio: agrega su cabecera de token interno; sin token configurado falla cerrado. */
    internal?: boolean;
    path: string;
    userId: string;
    businessId?: string;
    body?: unknown;
    idempotencyKey?: string;
    ifMatch?: string;
  }): Promise<ServicesResponse> {
    if (!input.userId || !USER.test(input.userId)) throw new MissingUserError();
    if (!input.path.startsWith('/') || input.path.split('/').slice(1).some(part => !SEGMENT.test(part))) {
      throw new ServicesUnavailableError('invalid_path');
    }
    const base = input.service === 'strategy' ? this.config.strategyUrl
      : input.service === 'campaign' ? this.config.campaignUrl
        : input.service === 'integration' ? this.config.integrationUrl : this.config.subscriptionUrl;
    if (!base) throw new ServicesUnavailableError(`${input.service}_not_configured`);
    const headers: Record<string, string> = {accept: 'application/json', 'x-user-id': input.userId};
    if (input.internal) {
      if (!this.config.internalToken) throw new ServicesUnavailableError('internal_token_not_configured');
      headers[INTERNAL_HEADER[input.service]] = this.config.internalToken;
    }
    if (input.businessId) headers['x-business-id'] = input.businessId;
    if (input.idempotencyKey) headers['idempotency-key'] = input.idempotencyKey;
    if (input.ifMatch) headers['if-match'] = input.ifMatch;
    if (input.body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      const query = input.query && Object.keys(input.query).length ? `?${new URLSearchParams(input.query).toString()}` : '';
      response = await this.fetcher(`${base.replace(/\/$/, '')}${input.path}${query}`, {
        method: input.method,
        headers,
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
        redirect: 'manual',
      });
    } catch {
      throw new ServicesUnavailableError('network');
    }
    let body: unknown = null;
    try {
      const text = await response.text();
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return {
      status: response.status,
      body: body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null,
      etag: response.headers.get('etag'),
    };
  }
}

/** Código de error que devuelven strategy y campaign (`code`, `error` o `error.code`). */
export function downstreamCode(body: Record<string, unknown> | null): string | null {
  if (!body) return null;
  const nested = body['error'];
  const candidates = [body['code'], typeof nested === 'string' ? nested : (nested as {code?: unknown} | null)?.code];
  const code = candidates.find((value): value is string => typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,60}$/.test(value));
  return code ?? null;
}
