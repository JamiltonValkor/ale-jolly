import assert from 'node:assert/strict';
import {after, before, describe, it} from 'node:test';
import {createRemoteJWKSet, jwtVerify} from 'jose';
import {assistantTokens, pkce, REDIRECT, start, type Harness} from './helpers';

/**
 * Keycloak simulado. Las verificaciones de tokens repiten las reglas exactas
 * de ale-runtime `src/security/identity.ts` (web y asistente), con su JWKS remoto.
 */

const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
async function aleRuntimeVerify(h: Harness, token: string, policy: {audience: string; clients: string[]}) {
  const keys = createRemoteJWKSet(new URL(`${h.base}/realms/sale-ads/protocol/openid-connect/certs`));
  const {payload} = await jwtVerify(token, keys, {
    algorithms: ['RS256'], issuer: h.app.config.issuer, ...(policy.audience ? {audience: policy.audience} : {}),
    requiredClaims: ['exp', 'iat', 'sub'], clockTolerance: 5,
  });
  if (typeof payload.sub !== 'string' || !SUBJECT.test(payload.sub) || typeof payload.azp !== 'string'
    || !policy.clients.includes(payload.azp) || payload.typ !== 'Bearer') throw new Error('rejected');
  return payload;
}

const form = (h: Harness, path: string, body: Record<string, string>) => fetch(`${h.base}/realms/sale-ads/protocol/openid-connect/${path}`, {
  method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams(body),
});

describe('OIDC simulado', () => {
  let h: Harness;
  before(async () => {h = await start();});
  after(() => h.close());

  it('sirve discovery, JWKS y la metadata del recurso MCP', async () => {
    for (const path of ['/realms/sale-ads/.well-known/openid-configuration', '/.well-known/oauth-authorization-server/realms/sale-ads']) {
      const doc = await (await fetch(`${h.base}${path}`)).json() as Record<string, any>;
      assert.equal(doc.issuer, 'https://saleads.local/realms/sale-ads');
      assert.ok(doc.code_challenge_methods_supported.includes('S256'));
      assert.match(doc.token_endpoint, /\/protocol\/openid-connect\/token$/);
    }
    const jwks = await (await fetch(`${h.base}/realms/sale-ads/protocol/openid-connect/certs`)).json() as {keys: Array<Record<string, string>>};
    assert.equal(jwks.keys[0].alg, 'RS256');
    assert.equal(jwks.keys[0].d, undefined);
    const prm = await (await fetch(`${h.base}/.well-known/oauth-protected-resource`)).json() as Record<string, any>;
    assert.equal(prm.resource, 'https://saleads.local/mcp');
    assert.deepEqual(prm.authorization_servers, ['https://saleads.local/realms/sale-ads']);
  });

  it('emite el token del asistente con PKCE y prompt=none, y ale-runtime lo acepta', async () => {
    const {location, status, body} = await assistantTokens(h);
    assert.equal(location.searchParams.get('state'), 'state-123');
    assert.equal(location.origin + location.pathname, REDIRECT);
    assert.equal(status, 200);
    assert.equal(body.token_type, 'bearer');
    assert.ok(body.refresh_token && body.expires_in > 0);
    assert.match(body.scope, /saleads:launch/);
    const payload = await aleRuntimeVerify(h, body.access_token, {audience: 'https://saleads.local/mcp', clients: ['mcp-saleads-assistant-dev']});
    assert.equal(payload.sub, '00000000-0000-4000-a000-000000000001');
    // El token del asistente no es un token web (identity.ts: 401).
    await assert.rejects(aleRuntimeVerify(h, body.access_token, {audience: '', clients: ['front']}));
  });

  it('rechaza un code_verifier incorrecto y un code reutilizado', async () => {
    const {verifier, challenge} = pkce();
    const res = await fetch(`${h.base}/realms/sale-ads/protocol/openid-connect/auth?${new URLSearchParams({
      response_type: 'code', client_id: 'mcp-saleads-assistant-dev', redirect_uri: REDIRECT, scope: 'openid', state: 's',
      code_challenge: challenge, code_challenge_method: 'S256', prompt: 'none'})}`, {redirect: 'manual'});
    const code = new URL(res.headers.get('location')!).searchParams.get('code')!;
    const bad = await form(h, 'token', {grant_type: 'authorization_code', code, code_verifier: `${verifier}x`, redirect_uri: REDIRECT, client_id: 'mcp-saleads-assistant-dev'});
    assert.equal(bad.status, 400);
    assert.equal((await bad.json() as any).error, 'invalid_grant');
    const again = await form(h, 'token', {grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: 'mcp-saleads-assistant-dev'});
    assert.equal(again.status, 400);
  });

  it('rechaza un redirect_uri que no está permitido', async () => {
    const {challenge} = pkce();
    const res = await fetch(`${h.base}/realms/sale-ads/protocol/openid-connect/auth?${new URLSearchParams({
      response_type: 'code', client_id: 'mcp-saleads-assistant-dev', redirect_uri: 'https://evil.example/cb', scope: 'openid',
      code_challenge: challenge, code_challenge_method: 'S256'})}`, {redirect: 'manual'});
    assert.equal(res.status, 400);
  });

  it('renueva con refresh_token (Hermes) y deja de renovar tras revocar la sesión offline', async () => {
    const {body} = await assistantTokens(h);
    const refreshed = await form(h, 'token', {grant_type: 'refresh_token', refresh_token: body.refresh_token, client_id: 'mcp-saleads-assistant-dev'});
    assert.equal(refreshed.status, 200);
    const next = await refreshed.json() as Record<string, any>;
    assert.equal(next.token_type, 'bearer');
    assert.equal(next.scope, body.scope);
    await aleRuntimeVerify(h, next.access_token, {audience: 'https://saleads.local/mcp', clients: ['mcp-saleads-assistant-dev']});
    // Otro cliente no puede usar el refresh.
    assert.equal((await form(h, 'token', {grant_type: 'refresh_token', refresh_token: next.refresh_token, client_id: 'front'})).status, 400);
    const revoked = await form(h, 'revoke', {token: next.refresh_token, token_type_hint: 'refresh_token', client_id: 'mcp-saleads-assistant-dev'});
    assert.equal(revoked.status, 200);
    // Revocar cierra la sesión offline entera: también el refresh anterior.
    assert.equal((await form(h, 'token', {grant_type: 'refresh_token', refresh_token: body.refresh_token, client_id: 'mcp-saleads-assistant-dev'})).status, 400);
    // RFC 7009: un token basura también es 200.
    assert.equal((await form(h, 'revoke', {token: 'basura', client_id: 'mcp-saleads-assistant-dev'})).status, 200);
  });

  it('emite la sesión demo (D7) con un token web que ale-runtime acepta', async () => {
    const session = await (await fetch(`${h.base}/sim/session`)).json() as Record<string, any>;
    assert.equal(session.simulated, true);
    assert.equal(session.user.id, '00000000-0000-4000-a000-000000000001');
    const payload = await aleRuntimeVerify(h, session.access_token, {audience: '', clients: ['front']});
    assert.equal(payload.azp, 'front');
    assert.equal((payload as Record<string, unknown>).businesses, undefined);
    // El token web no sirve en el MCP.
    const mcp = await fetch(`${h.base}/mcp`, {method: 'POST', headers: {authorization: `Bearer ${session.access_token}`, 'content-type': 'application/json'}, body: '{}'});
    assert.equal(mcp.status, 401);
  });
});
