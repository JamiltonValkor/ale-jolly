import {Logger} from '@nestjs/common';
import {hermesMcpTokens} from '../activation/hermes-files';
import {ComputeError} from '../compute/compute-client';
import {OAuthTokenError, type AssistantTokenSet, type OAuthTokenApi} from '../oauth/token-client';
import type {OAuthRevocationApi} from '../oauth/revoke-client';
import type {AssistantRepository, AssistantRow, CauseCode} from '../persistence/assistant-repository';
import type {FieldCipher} from '../security/field-cipher';
import {credentialHealth, type CredentialStore} from './credential-store';
import type {InstanceMetadataApi} from './instance-metadata';

/** Quién pidió la renovación (va en `detail_safe` y en los logs). */
export type RenewalTrigger = 'sweep' | 'before_start' | 'mcp_failure' | 'state_read';

/**
 * Causas exactas de OCB-009. El CHECK de V1 no las admite, así que se guardan
 * en `detail_safe` (`cause=<causa>`) y `cause_code` lleva la equivalente de V1:
 * refresh_invalid_grant/refresh_network → refresh_failed,
 * metadata_write_failed → config_apply_failed, sso_silent_required → login_required.
 */
export type RenewalFailureCause = 'refresh_invalid_grant' | 'refresh_network' | 'metadata_write_failed' | 'sso_silent_required';
const V1_CAUSE: Record<RenewalFailureCause, CauseCode> = {
  refresh_invalid_grant: 'refresh_failed',
  refresh_network: 'refresh_failed',
  metadata_write_failed: 'config_apply_failed',
  sso_silent_required: 'login_required',
};

export type RenewalOutcome =
  | {result: 'renewed'}
  | {result: 'sso_required'}
  | {result: 'retry_later'; cause: 'refresh_network' | 'metadata_write_failed'}
  | {result: 'skipped'; reason: 'no_assistant' | 'no_instance' | 'not_renewable' | 'awaiting_sso'};

export type RevokeOutcome =
  | {result: 'revoked'}
  | {result: 'no_credential'}
  | {result: 'failed'; reason: string};

/**
 * Lo que la activación (OCB-007) necesita para recuperar una credencial caída
 * con el salto SSO silencioso, sin pantalla de autorización.
 */
export interface CredentialRecovery {
  /** true si el refresh guardado ya no sirve y la próxima apertura debe hacer el salto SSO. */
  needsSso(userId: string): Promise<boolean>;
  /** Acepta los tokens de un callback de recuperación: guarda el refresh y resiembra la VM. */
  acceptRecoveredGrant(userId: string, tokens: AssistantTokenSet): Promise<boolean>;
}

export interface CredentialRenewalDeps {
  repository: AssistantRepository;
  store: CredentialStore;
  cipher: FieldCipher;
  tokens: OAuthTokenApi;
  revocation: OAuthRevocationApi;
  metadata: InstanceMetadataApi;
  /** Issuer PÚBLICO (va en `hermes_issuer` del archivo de tokens). */
  issuer: string;
  /** Zona por defecto si la fila no la tiene. */
  zone: string;
  /** Ventana mínima entre dos intentos disparados por fallos del MCP o por GET /me. */
  retryDebounceMs: number;
  now?: () => Date;
}

const KEY = 'hermes-mcp-tokens';
const SAFE_TOOL = /^mcp__saleads__[A-Za-z0-9_]{1,100}$/;
const RENEWABLE: ReadonlySet<AssistantRow['status']> = new Set(['activating', 'ready', 'stopped']);

/**
 * Renovación de la credencial del asistente (OCB-009).
 *
 * Hermes es el dueño principal del refresh dentro de la VM. El servicio tiene
 * su propio refresh cifrado de la MISMA sesión offline (revokeRefreshToken=false
 * en el realm dev, G-03): usarlo no invalida la copia de Hermes. Con él:
 *
 * - renueva cada ~7 días (barrido) aunque la VM esté apagada o Hermes no use el
 *   MCP, y así la sesión offline (idle 30 días) nunca vence;
 * - resiembra `hermes-mcp-tokens` por setMetadata con fingerprint; el watcher
 *   solo reescribe el archivo cuando cambia ese valor, y Hermes relee por mtime;
 * - si Keycloak rechaza el refresh (invalid_grant) deja `needs_sso`: la próxima
 *   apertura de «Mi asistente» hace el salto SSO silencioso (prompt=none) y el
 *   callback recupera la credencial.
 *
 * Nunca registra tokens: logs y eventos llevan solo la VM, el disparador y códigos.
 */
