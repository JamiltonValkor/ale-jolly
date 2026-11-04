import {createHash, createHmac, hkdfSync} from 'node:crypto';

/** Formato del header Idempotency-Key (el mismo que valida el BFF de OCF-002). */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;

export const sha256hex = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
export const pkceChallenge = (verifier: string) => createHash('sha256').update(verifier, 'ascii').digest('base64url');

/**
 * state y code_verifier del flujo PKCE, derivados con HMAC de (usuario,
 * Idempotency-Key) con una subclave HKDF de FIELD_ENCRYPTION_KEY. El mismo clic
 * repetido (misma key) produce la misma authorize_url y el mismo oauth_flows,
 * sin filas nuevas; sin la clave del servicio nadie puede predecirlos. La base
 * solo guarda sha256(state) y el verifier cifrado.
 */
export class OAuthFlowSecrets {
  private readonly key: Buffer;

  constructor(masterKey: Uint8Array) {
    this.key = Buffer.from(hkdfSync('sha256', masterKey, 'sa-assistant-service', 'oauth-flow:v1', 32));
  }

  derive(userId: string, idempotencyKey: string): {state: string; verifier: string} {
    const mac = (label: string) => createHmac('sha256', this.key).update(`${label}\0${userId}\0${idempotencyKey}`, 'utf8').digest('base64url');
    return {state: mac('state'), verifier: mac('verifier')};
  }
}

export interface AuthorizeParams {
  authorizeUrl: string;
  clientId: string;
  redirectUri: string;
  scope: string;
}

/** authorize_url del salto SSO silencioso: PKCE S256 y `prompt=none` en el primer intento. */
export function buildAuthorizeUrl(params: AuthorizeParams, flow: {state: string; verifier: string}): string {
  const url = new URL(params.authorizeUrl);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    scope: params.scope,
    state: flow.state,
    code_challenge: pkceChallenge(flow.verifier),
    code_challenge_method: 'S256',
    prompt: 'none',
  }).toString();
  return url.toString();
}
