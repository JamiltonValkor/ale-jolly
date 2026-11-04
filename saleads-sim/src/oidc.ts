import {createHash, randomBytes, randomUUID} from 'node:crypto';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {SALEADS_SCOPES, type SimConfig} from './config';
import {readForm, redirect, sendJson, sendText, bearer, escapeHtml} from './http-util';
import type {RealmKeys} from './keys';
import type {Store} from './store';

/**
 * Keycloak simulado del realm `sale-ads`: lo justo que usan ale-runtime,
 * Hermes (cliente MCP en la VM) y el front.
 *
 * - Discovery OIDC/RFC 8414 y JWKS RS256.
 * - `authorize` con PKCE S256 y `prompt=none`: la sesión SSO es siempre la del
 *   usuario demo (no hay pantalla de login en la demo).
 * - `token`: `authorization_code` y `refresh_token`. Las respuestas traen
 *   `access_token`, `refresh_token`, `token_type=bearer`, `expires_in` y `scope`.
 * - `revoke` (RFC 7009): siempre 200; revocar un refresh cierra su sesión offline.
 *
 * Claims del token del asistente: `iss`, `aud = MCP_URL`, `azp =
 * mcp-saleads-assistant-dev`, `typ = Bearer`, `sub`, `scope`. Del token web:
 * `azp = front`, `typ = Bearer`, sin negocios.
 */

const OPTIONAL_SCOPES = new Set<string>(['openid', 'offline_access', 'saleads-mcp', 'email', 'profile', ...SALEADS_SCOPES]);

interface PendingCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
  scope: string;
  userId: string;
  sid: string;
  nonce: string | null;
  expiresAt: number;
}

export interface IssuedTokens {
  access_token: string;
  expires_in: number;
  refresh_expires_in: number;
  refresh_token: string;
  token_type: 'bearer';
  id_token?: string;
  'not-before-policy': 0;
  session_state: string;
  scope: string;
}

const oauthError = (res: ServerResponse, status: number, error: string, description: string) =>
  sendJson(res, status, {error, error_description: description});

export class Oidc {
  private readonly codes = new Map<string, PendingCode>();

  constructor(private readonly config: SimConfig, private readonly keys: RealmKeys, private readonly store: Store) {}

  get realmPath(): string {
    return `/realms/${this.config.realm}`;
  }

  discovery() {
    const {issuer} = this.config;
    const oidc = `${issuer}/protocol/openid-connect`;
    return {
      issuer,
      authorization_endpoint: `${this.config.authorizeBaseUrl}/protocol/openid-connect/auth`,
      token_endpoint: `${oidc}/token`,
      introspection_endpoint: `${oidc}/token/introspect`,
      userinfo_endpoint: `${oidc}/userinfo`,
      end_session_endpoint: `${oidc}/logout`,
      jwks_uri: `${oidc}/certs`,
      revocation_endpoint: `${oidc}/revoke`,
      grant_types_supported: ['authorization_code', 'refresh_token', 'password'],
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: [...OPTIONAL_SCOPES],
      claims_supported: ['sub', 'iss', 'aud', 'azp', 'typ', 'scope', 'email', 'name', 'preferred_username'],
    };
  }

  /** RFC 9728 del MCP (mismo documento que sa-mcp-server `ProtectedResourceController`). */
  protectedResource() {
    return {
      resource: this.config.mcpUrl,
      authorization_servers: [this.config.issuer],
      scopes_supported: [...SALEADS_SCOPES],
      bearer_methods_supported: ['header'],
      resource_name: 'SaleADS',
    };
  }

