import {Logger} from '@nestjs/common';
import type {AiConfigResponseV1, AssistantStateV1} from '../contracts/v1';
import type {AssistantRow} from '../persistence/assistant-repository';
import type {AssistantStateReader} from '../state/assistant-state';
import {isManagedMetaUser, META_MODEL_ID, META_PROVIDER_ID, type ManagedMetaScope} from './meta-model';

type AiState = AssistantStateV1['ai'];
type SetupRow = Pick<AssistantRow, 'status' | 'step' | 'instance_name'>;

export interface ManagedMetaOptions extends ManagedMetaScope {
  /** Private pilot credential. All-account mode requires a per-assistant credential resolver. */
  apiKey: string;
  retryAfterMs?: number;
  reconciliationTimeoutMs?: number;
}

export interface ManagedMetaDeps {
  read: (userId: string) => Promise<SetupRow | null>;
  configure: (userId: string, input: {provider: string; model: string; api_key: string}) => Promise<Pick<AiConfigResponseV1, 'result'>>;
  /** Account-bound relay credential; never the deployment's upstream inference secret. */
  credentialForUser?: (userId: string) => Promise<string | null>;
  /** Restore persisted successful setup without rewriting metadata or running another inference turn. */
  reconcile?: (userId: string, apiKey: string) => Promise<'ready' | 'configure' | 'deferred'>;
  now?: () => number;
}

/** One automatic setup at a time; state reads never wait for an inference probe. */
export class ManagedMetaBootstrap {
  private readonly logger = new Logger('managed-meta');
  private readonly running = new Map<string, Promise<void>>();
  private readonly checking = new Map<string, Promise<void>>();
  private readonly verified = new Set<string>();
  private readonly retryAt = new Map<string, number>();
  private readonly now: () => number;

  constructor(readonly options: ManagedMetaOptions, private readonly deps: ManagedMetaDeps) {
    this.now = deps.now ?? Date.now;
  }

  manages(userId: string): boolean { return isManagedMetaUser(this.options, userId); }

  isVerified(userId: string): boolean { return this.manages(userId) && this.verified.has(userId); }

  isReady(userId: string, ai: AiState): boolean {
    if (!this.manages(userId)) return true;
    const configured = ai.configured && ai.provider === META_PROVIDER_ID && ai.model === META_MODEL_ID;
    if (!configured) this.verified.delete(userId);
    return configured && this.verified.has(userId);
  }

  request(userId: string): void {
    if (!this.manages(userId) || this.verified.has(userId) || this.running.has(userId) ||
      this.now() < (this.retryAt.get(userId) ?? 0)) return;
    let checked!: () => void;
    this.checking.set(userId, new Promise<void>(resolve => {checked = resolve;}));
    const run = this.prepare(userId, checked).catch(() => {
      this.logger.warn('managed Meta setup failed');
    }).finally(() => {
      checked();
      this.checking.delete(userId);
      this.running.delete(userId);
      this.retryAt.set(userId, this.now() + (this.options.retryAfterMs ?? 60_000));
    });
    this.running.set(userId, run);
  }

  async idle(): Promise<void> { await Promise.all(this.running.values()); }

  /** GET may wait briefly for read-only proof, never for a configuration write or inference probe. */
  async reconcileReadiness(userId: string, ai: AiState): Promise<boolean> {
    if (this.isReady(userId, ai)) return true;
    this.request(userId);
    const check = this.checking.get(userId);
    if (check && this.deps.reconcile) await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, this.options.reconciliationTimeoutMs ?? 1000);
      timer.unref();
      void check.then(() => {clearTimeout(timer); resolve();});
    });
    return ai.configured && ai.provider === META_PROVIDER_ID && ai.model === META_MODEL_ID && this.verified.has(userId);
  }

  private async prepare(userId: string, checked: () => void): Promise<void> {
    const row = await this.deps.read(userId);
    if (!row?.instance_name || !(row.status === 'ready' || (row.status === 'activating' && row.step === 'configure_ai'))) return;
    this.verified.delete(userId);
    const apiKey = this.deps.credentialForUser ? await this.deps.credentialForUser(userId) :
      this.options.allUsers ? null : this.options.apiKey;
    if (!apiKey) return;
    const persisted = await this.deps.reconcile?.(userId, apiKey);
    if (persisted === 'ready') {
      this.verified.add(userId);
      checked();
      return;
    }
    checked();
    if (persisted === 'deferred') return;
    const result = await this.deps.configure(userId, {
      provider: META_PROVIDER_ID, model: META_MODEL_ID, api_key: apiKey,
    });
    if (result.result === 'ok') this.verified.add(userId);
    this.logger.log(`managed Meta setup outcome=${result.result}`);
  }
}

export class ManagedMetaStateReader implements AssistantStateReader {
  constructor(private readonly inner: AssistantStateReader, private readonly meta: ManagedMetaBootstrap,
    private readonly onVerifiedReady?: (userId: string) => Promise<void> | void) {}

  async read(userId: string): Promise<AssistantStateV1> {
    const wasVerified = this.meta.isVerified(userId);
    const state = await this.inner.read(userId);
    if (!this.meta.manages(userId) || !(state.status === 'ready' ||
      (state.status === 'activating' && state.step === 'configure_ai'))) return state;
    if (await this.meta.reconcileReadiness(userId, state.ai)) {
      if (!wasVerified && state.status === 'ready' && this.onVerifiedReady) {
        // The inner readiness callback ran before this process verified Meta.
        // Replay only that callback, without another state transition or probe.
        void Promise.resolve().then(() => this.onVerifiedReady!(userId)).catch(() => undefined);
      }
      return state;
    }
    return {...state, status: 'activating', step: 'configure_ai', ai: {configured: false, provider: null, model: null}};
  }
}
