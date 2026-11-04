import {generateSecret, SignJWT} from 'jose';
import {ServiceError} from '../src/domain/errors';
import {IdentityVerifier} from '../src/security/identity';
import {ISSUER, testKeys, USER_ID, type TestKeys} from './support/tokens';

describe('IdentityVerifier (token web de Keycloak dev)', () => {
  let keys: TestKeys;
  const policy = {issuer: ISSUER, audience: '', clients: ['front']};
  beforeAll(async () => {keys = await testKeys();});

  const rejects = async (verifier: IdentityVerifier, header: unknown) => {
    await expect(verifier.verify(header)).rejects.toMatchObject({code: 'UNAUTHORIZED', status: 401});
    await expect(verifier.verify(header)).rejects.toBeInstanceOf(ServiceError);
  };

  it('acepta un token de `front` sin mapper de audiencia y expone el sub', async () => {
    const verifier = new IdentityVerifier(policy, keys.jwks);
    const principal = await verifier.verify(`Bearer ${await keys.sign()}`);
    expect(principal).toEqual({userId: USER_ID, clientId: 'front'});
  });

  it('rechaza con 401 un token del cliente del asistente (azp=mcp-saleads-assistant-dev)', async () => {
    await rejects(new IdentityVerifier(policy, keys.jwks), `Bearer ${await keys.sign({azp: 'mcp-saleads-assistant-dev'})}`);
  });

  it('rechaza sin cabecera, con esquema distinto de Bearer o con basura', async () => {
    const verifier = new IdentityVerifier(policy, keys.jwks);
    await rejects(verifier, undefined);
    await rejects(verifier, '');
    await rejects(verifier, `Basic ${await keys.sign()}`);
    await rejects(verifier, 'Bearer not-a-jwt');
  });

  it('rechaza issuer distinto, typ distinto de Bearer y token vencido', async () => {
    const verifier = new IdentityVerifier(policy, keys.jwks);
    await rejects(new IdentityVerifier({...policy, issuer: 'https://keycloak.saleads.ai/realms/sale-ads'}, keys.jwks), `Bearer ${await keys.sign()}`);
    await rejects(verifier, `Bearer ${await keys.sign({typ: 'Refresh'})}`);
    await rejects(verifier, `Bearer ${await keys.sign({}, {expiresIn: '-1m'})}`);
  });

  it('rechaza algoritmos distintos de RS256 (HS256 con secreto)', async () => {
    const secret = await generateSecret('HS256');
    const token = await new SignJWT({azp: 'front', typ: 'Bearer'}).setProtectedHeader({alg: 'HS256'})
      .setIssuer(ISSUER).setSubject(USER_ID).setIssuedAt().setExpirationTime('5m').sign(secret);
    await rejects(new IdentityVerifier(policy, keys.jwks), `Bearer ${token}`);
  });

  it('valida la audiencia solo si está configurada', async () => {
    const withAudience = new IdentityVerifier({...policy, audience: 'sa-assistant-service'}, keys.jwks);
    await rejects(withAudience, `Bearer ${await keys.sign()}`);
    await expect(withAudience.verify(`Bearer ${await keys.sign({aud: 'sa-assistant-service'})}`)).resolves.toMatchObject({userId: USER_ID});
  });

  it('rechaza un sub con formato inválido', async () => {
    await rejects(new IdentityVerifier(policy, keys.jwks), `Bearer ${await keys.sign({sub: '../etc'})}`);
  });
});