  /** Atiende las rutas OIDC. Devuelve false si la ruta no es suya. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;
    const realm = this.realmPath;
    const wellKnown = new Set([
      `${realm}/.well-known/openid-configuration`,
      `${realm}/.well-known/oauth-authorization-server`,
      `/.well-known/oauth-authorization-server${realm}`,
      `/.well-known/openid-configuration${realm}`,
    ]);
    if (req.method === 'GET' && wellKnown.has(path)) {
      sendJson(res, 200, this.discovery(), {'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*'});
      return true;
    }
    if (req.method === 'GET' && (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp')) {
      sendJson(res, 200, this.protectedResource(), {'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*'});
      return true;
    }
    const oidc = `${realm}/protocol/openid-connect`;
    if (path === `${oidc}/certs` && req.method === 'GET') {
      sendJson(res, 200, this.keys.jwks(), {'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*'});
      return true;
    }
    if (path === `${oidc}/auth` && req.method === 'GET') {
      this.authorize(res, url);
      return true;
    }
    if (path === `${oidc}/token` && req.method === 'POST') {
      await this.token(req, res);
      return true;
    }
    if (path === `${oidc}/revoke` && req.method === 'POST') {
      await this.revoke(req, res);
      return true;
    }
    if (path === `${oidc}/userinfo`) {
      await this.userinfo(req, res);
      return true;
    }
    if (path === '/sim/session' && (req.method === 'GET' || req.method === 'POST')) {
      sendJson(res, 200, await this.demoSession());
      return true;
    }
    return false;
  }

  private redirectAllowed(uri: string): boolean {
    try {
      const parsed = new URL(uri);
      if (parsed.hash || !['http:', 'https:'].includes(parsed.protocol)) return false;
    } catch {
      return false;
    }
    return this.config.redirectPrefixes.some((prefix) => uri === prefix || uri.startsWith(prefix));
  }

  private knownClient(clientId: string | null): boolean {
    return clientId === this.config.assistantClientId || clientId === this.config.webClientId;
  }

  private grantedScope(requested: string | null): string {
    const wanted = (requested ?? 'openid').split(' ').filter((s) => OPTIONAL_SCOPES.has(s));
    return [...new Set(['openid', ...wanted])].join(' ');
  }

  private authorize(res: ServerResponse, url: URL): void {
    const q = url.searchParams;
    const clientId = q.get('client_id');
    const redirectUri = q.get('redirect_uri') ?? '';
    if (!this.knownClient(clientId)) {
      sendText(res, 400, page('Cliente no válido', 'El cliente OAuth no existe en el realm simulado.'), 'text/html; charset=utf-8');
      return;
    }
    if (!this.redirectAllowed(redirectUri)) {
      sendText(res, 400, page('Redirect no válido', `El redirect_uri no está permitido: ${escapeHtml(redirectUri)}`), 'text/html; charset=utf-8');
      return;
    }
    const back = (params: Record<string, string>) => {
      const target = new URL(redirectUri);
      for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
      if (q.get('state') !== null) target.searchParams.set('state', q.get('state')!);
      target.searchParams.set('iss', this.config.issuer);
      redirect(res, target.toString());
    };
    if (q.get('response_type') !== 'code') return back({error: 'unsupported_response_type'});
    const challenge = q.get('code_challenge');
    if (q.get('code_challenge_method') !== 'S256' || !challenge || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
      return back({error: 'invalid_request', error_description: 'Missing parameter: code_challenge_method'});
    }
    // La sesión SSO de la demo es siempre la del usuario demo, también con prompt=none.
    const code = randomBytes(32).toString('base64url');
    const sid = randomUUID();
    this.codes.set(code, {
      clientId: clientId!, redirectUri, challenge, scope: this.grantedScope(q.get('scope')),
      userId: this.config.demoUserId, sid, nonce: q.get('nonce'), expiresAt: Date.now() + 60_000,
    });
    back({code, session_state: sid});
  }

  private async token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = await readForm(req);
    const clientId = form.get('client_id') ?? basicClient(req);
    if (!this.knownClient(clientId)) return oauthError(res, 401, 'invalid_client', 'Invalid client or Invalid client credentials');
    const grant = form.get('grant_type');
    if (grant === 'authorization_code') {
      const code = form.get('code') ?? '';
      const pending = this.codes.get(code);
      this.codes.delete(code);
      if (!pending || pending.expiresAt < Date.now()) return oauthError(res, 400, 'invalid_grant', 'Code not valid');
      if (pending.clientId !== clientId) return oauthError(res, 400, 'invalid_grant', 'Code not valid');
      if (pending.redirectUri !== form.get('redirect_uri')) return oauthError(res, 400, 'invalid_grant', 'Incorrect redirect_uri');
      const verifier = form.get('code_verifier') ?? '';
      if (createHash('sha256').update(verifier, 'ascii').digest('base64url') !== pending.challenge) {
        return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed: Invalid code verifier');
      }
      sendJson(res, 200, await this.issue(clientId!, pending.userId, pending.scope, pending.sid, pending.nonce));
      return;
    }
    if (grant === 'refresh_token') {
      const presented = form.get('refresh_token') ?? '';
      let claims: Record<string, unknown>;
      try {
        claims = await this.keys.verify(presented, {issuer: this.config.issuer});
      } catch {
        return oauthError(res, 400, 'invalid_grant', 'Invalid refresh token');
      }
      const sid = typeof claims.sid === 'string' ? claims.sid : '';
      if (!['Refresh', 'Offline'].includes(String(claims.typ)) || claims.azp !== clientId) {
        return oauthError(res, 400, 'invalid_grant', 'Invalid refresh token. Token client and authorized client don\'t match');
      }
      if (this.store.state.revokedSessions[sid] || this.store.state.revokedTokens[String(claims.jti)]) {
        return oauthError(res, 400, 'invalid_grant', 'Session not active');
      }
      const original = String(claims.scope ?? '').split(' ').filter(Boolean);
      const asked = form.get('scope');
      const scope = asked ? asked.split(' ').filter((s) => original.includes(s)).join(' ') : original.join(' ');
      sendJson(res, 200, await this.issue(clientId!, String(claims.sub), scope, sid, null));
      return;
    }
    if (grant === 'password') {
      // Login directo del front (D7): solo el cliente `front` y solo el usuario demo; la contraseña no se valida (demo).
      if (clientId !== this.config.webClientId) return oauthError(res, 400, 'unauthorized_client', 'Client not allowed for direct access grants');
      if (!['demo-owner', this.config.demoUserEmail, this.config.demoUserId].includes(form.get('username') ?? '')) {
        return oauthError(res, 401, 'invalid_grant', 'Invalid user credentials');
      }
      sendJson(res, 200, await this.issue(clientId!, this.config.demoUserId, this.grantedScope(form.get('scope')), randomUUID(), null));
      return;
    }
    oauthError(res, 400, 'unsupported_grant_type', 'Unsupported grant_type');
  }

  /** RFC 7009: un token inválido o desconocido también responde 200. */
  private async revoke(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = await readForm(req);
    const clientId = form.get('client_id') ?? basicClient(req);
    if (!this.knownClient(clientId)) return oauthError(res, 401, 'invalid_client', 'Invalid client or Invalid client credentials');
    try {
      const claims = await this.keys.verify(form.get('token') ?? '', {issuer: this.config.issuer});
      const now = new Date().toISOString();
      if (typeof claims.jti === 'string') this.store.state.revokedTokens[claims.jti] = now;
      // Revocar el refresh (offline) cierra la sesión offline entera, como Keycloak.
      if (['Refresh', 'Offline'].includes(String(claims.typ)) && typeof claims.sid === 'string') this.store.state.revokedSessions[claims.sid] = now;
      this.store.save();
    } catch {/* token ya inválido: 200 igual */}
    res.writeHead(200, {'cache-control': 'no-store'});
    res.end();
  }

