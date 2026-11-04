import {safeReason} from '../compute/compute-client';
import type {OutboundFetch} from '../outbound/http-client';
import {OAuthTokenError} from './token-client';

/**
 * Puerto de revocación RFC 7009 del cliente público del asistente. Revocar el
 * refresh (offline) cierra la sesión offline entera en Keycloak: también deja
 * sin valor la copia que Hermes tiene en la VM (prueba real OCB-002, G-09:
 * sesiones offline 1 → 0, la sesión web sigue viva). No necesita Admin API.
 */
export interface OAuthRevocationApi {
  revoke(token: string, hint?: 'refresh_token' | 'access_token'): Promise<void>;
}

export interface RevokeClientOptions { revokeUrl: string; clientId: string }

/**
 * `POST /protocol/openid-connect/revoke` por el Keycloak INTERNO (el público da
 * 403 desde GKE). Por RFC 7009 un token ya inválido también responde 200.
 * Errores: 400/401 → `rejected` (invalid_client…), red/5xx → `unavailable`.
 * Nunca registra el token ni el cuerpo.
 */
export class KeycloakRevocationClient implements OAuthRevocationApi {
  constructor(private readonly options: RevokeClientOptions, private readonly fetcher: OutboundFetch) {}

  async revoke(token: string, hint: 'refresh_token' | 'access_token' = 'refresh_token'): Promise<void> {
    let response: Response;
    try {
      response = await this.fetcher(this.options.revokeUrl, {
        method: 'POST',
        headers: {'content-type': 'application/x-www-form-urlencoded', accept: 'application/json'},
        body: new URLSearchParams({token, token_type_hint: hint, client_id: this.options.clientId}).toString(),
      });
    } catch {
      throw new OAuthTokenError('unavailable', 'network');
    }
    if (response.ok) return;
    let body: unknown = null;
    try {body = await response.json();} catch {body = null;}
    if (response.status === 400 || response.status === 401) {
      throw new OAuthTokenError('rejected', safeReason((body as {error?: unknown} | null)?.error));
    }
    throw new OAuthTokenError('unavailable', `http_${response.status}`);
  }
}
