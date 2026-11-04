import {createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey} from 'jose';
import {unauthorized} from '../domain/errors';
import type {Principal} from '../domain/ports';

/**
 * Verificador del token web del usuario (cliente `front` de Keycloak dev).
 * Adaptado de 9282e1b:src/security/identity.ts:9-24: la audiencia pasa a ser
 * opcional (el token de `front` no trae mapper de audiencia) y el JWKS es el
 * Keycloak interno. Se exige iss, RS256, exp/iat/sub, `azp` permitido y
 * `typ=Bearer`. Un token del cliente del asistente (`mcp-saleads-assistant-dev`)
 * no es un token web y recibe 401.
 */
export interface IdentityPolicy {
  issuer: string;
  /** Vacío = no se valida la audiencia. */
  audience: string;
  clients: readonly string[];
}

const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;

export class IdentityVerifier {
  constructor(private readonly policy: IdentityPolicy, private readonly keys: JWTVerifyGetKey) {}

  static remote(policy: IdentityPolicy, jwksUrl: URL, headers: Record<string, string>): IdentityVerifier {
    return new IdentityVerifier(policy, createRemoteJWKSet(jwksUrl, {timeoutDuration: 5000, cooldownDuration: 30000, headers}));
  }

  async verify(authorization: unknown): Promise<Principal> {
    try {
      if (typeof authorization !== 'string' || authorization.length > 16384 || !/^Bearer [^\s]+$/.test(authorization)) throw new Error();
      const {payload} = await jwtVerify(authorization.slice(7), this.keys, {
        algorithms: ['RS256'],
        issuer: this.policy.issuer,
        ...(this.policy.audience ? {audience: this.policy.audience} : {}),
        requiredClaims: ['exp', 'iat', 'sub'],
        clockTolerance: 5,
      });
      if (typeof payload.sub !== 'string' || !SUBJECT.test(payload.sub) ||
        typeof payload.azp !== 'string' || !this.policy.clients.includes(payload.azp) || payload.typ !== 'Bearer') throw new Error();
      return Object.freeze({userId: payload.sub, clientId: payload.azp});
    } catch {
      throw unauthorized();
    }
  }
}
