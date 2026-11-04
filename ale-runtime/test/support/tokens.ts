import {createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload, type JWTVerifyGetKey} from 'jose';

export const ISSUER = 'https://keycloak-dev.saleads.ai/realms/sale-ads';
export const USER_ID = 'f3c1a2b4-1111-4222-8333-944455556666';

export interface TestKeys {
  jwks: JWTVerifyGetKey;
  sign(claims?: JWTPayload, options?: {alg?: string; expiresIn?: string}): Promise<string>;
}

/** Firma tokens con la forma del token web de Keycloak dev (cliente `front`, sin `aud`). */
export async function testKeys(): Promise<TestKeys> {
  const {privateKey, publicKey} = await generateKeyPair('RS256');
  const jwk = {...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256', use: 'sig'};
  return {
    jwks: createLocalJWKSet({keys: [jwk]}),
    async sign(claims = {}, options = {}) {
      return new SignJWT({azp: 'front', typ: 'Bearer', ...claims})
        .setProtectedHeader({alg: options.alg ?? 'RS256', kid: 'test'})
        .setIssuer(ISSUER)
        .setSubject(typeof claims.sub === 'string' ? claims.sub : USER_ID)
        .setIssuedAt()
        .setExpirationTime(options.expiresIn ?? '5m')
        .sign(privateKey);
    },
  };
}
