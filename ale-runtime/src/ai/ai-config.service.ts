import {Logger} from '@nestjs/common';
import {hermesConfig, type McpConfig} from '../activation/hermes-files';
import {UserLocks} from '../assistant-config/user-locks';
import {ComputeError} from '../compute/compute-client';
import type {InstanceApi, InstanceView} from '../compute/instance-client';
import {computeAppliedVersion} from '../compute/metadata';
import type {AiConfigRequestV1, AiConfigResponseV1} from '../contracts/v1';
import {invalidRequest, ServiceError} from '../domain/errors';
import type {HermesApi, HermesTarget} from '../hermes/hermes-client';
import {classifyHealth} from '../lifecycle/readiness';
import type {AssistantRepository, AssistantRow, CauseCode} from '../persistence/assistant-repository';
import type {FieldCipher} from '../security/field-cipher';
import {acceptableApiKey, classifyProbeFailure, hermesEnv, MODEL_ID, withAiValues} from './ai-outcome';
import type {AiRepository} from './ai-repository';
import {findProvider, type AiProvider} from './providers';
import {isManagedMetaUser, META_MODEL_ID, META_PROVIDER_ID, MIN_META_WATCHER_VERSION, type ManagedMetaScope} from './meta-model';

export const AI_CONFIG_SERVICE = Symbol('AI_CONFIG_SERVICE');

export interface AiConfigOptions {
  mcp: McpConfig;
  managedMeta?: ManagedMetaScope;
  /** Private operator configuration, never a browser-selected inference endpoint. */
  managedMetaBaseUrl?: string;
  /** Plazo total del PUT (el front espera ≤ 90 s). */
  deadlineMs: number;
  ackTimeoutMs: number;
  probeTimeoutMs: number;
  pollIntervalMs: number;
  healthTimeoutMs: number;
  /** «Key no cargada»: hasta 3 intentos dentro de esta ventana (OCB-010). */
  keyLoadWindowMs?: number;
}

export interface AiConfigDeps {
  repository: AssistantRepository;
  ai: AiRepository;
  instances: InstanceApi;
  hermes: HermesApi;
  cipher: FieldCipher;
  /** Compartidos con `PUT /timezone` y el start (OCB-016): un cambio de config por usuario a la vez. */
  locks?: UserLocks;
  /** Se llama tras cambiar la fila, para que GET /me no sirva una observación vieja. */
  onStateChanged?: (userId: string) => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

type Result = AiConfigResponseV1['result'];

const ACK_KEY = 'hermes/applied-version';
const PROBE_MESSAGE = 'SaleADS connection check. Reply only with OK, without using tools.';
const KEY_LOAD_ATTEMPTS = 3;

/** Compare only the AI-owned YAML blocks; MCP, timezone and native additions are unrelated. */
function managedConfigMatches(actual: string, expected: string): boolean {
  const blocks = (value: string, indent: number): Map<string, string> | null => {
    const result = new Map<string, string>();
    let key: string | undefined;
    for (const raw of value.split('\n')) {
      const line = raw.trimEnd();
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      const match = new RegExp(`^ {${indent}}([A-Za-z_][A-Za-z0-9_-]*):`).exec(line);
      if (match) {
        key = match[1]!;
        if (result.has(key)) return null;
        result.set(key, line);
      } else if (key) result.set(key, result.get(key)! + '\n' + line);
    }
    return result;
  };
  const current = blocks(actual, 0), wanted = blocks(expected, 0);
  if (!current || !wanted) return false;
  for (const key of ['model', 'fallback_providers', 'fallback_model']) {
    if (current.get(key) !== wanted.get(key)) return false;
  }
  const currentDelegation = blocks(current.get('delegation') ?? '', 2);
  const wantedDelegation = blocks(wanted.get('delegation') ?? '', 2);
  if (!currentDelegation || !wantedDelegation ||
    ![...wantedDelegation].every(([key, value]) => currentDelegation.get(key) === value)) return false;
  const currentAux = blocks(current.get('auxiliary') ?? '', 2);
  const wantedAux = blocks(wanted.get('auxiliary') ?? '', 2);
  if (!currentAux || !wantedAux) return false;
  return [...wantedAux].every(([task, value]) => {
    const currentTask = blocks(currentAux.get(task) ?? '', 4), wantedTask = blocks(value, 4);
    return !!currentTask && !!wantedTask && [...wantedTask].every(([key, field]) => currentTask.get(key) === field);
  });
}

/** Values are compared in memory only; unrelated native integration variables are preserved. */
function managedEnvMatches(actual: string, expected: string): boolean {
  const env = (value: string): Map<string, string> | null => {
    const result = new Map<string, string>();
    for (const line of value.split('\n')) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      if (!match || !['MODEL_API_KEY', 'META_BASE_URL'].includes(match[1]!)) continue;
      if (result.has(match[1]!)) return null;
      result.set(match[1]!, match[2]!);
    }
    return result;
  };
  const current = env(actual), wanted = env(expected);
  return !!current && !!wanted && ['MODEL_API_KEY', 'META_BASE_URL'].every(key => current.get(key) === wanted.get(key));
}

