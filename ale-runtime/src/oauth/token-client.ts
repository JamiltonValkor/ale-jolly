import {z} from 'zod';
import type {OutboundFetch} from '../outbound/http-client';
import {safeReason} from '../compute/compute-client';

/** Tokens del cliente del asistente. Nunca se registran ni salen en respuestas. */
export interface AssistantTokenSet {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  scope: string;
  expiresIn: number;
}

/** Puerto del token endpoint de Keycloak (cliente público, PKCE). */
export interface OAuthTokenApi {
  exchangeCode(input: {code: string; verifier: string}): Promise<AssistantTokenSet>;
  refresh(refreshToken: string): Promise<AssistantTokenSet>;
}

/** `rejected` = Keycloak dijo que no (invalid_grant…); `unavailable` = red, 5xx o respuesta rara. */
export class OAuthTokenError extends Error {
  constructor(readonly kind: 'rejected' | 'unavailable', readonly reason: string) {
    super(`OAUTH_TOKEN_FAILED kind=${kind} reason=${reason}`);
    this.name = 'OAuthTokenError';
  }
}

const TokenResponse = z.object({
  access_token: z.string().min(1).max(16384),
  refresh_token: z.string().min(1).max(16384),
  token_type: z.string().regex(/^bearer$/i),
  expires_in: z.number().int().positive(),
  scope: z.string().max(1000).default(''),
});

export interface TokenClientOptions { tokenUrl: string; clientId: string; redirectUri: string }

/**
 * Canje y refresh contra el token endpoint INTERNO de Keycloak
 * (keycloak.keycloak.svc:8080): el público pasa por Cloudflare y da 403 desde
 * GKE. Keycloak firma con el `iss` público igual. Patrón de
 * 9282e1b:src/security/mcp-oauth-transport.ts:22-29.
 */
export class KeycloakTokenClient implements OAuthTokenApi {
  constructor(private readonly options: TokenClientOptions, private readonly fetcher: OutboundFetch) {}

  exchangeCode(input: {code: string; verifier: string}): Promise<AssistantTokenSet> {
    return this.post({
      grant_type: 'authorization_code',
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: this.options.redirectUri,
      client_id: this.options.clientId,
    });
  }

  refresh(refreshToken: string): Promise<AssistantTokenSet> {
    return this.post({grant_type: 'refresh_token', refresh_token: refreshToken, client_id: this.options.clientId});
  }

  private async post(form: Record<string, string>): Promise<AssistantTokenSet> {
    let response: Response;
    try {
      response = await this.fetcher(this.options.tokenUrl, {
        method: 'POST',
        headers: {'content-type': 'application/x-www-form-urlencoded', accept: 'application/json'},
        body: new URLSearchParams(form).toString(),
      });
    } catch {
      throw new OAuthTokenError('unavailable', 'network');
    }
    let body: unknown = null;
    try {body = await response.json();} catch {body = null;}
    if (response.status === 400 || response.status === 401) {
      throw new OAuthTokenError('rejected', safeReason((body as {error?: unknown} | null)?.error));
    }
    if (!response.ok) throw new OAuthTokenError('unavailable', `http_${response.status}`);
    const parsed = TokenResponse.safeParse(body);
    if (!parsed.success) throw new OAuthTokenError('unavailable', 'invalid_response');
    return {
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token,
      tokenType: 'Bearer',
      scope: parsed.data.scope,
      expiresIn: parsed.data.expires_in,
    };
  }
}