  private async userinfo(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const token = bearer(req);
    try {
      const claims = await this.keys.verify(token ?? '', {issuer: this.config.issuer});
      if (claims.typ !== 'Bearer') throw new Error();
      sendJson(res, 200, {sub: claims.sub, email: claims.email, name: claims.name, preferred_username: claims.preferred_username, email_verified: true});
    } catch {
      sendJson(res, 401, {error: 'invalid_token', error_description: 'Token verification failed'}, {'www-authenticate': 'Bearer error="invalid_token"'});
    }
  }

  private userClaims(userId: string) {
    const demo = userId === this.config.demoUserId;
    return {
      email: demo ? this.config.demoUserEmail : `${userId}@saleads.local`,
      name: demo ? this.config.demoUserName : 'Usuario local (simulado)',
      preferred_username: demo ? 'demo-owner' : userId,
      email_verified: true,
    };
  }

  /** Emite el par de tokens de un cliente. El access token del asistente lleva `aud = MCP_URL`. */
  async issue(clientId: string, userId: string, scope: string, sid: string, nonce: string | null): Promise<IssuedTokens> {
    const assistant = clientId === this.config.assistantClientId;
    const ttl = assistant ? this.config.accessTokenTtlS : this.config.webTokenTtlS;
    const common = {iss: this.config.issuer, sub: userId, azp: clientId, sid, session_state: sid};
    const access = await this.keys.sign({
      ...common, typ: 'Bearer', aud: assistant ? [this.config.mcpUrl] : ['account'], scope, ...this.userClaims(userId),
    }, ttl);
    const offline = scope.split(' ').includes('offline_access');
    const refresh = await this.keys.sign({...common, typ: offline ? 'Offline' : 'Refresh', aud: this.config.issuer, scope}, this.config.refreshTokenTtlS);
    const idToken = scope.split(' ').includes('openid')
      ? await this.keys.sign({...common, typ: 'ID', aud: clientId, ...(nonce ? {nonce} : {}), ...this.userClaims(userId)}, ttl)
      : undefined;
    return {
      access_token: access, expires_in: ttl, refresh_expires_in: offline ? 0 : this.config.refreshTokenTtlS, refresh_token: refresh,
      token_type: 'bearer', ...(idToken ? {id_token: idToken} : {}), 'not-before-policy': 0, session_state: sid, scope,
    };
  }

  /** Sesión web del usuario demo (D7): el JWT RS256 de `front` que ale-runtime acepta. */
  async demoSession() {
    const tokens = await this.issue(this.config.webClientId, this.config.demoUserId, 'openid email profile', randomUUID(), null);
    return {
      simulated: true,
      user: {id: this.config.demoUserId, ...this.userClaims(this.config.demoUserId)},
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      id_token: tokens.id_token,
      token_type: 'Bearer',
      expires_in: tokens.expires_in,
      expires_at: Math.floor(Date.now() / 1000) + tokens.expires_in,
    };
  }
}

function basicClient(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  return decodeURIComponent(decoded.split(':')[0] ?? '') || null;
}

function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><h1>${escapeHtml(title)}</h1><p>${body}</p><p><small>Keycloak simulado de saleads-sim.</small></p>`;
}
