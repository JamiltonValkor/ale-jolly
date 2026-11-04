import {z} from 'zod';
import type {OutboundFetch} from '../outbound/http-client';

/** Token de acceso de GCP para Compute. */
export interface GcpTokenSource { token(): Promise<string> }

export class GcpTokenError extends Error {
  constructor() {super('GCP_TOKEN_UNAVAILABLE'); this.name = 'GcpTokenError';}
}

const TokenResponse = z.object({access_token: z.string().min(1), expires_in: z.number().positive()});

/**
 * Workload Identity de GKE: el metadata server del nodo entrega el token de la
 * GSA ligada a la KSA del pod. Sin STS/WIF manual ni llaves (OCB-007). Se
 * cachea hasta 60 s antes de vencer.
 */
export class MetadataServerTokenSource implements GcpTokenSource {
  private cached: {token: string; expiresAt: number} | null = null;

  constructor(
    private readonly fetcher: OutboundFetch,
    private readonly url: string,
    private readonly now: () => number = Date.now,
  ) {}

  async token(): Promise<string> {
    if (this.cached && this.cached.expiresAt - 60_000 > this.now()) return this.cached.token;
    try {
      const response = await this.fetcher(this.url, {headers: {'Metadata-Flavor': 'Google'}});
      if (!response.ok) throw new Error();
      const body = TokenResponse.parse(await response.json());
      this.cached = {token: body.access_token, expiresAt: this.now() + body.expires_in * 1000};
      return body.access_token;
    } catch {
      throw new GcpTokenError();
    }
  }
}