export class CredentialRenewal implements CredentialRecovery {
  private readonly logger = new Logger('credential-renewal');
  private readonly now: () => Date;
  private readonly inFlight = new Map<string, Promise<RenewalOutcome>>();
  private readonly lastTriggered = new Map<string, number>();
  private readonly background = new Set<Promise<unknown>>();
  private readonly access = new Map<string, {token: string; expiresAt: number}>();
  private readonly accessInFlight = new Map<string, Promise<string | null>>();

  constructor(private readonly deps: CredentialRenewalDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Refresca con el refresh guardado y resiembra la VM. Idempotente: llamadas
   * concurrentes del mismo usuario comparten el mismo intento. OCB-012 la llama
   * antes de `instances.start` (`before_start`); no debe bloquear el encendido
   * si falla: el resultado queda registrado y el estado lo expone.
   */
  renew(userId: string, trigger: RenewalTrigger): Promise<RenewalOutcome> {
    const running = this.inFlight.get(userId);
    if (running) return running;
    const run = this.doRenew(userId, trigger).finally(() => this.inFlight.delete(userId));
    this.inFlight.set(userId, run);
    return run;
  }

  /**
   * Access token del MCP para el propio servicio (ORQA OSB-007, semilla). Mismo
   * flujo único: refresca con el refresh guardado de la sesión offline (no
   * invalida la copia de Hermes, revokeRefreshToken=false) y persiste el refresh
   * rotado con upsertCredential. No resiembra la VM. Se guarda en memoria hasta
   * un minuto antes de vencer. null = sin credencial utilizable (el fallo queda
   * registrado como en la renovación). El token nunca va a logs ni a eventos.
   */
  accessToken(userId: string): Promise<string | null> {
    const cached = this.access.get(userId);
    if (cached && cached.expiresAt - 60_000 > this.now().getTime()) return Promise.resolve(cached.token);
    const running = this.accessInFlight.get(userId);
    if (running) return running;
    const run = this.issueAccessToken(userId).finally(() => this.accessInFlight.delete(userId));
    this.accessInFlight.set(userId, run);
    return run;
  }

  private async issueAccessToken(userId: string): Promise<string | null> {
    const {repository, cipher, tokens} = this.deps;
    // En serie con una renovación en curso: así no hay dos refresh del mismo usuario a la vez.
    await this.inFlight.get(userId)?.catch(() => undefined);
    if (await this.needsSso(userId)) return null;
    let fresh: AssistantTokenSet;
    try {
      const sealed = await repository.readRefreshToken(userId);
      if (!sealed) return null;
      fresh = await tokens.refresh(cipher.open('assistant_credentials.refresh_token_enc', userId, sealed));
    } catch (error) {
      if (error instanceof OAuthTokenError && error.kind === 'unavailable') {
        await this.failed(userId, 'refresh_network', 'seed', `reason=${error.reason}`);
        return null;
      }
      const reason = error instanceof OAuthTokenError ? error.reason : 'credential_unreadable';
      await this.failed(userId, 'refresh_invalid_grant', 'seed', `reason=${reason}`);
      await this.failed(userId, 'sso_silent_required', 'seed', null);
      return null;
    }
    await this.saveCredential(userId, fresh);
    this.access.set(userId, {token: fresh.accessToken, expiresAt: this.now().getTime() + fresh.expiresIn * 1000});
    return fresh.accessToken;
  }

  /** Atajo para OCB-012: renovar y resembrar antes de reactivar la VM. */
  renewBeforeStart(userId: string): Promise<RenewalOutcome> {
    return this.renew(userId, 'before_start');
  }

  /**
   * Disparador del proxy de chat (OCB-011): una tool `mcp__saleads__*` falló.
   * Registra la petición y resiembra en segundo plano, con debounce por usuario.
   * Las tools nativas de Hermes (terminal, web_search…) se ignoran.
   */
  async reportMcpToolFailure(userId: string, toolName: string): Promise<void> {
    if (!SAFE_TOOL.test(toolName) || !this.claimTrigger(userId)) return;
    await this.deps.repository.appendEvent({
      userId, kind: 'credential.reseed_requested', phase: 'chat', cause: 'mcp_unavailable', detail: `tool=${toolName}`,
    });
    this.inBackground(this.renew(userId, 'mcp_failure'));
  }

  /**
   * Disparador de `GET /assistants/me`: si quedó un fallo pendiente, reintenta
   * en segundo plano (debounce). Devuelve si hace falta el salto SSO.
   */
  async onStateRead(userId: string): Promise<{needsSso: boolean}> {
    const health = credentialHealth(await this.deps.store.lastCredentialEvent(userId));
    if (health === 'retry' && this.claimTrigger(userId)) this.inBackground(this.renew(userId, 'state_read'));
    return {needsSso: health === 'needs_sso'};
  }

  async needsSso(userId: string): Promise<boolean> {
    return credentialHealth(await this.deps.store.lastCredentialEvent(userId)) === 'needs_sso';
  }

  async acceptRecoveredGrant(userId: string, tokens: AssistantTokenSet): Promise<boolean> {
    const row = await this.deps.repository.findActive(userId);
    if (!row || !row.instance_name || !RENEWABLE.has(row.status) || !(await this.needsSso(userId))) return false;
    await this.saveCredential(userId, tokens);
    await this.deps.repository.appendEvent({userId, kind: 'credential.recovered', phase: 'callback'});
    this.logger.log(`credential recovered instance=${row.instance_name}`);
    try {
      await this.reseed(row, tokens);
      await this.deps.repository.appendEvent({userId, kind: 'credential.renewed', phase: 'reseed', detail: 'trigger=sso_recovery'});
    } catch (error) {
      await this.failed(userId, 'metadata_write_failed', 'sso_recovery', computeDetail(error));
    }
    return true;
  }

  /**
   * Revocación RFC 7009 del refresh guardado (OCB-012, al borrar). Cierra la
   * sesión offline: también invalida la copia de Hermes. Si sale bien borra la
   * fila de credenciales; si falla la conserva para reintentar y deja un evento
   * `revoke_failed`. No lanza.
   */
  async revokeStoredCredential(userId: string): Promise<RevokeOutcome> {
    const {repository, store, cipher, revocation} = this.deps;
    const sealed = await repository.readRefreshToken(userId);
    if (!sealed) return {result: 'no_credential'};
    let reason: string;
    try {
      await revocation.revoke(cipher.open('assistant_credentials.refresh_token_enc', userId, sealed), 'refresh_token');
      await store.deleteCredential(userId);
      await repository.appendEvent({userId, kind: 'credential.revoked', phase: 'revoke'});
      this.logger.log('credential revoked');
      return {result: 'revoked'};
    } catch (error) {
      reason = error instanceof OAuthTokenError ? `${error.kind}:${error.reason}` : 'other';
    }
    await repository.appendEvent({userId, kind: 'credential.revoke_failed', phase: 'revoke', cause: 'revoke_failed', detail: `reason=${reason}`});
    this.logger.warn(`credential revoke failed reason=${reason}`);
    return {result: 'failed', reason};
  }

  /** Espera los disparos en segundo plano (apagado ordenado y pruebas). */
  async idle(): Promise<void> {
    while (this.background.size || this.inFlight.size) {
      await Promise.allSettled([...this.background, ...this.inFlight.values()]);
    }
  }

  private async doRenew(userId: string, trigger: RenewalTrigger): Promise<RenewalOutcome> {
    const {repository, cipher, tokens} = this.deps;
    const row = await repository.findActive(userId);
    if (!row) return {result: 'skipped', reason: 'no_assistant'};
    if (!row.instance_name) return {result: 'skipped', reason: 'no_instance'};
    if (!RENEWABLE.has(row.status)) return {result: 'skipped', reason: 'not_renewable'};
    if (await this.needsSso(userId)) return {result: 'skipped', reason: 'awaiting_sso'};

    let fresh: AssistantTokenSet;
    try {
      const sealed = await repository.readRefreshToken(userId);
      if (!sealed) throw new OAuthTokenError('rejected', 'missing_credential');
      fresh = await tokens.refresh(cipher.open('assistant_credentials.refresh_token_enc', userId, sealed));
    } catch (error) {
      if (error instanceof OAuthTokenError && error.kind === 'unavailable') {
        await this.failed(userId, 'refresh_network', trigger, `reason=${error.reason}`);
        return {result: 'retry_later', cause: 'refresh_network'};
      }
      const reason = error instanceof OAuthTokenError ? error.reason : 'credential_unreadable';
      await this.failed(userId, 'refresh_invalid_grant', trigger, `reason=${reason}`);
      // Último evento = sso_silent_required: la próxima apertura hace el salto SSO.
      await this.failed(userId, 'sso_silent_required', trigger, null);
      return {result: 'sso_required'};
    }
    await this.saveCredential(userId, fresh);

    try {
      await this.reseed(row, fresh);
    } catch (error) {
      await this.failed(userId, 'metadata_write_failed', trigger, computeDetail(error));
      return {result: 'retry_later', cause: 'metadata_write_failed'};
    }
    await repository.appendEvent({userId, kind: 'credential.renewed', phase: 'reseed', detail: `trigger=${trigger}`});
    this.logger.log(`credential renewed instance=${row.instance_name} trigger=${trigger}`);
    return {result: 'renewed'};
  }

  private async saveCredential(userId: string, tokens: AssistantTokenSet): Promise<void> {
    const now = this.now();
    await this.deps.store.upsertCredential(userId,
      this.deps.cipher.seal('assistant_credentials.refresh_token_enc', userId, tokens.refreshToken),
      new Date(now.getTime() + tokens.expiresIn * 1000), now);
  }

  /**
   * Reemplaza solo `hermes-mcp-tokens` y conserva el resto de la metadata
   * (startup-script, hermes-env de OCB-010…). Con 412 relee y reintenta una vez.
   */
  private async reseed(row: AssistantRow, tokens: AssistantTokenSet): Promise<void> {
    const instance = row.instance_name!;
    const zone = row.zone ?? this.deps.zone;
    const value = hermesMcpTokens(tokens, this.deps.issuer, this.now().getTime());
    for (let attempt = 1; attempt <= 2; attempt++) {
      const current = await this.deps.metadata.read(instance, zone);
      const items = current.items.filter(item => item.key !== KEY);
      items.push({key: KEY, value});
      if (await this.deps.metadata.write(instance, zone, {fingerprint: current.fingerprint, items}) === 'ok') return;
    }
    throw new ComputeError(412, 'conditionNotMet');
  }

  private async failed(userId: string, cause: RenewalFailureCause, trigger: string, detail: string | null): Promise<void> {
    await this.deps.repository.appendEvent({
      userId, kind: 'credential_renewal_failed', phase: 'renewal', cause: V1_CAUSE[cause],
      detail: `cause=${cause} trigger=${trigger}${detail ? ` ${detail}` : ''}`,
    });
    this.logger.warn(`credential renewal failed cause=${cause} trigger=${trigger}${detail ? ` ${detail}` : ''}`);
  }

  private claimTrigger(userId: string): boolean {
    const now = this.now().getTime();
    const last = this.lastTriggered.get(userId);
    if (last !== undefined && now - last < this.deps.retryDebounceMs) return false;
    this.lastTriggered.set(userId, now);
    return true;
  }

  private inBackground(work: Promise<unknown>): void {
    const tracked = work.catch(() => {
      this.logger.warn('credential renewal aborted');
    }).finally(() => this.background.delete(tracked));
    this.background.add(tracked);
  }
}

function computeDetail(error: unknown): string {
  return error instanceof ComputeError ? `status=${error.status} reason=${error.reason}` : 'reason=other';
}