/** Fallo de una fase con un código seguro para el registro. */
class Unreachable extends Error {
  constructor(readonly reason: string, readonly cause_: CauseCode) {super(reason);}
}

/**
 * «Configura tu IA» (OCB-010): `PUT /assistants/me/ai`.
 *
 * 1. Valida proveedor (catálogo de Hermes v0.21.6) y modelo; una key con
 *    caracteres que no caben en `.env` da `invalid_key` sin tocar la VM.
 * 2. `instances.get` → fusiona sobre TODA la metadata actual solo
 *    `hermes-env` (la variable del proveedor) y `hermes-config` (modelo + zona
 *    de la fila, constructor único de OCB-016) →
 *    `setMetadata` con el fingerprint (un 412 relee y reintenta una vez).
 * 3. Espera el ack `hermes/applied-version` = hash esperado (≤ 60 s). Si cambió
 *    `hermes-config`, el watcher reinicia el contenedor: espera además que
 *    `/health/detailed` vuelva con todos los checks ok.
 * 4. Turno mínimo por la Sessions API (SSE). Clasifica: ok / invalid_key /
 *    incompatible_model / provider_rejected; sin respuesta de Hermes o fuera de
 *    plazo: unreachable.
 * 5. ok → ai_configured=true, status=ready. Rechazo después de entregar la
 *    key → «Configura tu IA» (la anterior ya se descartó).
 *
 * La key nunca se guarda en la base, nunca se devuelve y nunca se registra:
 * solo viaja en el cuerpo de setMetadata hacia Compute.
 */
