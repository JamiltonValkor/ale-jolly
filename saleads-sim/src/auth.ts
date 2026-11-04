import {randomUUID} from 'node:crypto';
import {type AuthInfo, bearerAuthChallengeResponse, getOAuthProtectedResourceMetadataUrl, OAuthError, OAuthErrorCode} from '@modelcontextprotocol/server';
import {SALEADS_SCOPES, type SaleadsScope, type SimConfig} from './config';
import type {RealmKeys} from './keys';
import type {AuthContext} from './tools/common';

/**
 * Compuerta Bearer del MCP y de `/agent/v1` (sa-mcp-server `bearer-auth.ts` y
 * `jwt-verifier.ts`): RS256, `iss`, `aud = MCP_URL`, `exp`/`sub`/`azp`, `typ =
 * Bearer` si viene, y el cliente web (`front`) siempre rechazado. 401 con
 * `WWW-Authenticate` y `resource_metadata`.
 */

export const AUTH_KEY = 'saleads.auth';
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export type BearerAuthenticator = (request: Request) => Promise<AuthInfo | Response>;

export function resourceMetadataUrl(config: SimConfig): string {
  return getOAuthProtectedResourceMetadataUrl(new URL(config.mcpUrl));
}

export function createBearerAuthenticator(config: SimConfig, keys: RealmKeys): BearerAuthenticator {
  const challenge = {requiredScopes: ['saleads:read'], resourceMetadataUrl: resourceMetadataUrl(config)};
  const reject = (requestId: string, description: string) => {
    const response = bearerAuthChallengeResponse(new OAuthError(OAuthErrorCode.InvalidToken, description), challenge);
    response.headers.set('x-request-id', requestId);
    return response;
  };
  return async (request) => {
    const inbound = request.headers.get('x-request-id');
    const requestId = inbound && REQUEST_ID.test(inbound) ? inbound : randomUUID();
    const header = request.headers.get('authorization');
    if (!header) return reject(requestId, 'Missing access token');
    const token = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i.exec(header.trim())?.[1];
    if (!token) return reject(requestId, 'Invalid Authorization header, expected Bearer token');
    let payload: Record<string, unknown>;
    try {
      payload = await keys.verify(token, {issuer: config.issuer, audience: config.mcpUrl});
    } catch (error) {
      return reject(requestId, (error as {code?: string}).code === 'ERR_JWT_EXPIRED' ? 'Access token expired' : 'Invalid access token');
    }
    const typ = payload.typ;
    if ((typ !== undefined && String(typ).toLowerCase() !== 'bearer') || typeof payload.sub !== 'string' || !payload.sub
      || typeof payload.azp !== 'string' || !payload.azp || payload.azp === config.webClientId || typeof payload.exp !== 'number') {
      return reject(requestId, 'Invalid access token');
    }
    const granted = new Set(String(payload.scope ?? '').split(' '));
    const ctx: AuthContext = {
      userId: payload.sub, clientId: payload.azp, scopes: new Set(SALEADS_SCOPES.filter((s) => granted.has(s)) as SaleadsScope[]),
      requestId, expiresAt: payload.exp,
    };
    return {token: '[redacted]', clientId: ctx.clientId, scopes: [...ctx.scopes], expiresAt: ctx.expiresAt,
      resource: new URL(config.mcpUrl), extra: {[AUTH_KEY]: ctx}};
  };
}

export function readAuth(info: AuthInfo | undefined): AuthContext | undefined {
  return info?.extra?.[AUTH_KEY] as AuthContext | undefined;
}

/** Token web (`azp = front`) del gateway clásico: el mismo criterio que ale-runtime `IdentityVerifier`. */
export async function verifyWebToken(config: SimConfig, keys: RealmKeys, token: string | null): Promise<string | null> {
  if (!token) return null;
  try {
    const payload = await keys.verify(token, {issuer: config.issuer});
    if (payload.typ !== 'Bearer' || payload.azp !== config.webClientId || typeof payload.sub !== 'string') return null;
    return payload.sub;
  } catch {
    return null;
  }
}
