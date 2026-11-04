import {Logger} from '@nestjs/common';
import {canonicalTimezone} from '../assistant-config/timezone';
import type {ActivationRequestV1, ActivationResponseV1, OAuthCallbackRequestV1, OAuthCallbackResponseV1} from '../contracts/v1';
import {invalidRequest, serviceUnavailable} from '../domain/errors';
import {buildAuthorizeUrl, IDEMPOTENCY_KEY, sha256hex, type AuthorizeParams, type OAuthFlowSecrets} from '../oauth/authorize';
import {OAuthTokenError, type OAuthTokenApi} from '../oauth/token-client';
import type {AssistantRepository} from '../persistence/assistant-repository';
import type {CredentialRecovery} from '../renewal/credential-renewal';
import type {FieldCipher} from '../security/field-cipher';
import type {IdentityVerifier} from '../security/identity';
import {toAssistantState} from '../state/assistant-state';
import type {Provisioner} from './provisioner';

export const ACTIVATION_SERVICE = Symbol('ACTIVATION_SERVICE');

export interface ActivationDeps {
  repository: AssistantRepository;
  cipher: FieldCipher;
  secrets: OAuthFlowSecrets;
  tokens: OAuthTokenApi;
  /** Verifica el access token del asistente: iss público, azp=cliente del asistente, aud=MCP. */
  assistantTokens: IdentityVerifier;
  provisioner: Provisioner;
  authorize: AuthorizeParams;
  flowTtlMs: number;
  /** Recuperación de una credencial caída por SSO silencioso (OCB-009). Opcional. */
  recovery?: CredentialRecovery;
  now?: () => Date;
}

/**
 * Activación en un clic (OCB-007): `POST /assistants/me/activation` y
 * `POST /assistants/oauth/callback`. Nunca registra code, state, verifier ni
 * tokens; los eventos llevan solo el tipo de fallo.
 */
export class ActivationService {
  private readonly logger = new Logger('activation');
  private readonly now: () => Date;

  constructor(private readonly deps: ActivationDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Idempotente por usuario y por Idempotency-Key: si ya hay asistente devuelve
   * su estado; si falta el acceso devuelve la authorize_url (la misma para la
   * misma key). Nunca crea una segunda fila ni una segunda VM.
   *
   * `input.timezone` (OCB-016, opcional): la zona del navegador. Se guarda si el
   * asistente aún no tiene una o si la VM todavía no existe; viaja en el
   * `hermes-config` de la VM nueva. Después la cambia `PUT /timezone`.
   */
  async activate(userId: string, idempotencyKey: unknown, input: ActivationRequestV1 = {}): Promise<ActivationResponseV1> {
    if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(idempotencyKey)) throw invalidRequest();
    const timezone = input.timezone === undefined ? null : canonicalTimezone(input.timezone);
    if (input.timezone !== undefined && !timezone) throw invalidRequest();
    const {repository, cipher, secrets} = this.deps;
    const now = this.now();
    const activation = await repository.startActivation(userId, now);
    const {started} = activation;
    let {row} = activation;
    if (started) await repository.appendEvent({userId, kind: 'activation.started', phase: 'activation'});
    if (timezone && row.timezone !== timezone) row = await repository.setActivationTimezone(userId, timezone, now) ?? row;

    // Primer acceso, o (OCB-009) el refresh guardado murió: mismo salto SSO silencioso.
    const recovering = !!row.instance_name && (row.status === 'ready' || row.status === 'activating')
      && !!(await this.deps.recovery?.needsSso(userId));
    if ((row.status === 'activating' && row.step === 'preparing_access') || recovering) {
      await repository.deleteExpiredFlows(userId, now);
      const flow = secrets.derive(userId, idempotencyKey);
      await repository.saveFlow(sha256hex(flow.state), userId,
        cipher.seal('oauth_flows.verifier_enc', userId, flow.verifier),
        new Date(now.getTime() + this.deps.flowTtlMs));
      return {authorize_url: buildAuthorizeUrl(this.deps.authorize, flow)};
    }
    // Acceso ya concedido pero sin VM (p. ej. el pod se reinició tras el callback): reanuda.
    if (row.status === 'activating' && row.step === 'preparing_environment' && !row.instance_name) {
      this.logger.log('activation resumed');
      this.deps.provisioner.start(userId, null);
    }
    return toAssistantState(row, now);
  }

  /**
   * El BFF manda {code, state} con el Bearer web. Se exige: flujo vigente del
   * mismo usuario, canje ok, y token con sub = usuario, azp = cliente del
   * asistente e iss público. Cualquier fallo → 400/503 sin credencial guardada
   * y con un evento oauth.*.
   */
  async callback(userId: string, input: OAuthCallbackRequestV1): Promise<OAuthCallbackResponseV1> {
    const {repository, cipher} = this.deps;
    const stateHash = sha256hex(input.state);
    const flow = await repository.consumeFlow(stateHash, userId);
    if (!flow) {
      const foreign = await repository.flowExists(stateHash);
      await this.oauthFailed(userId, foreign ? 'oauth.user_mismatch' : 'oauth.state_invalid', 'state');
      throw invalidRequest();
    }
    if (flow.expires_at.getTime() <= this.now().getTime()) {
      await this.oauthFailed(userId, 'oauth.state_expired', 'state');
      throw invalidRequest();
    }

    let tokens;
    try {
      tokens = await this.deps.tokens.exchangeCode({
        code: input.code,
        verifier: cipher.open('oauth_flows.verifier_enc', userId, flow.verifier_enc),
      });
    } catch (error) {
      const known = error instanceof OAuthTokenError;
      await this.oauthFailed(userId, 'oauth.exchange_failed', 'exchange', known ? `kind=${error.kind} reason=${error.reason}` : 'reason=other');
      throw known && error.kind === 'rejected' ? invalidRequest() : serviceUnavailable();
    }

    let subject: string | null = null;
    try {
      subject = (await this.deps.assistantTokens.verify(`Bearer ${tokens.accessToken}`)).userId;
    } catch {
      subject = null;
    }
    if (subject !== userId) {
      await this.oauthFailed(userId, 'oauth.token_rejected', 'verify', subject ? 'reason=sub_mismatch' : 'reason=invalid_token');
      throw invalidRequest();
    }

    const now = this.now();
    const granted = await repository.grantAccess(userId,
      cipher.seal('assistant_credentials.refresh_token_enc', userId, tokens.refreshToken),
      new Date(now.getTime() + tokens.expiresIn * 1000), now);
    if (!granted && await this.deps.recovery?.acceptRecoveredGrant(userId, tokens)) return {ok: true};
    if (!granted) {
      // Otro callback ya concedió el acceso o la VM ya existe: no se pisa la credencial vigente.
      await repository.appendEvent({userId, kind: 'oauth.discarded', phase: 'callback'});
      return {ok: true};
    }
    await repository.appendEvent({userId, kind: 'oauth.completed', phase: 'callback'});
    this.logger.log('oauth completed');
    this.deps.provisioner.start(userId, tokens);
    return {ok: true};
  }

  private async oauthFailed(userId: string, kind: string, phase: string, detail?: string): Promise<void> {
    await this.deps.repository.appendEvent({userId, kind, phase, cause: 'oauth_failed', detail: detail ?? null});
    this.logger.warn(`oauth failed kind=${kind}${detail ? ` ${detail}` : ''}`);
  }
}