export class AiConfigService {
  private readonly logger = new Logger('ai');
  private readonly locks: UserLocks;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: AiConfigOptions, private readonly deps: AiConfigDeps) {
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms).unref()));
    this.locks = deps.locks ?? new UserLocks();
  }

  /** Un PUT por usuario a la vez (y en serie con `PUT /timezone`): el segundo espera al primero. */
  async configure(userId: string, input: AiConfigRequestV1): Promise<AiConfigResponseV1> {
    return this.locks.run(userId, () => this.configureNow(userId, input));
  }

  /**
   * Rehydrate successful managed setup after a control-plane restart. The persisted
   * probe result is still authoritative; only its current account credential,
   * provider/model, transport and watcher acknowledgement are checked again.
   * Unknown or pending cloud observations never authorize a configuration write.
   */
  async reconcileManagedMeta(userId: string, apiKey: string): Promise<'ready' | 'configure' | 'deferred'> {
    if (!isManagedMetaUser(this.options.managedMeta, userId) || !acceptableApiKey(apiKey)) return 'deferred';
    const row = await this.deps.repository.findActive(userId);
    if (!row?.instance_name || !(row.status === 'ready' || (row.status === 'activating' && row.step === 'configure_ai'))) return 'deferred';
    if (!row.ai_configured || row.ai_provider !== META_PROVIDER_ID || row.ai_model !== META_MODEL_ID) return 'configure';
    const view = await this.deps.instances.getInstance(row.instance_name);
    if (!view || view.status !== 'RUNNING') return 'deferred';
    const watcher = await this.deps.instances.guestAttribute(row.instance_name, 'hermes/watcher-version');
    if (!watcher || !/^\d+$/.test(watcher) || Number(watcher) < MIN_META_WATCHER_VERSION) return 'deferred';
    const config = hermesConfig({mcp: this.options.mcp, userId,
      model: {provider: META_PROVIDER_ID, model: META_MODEL_ID, baseUrl: this.options.managedMetaBaseUrl}});
    const env = hermesEnv(findProvider(META_PROVIDER_ID)!, apiKey, META_MODEL_ID, this.options.managedMetaBaseUrl);
    const values = new Map(view.items.map(item => [item.key, item.value]));
    const actualConfig = values.get('hermes-config'), actualEnv = values.get('hermes-env');
    if (!actualConfig || !actualEnv) return 'deferred';
    if (!managedConfigMatches(actualConfig, config) || !managedEnvMatches(actualEnv, env)) return 'configure';
    const ack = await this.deps.instances.guestAttribute(row.instance_name, ACK_KEY);
    return ack === computeAppliedVersion(view.items) ? 'ready' : 'deferred';
  }

  private async configureNow(userId: string, input: AiConfigRequestV1): Promise<AiConfigResponseV1> {
    const provider = findProvider(input.provider);
    if (!provider || !MODEL_ID.test(input.model)) throw invalidRequest();
    if (provider.id === META_PROVIDER_ID && input.model !== META_MODEL_ID) throw invalidRequest();
    const row = await this.deps.repository.findActive(userId);
    if (!row) throw new ServiceError('NOT_FOUND', 404);
    if (!acceptableApiKey(input.api_key)) return this.finish(userId, provider, input.model, 'invalid_key', 'key_format', false);
    const configurable = row.status === 'ready' || (row.status === 'activating' && row.step === 'configure_ai');
    if (!configurable || !row.instance_name || !row.api_server_key_enc) {
      return this.finish(userId, provider, input.model, 'unreachable', `not_ready status=${row.status} step=${row.step ?? 'none'}`, false);
    }

    const deadline = this.now().getTime() + this.options.deadlineMs;
    let delivered = false;
    try {
      const target = await this.deliver(row, provider, input, deadline);
      delivered = true;
      const result = await this.probe(target, deadline);
      return await this.finish(userId, provider, input.model, result, result === 'ok' ? 'probe_ok' : 'probe_rejected', true);
    } catch (error) {
      const reason = error instanceof Unreachable ? error.reason : 'other';
      const cause = error instanceof Unreachable ? error.cause_ : (delivered ? 'ai_test_failed' : 'config_apply_failed');
      return this.finish(userId, provider, input.model, 'unreachable', reason, delivered, cause);
    }
  }

  /** Escribe hermes-env + hermes-config y espera el ack (y el reinicio si cambió la config). */
  private async deliver(row: AssistantRow, provider: AiProvider, input: AiConfigRequestV1, deadline: number): Promise<HermesTarget> {
    const name = row.instance_name!;
    if (provider.id === META_PROVIDER_ID) {
      const watcher = await this.deps.instances.guestAttribute(name, 'hermes/watcher-version');
      if (!watcher || !/^\d+$/.test(watcher) || Number(watcher) < MIN_META_WATCHER_VERSION) {
        throw new Unreachable('managed_watcher_upgrade_required', 'config_apply_failed');
      }
    }
    // Mismo constructor que la activación y PUT /timezone: MCP + este modelo + la zona de la fila.
    const baseUrl = provider.id === META_PROVIDER_ID && isManagedMetaUser(this.options.managedMeta, row.user_id)
      ? this.options.managedMetaBaseUrl : undefined;
    const config = hermesConfig({mcp: this.options.mcp, model: {provider: provider.id, model: input.model, baseUrl}, timezone: row.timezone, userId: row.user_id});
    const values = {env: hermesEnv(provider, input.api_key, input.model, baseUrl), config};
    let view = await this.instance(name);
    let configChanged = false;
    let expected = '';
    for (let attempt = 1; ; attempt++) {
      configChanged = view.items.find(item => item.key === 'hermes-config')?.value !== values.config;
      const items = withAiValues(view.items, values);
      expected = computeAppliedVersion(items);
      try {
        await this.deps.instances.setMetadata(name, view.fingerprint, items);
        break;
      } catch (error) {
        if (error instanceof ComputeError && error.status === 412 && attempt === 1) {view = await this.instance(name); continue;}
        throw new Unreachable(error instanceof ComputeError ? `set_metadata status=${error.status} reason=${error.reason}` : 'set_metadata', 'config_apply_failed');
      }
    }

    const ackDeadline = Math.min(deadline, this.now().getTime() + this.options.ackTimeoutMs);
    // El ack esperado se calcula sobre la metadata recién escrita. Si el ack
    // publicado cambia a otro valor (p. ej. la renovación de OCB-009 resembró
    // hermes-mcp-tokens y el watcher aplicó ambas escrituras juntas), se relee
    // la metadata vigente y se recalcula, siempre que siga llevando nuestra IA.
    let lastAck: string | null | undefined;
    const acked = await this.until(ackDeadline, async () => {
      const ack = await this.deps.instances.guestAttribute(name, ACK_KEY).catch(() => null);
      if (ack === expected) return true;
      if (ack === lastAck) return false;
      lastAck = ack;
      const current = await this.instance(name);
      const ours = current.items.find(item => item.key === 'hermes-env')?.value === values.env
        && current.items.find(item => item.key === 'hermes-config')?.value === values.config;
      if (!ours) throw new Unreachable('metadata_overwritten', 'config_apply_failed');
      expected = computeAppliedVersion(current.items);
      return ack === expected;
    });
    if (!acked) throw new Unreachable('ack_timeout', 'config_apply_failed');
    const ip = view.privateIp;
    if (!ip) throw new Unreachable('no_private_ip', 'config_apply_failed');
    const target = {ip, apiServerKey: this.deps.cipher.open('assistants.api_server_key_enc', row.user_id, row.api_server_key_enc!)};
    // Cambio de config.yaml = reinicio del contenedor (~40 s en dev): esperar a que vuelva sano.
    if (configChanged && !await this.until(deadline, async () =>
      classifyHealth(await this.deps.hermes.health(target, this.options.healthTimeoutMs)) === 'healthy')) {
      throw new Unreachable('restart_timeout', 'config_apply_failed');
    }
    return target;
  }

  /** Turno mínimo; «key no cargada» se reintenta hasta 3 veces en 30 s y luego cuenta como invalid_key. */
  private async probe(target: HermesTarget, deadline: number): Promise<Result> {
    const windowEnd = this.now().getTime() + (this.options.keyLoadWindowMs ?? 30_000);
    for (let attempt = 1; ; attempt++) {
      const remaining = deadline - this.now().getTime();
      if (remaining <= 0) throw new Unreachable('probe_deadline', 'ai_test_failed');
      const outcome = await this.deps.hermes.probeTurn(target, PROBE_MESSAGE, Math.min(this.options.probeTimeoutMs, remaining));
      if (outcome.kind === 'completed') return 'ok';
      if (outcome.kind === 'unauthorized') throw new Unreachable('hermes_auth_failed', 'ai_test_failed');
      if (outcome.kind === 'unreachable') throw new Unreachable(`probe_${outcome.reason}`, 'ai_test_failed');
      const failure = classifyProbeFailure(outcome.text);
      if (failure !== 'key_not_loaded') return failure;
      if (attempt >= KEY_LOAD_ATTEMPTS || this.now().getTime() >= windowEnd) return 'invalid_key';
      await this.sleep(Math.min(this.options.pollIntervalMs * 2, Math.max(0, windowEnd - this.now().getTime())));
    }
  }

  private async instance(name: string): Promise<InstanceView> {
    let view: InstanceView | null;
    try {
      view = await this.deps.instances.getInstance(name);
    } catch (error) {
      throw new Unreachable(error instanceof ComputeError ? `get status=${error.status} reason=${error.reason}` : 'get', 'config_apply_failed');
    }
    if (!view) throw new Unreachable('instance_missing', 'config_apply_failed');
    if (view.status !== 'RUNNING') throw new Unreachable(`instance_${view.status.toLowerCase()}`, 'config_apply_failed');
    return view;
  }

  private async until(deadline: number, check: () => Promise<boolean>): Promise<boolean> {
    for (;;) {
      if (await check()) return true;
      const left = deadline - this.now().getTime();
      if (left <= 0) return false;
      await this.sleep(Math.min(this.options.pollIntervalMs, left));
    }
  }

  /**
   * Persiste el resultado y deja un evento sin valores: proveedor, resultado y
   * un código de causa. `delivered` = la key nueva ya está en la VM.
   */
  private async finish(
    userId: string, provider: AiProvider, model: string, result: Result, reason: string, delivered: boolean, cause?: CauseCode,
  ): Promise<AiConfigResponseV1> {
    const {repository, ai} = this.deps;
    const now = this.now();
    const detail = `provider=${provider.id} result=${result} reason=${reason}`.slice(0, 500);
    if (result === 'ok') {
      await ai.markConfigured(userId, provider.id, model, now);
    } else if (delivered && result !== 'unreachable') {
      await ai.markNeedsAi(userId, now);
    }
    if (result === 'ok') await repository.appendEvent({userId, kind: 'ai.configured', phase: 'ai', detail});
    else await repository.appendEvent({userId, kind: result === 'unreachable' ? 'ai.unreachable' : 'ai.test_failed', phase: 'ai', cause: cause ?? 'ai_test_failed', detail});
    this.deps.onStateChanged?.(userId);
    this.logger.log(`ai configure ${detail}`);
    return {result};
  }
}
