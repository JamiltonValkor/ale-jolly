import {randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {exportJWK, generateKeyPair, importJWK, jwtVerify, SignJWT, type JWK, type JWTPayload, type KeyLike} from 'jose';

/**
 * Llave RS256 del realm simulado. Se genera una vez y se guarda en el
 * directorio de datos para que un reinicio no invalide los tokens que ya
 * tienen ale-runtime y Hermes (Keycloak tampoco rota su llave al reiniciar).
 */
export class RealmKeys {
  private constructor(
    private readonly privateKey: KeyLike,
    private readonly publicKey: KeyLike,
    private readonly publicJwk: JWK,
    readonly kid: string,
  ) {}

  static async load(dataDir: string): Promise<RealmKeys> {
    const path = join(dataDir, 'realm-key.json');
    let stored: {kid: string; privateJwk: JWK} | null = null;
    if (existsSync(path)) stored = JSON.parse(readFileSync(path, 'utf8'));
    if (!stored) {
      const pair = await generateKeyPair('RS256', {modulusLength: 2048, extractable: true});
      stored = {kid: randomUUID(), privateJwk: await exportJWK(pair.privateKey)};
      mkdirSync(dataDir, {recursive: true});
      writeFileSync(path, JSON.stringify(stored), {mode: 0o600});
    }
    const {d, p, q, dp, dq, qi, ...publicPart} = stored.privateJwk;
    void d; void p; void q; void dp; void dq; void qi;
    const publicJwk: JWK = {...publicPart, kid: stored.kid, alg: 'RS256', use: 'sig'};
    const privateKey = await importJWK({...stored.privateJwk, alg: 'RS256'}, 'RS256') as KeyLike;
    const publicKey = await importJWK(publicJwk, 'RS256') as KeyLike;
    return new RealmKeys(privateKey, publicKey, publicJwk, stored.kid);
  }

  jwks(): {keys: JWK[]} {
    return {keys: [this.publicJwk]};
  }

  sign(payload: JWTPayload, ttlSeconds: number, typ = 'JWT'): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT(payload)
      .setProtectedHeader({alg: 'RS256', kid: this.kid, typ})
      .setIssuedAt(now)
      .setExpirationTime(now + ttlSeconds)
      .setJti(randomUUID())
      .sign(this.privateKey);
  }

  async verify(token: string, options: {issuer: string; audience?: string}): Promise<JWTPayload> {
    const {payload} = await jwtVerify(token, this.publicKey, {
      algorithms: ['RS256'],
      issuer: options.issuer,
      ...(options.audience ? {audience: options.audience} : {}),
      clockTolerance: 5,
    });
    return payload;
  }
}
