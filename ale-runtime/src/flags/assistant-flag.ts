import {PostHog} from 'posthog-node';
import {flagUnavailable} from '../domain/errors';
import type {AssistantFlag} from '../domain/ports';
import type {OutboundFetch} from '../outbound/http-client';

/** Subconjunto de posthog-node que se usa: lectura de una bandera sin emitir eventos. */
export interface FlagReader {
  getFeatureFlag(key: string, distinctId: string, options: {sendFeatureFlagEvents: false; disableGeoip: true}): Promise<unknown>;
}

const MAX_CACHE_ENTRIES = 10_000;

/**
 * Bandera `sales-assistant-enabled` evaluada del lado servidor con el `sub` como
 * `distinct_id` (mismo patrón que sa-strategy-service@76dd4c2f
 * seasonal-communication-rollout.ts:107-120,136-199). Solo `true` habilita;
 * `false` es 403. PostHog caído o una respuesta no booleana lanza 503 y no se
 * guarda en caché. Las respuestas booleanas se reutilizan `ttlMs`.
 */
export class PostHogAssistantFlag implements AssistantFlag {
  private readonly answers = new Map<string, {value: boolean; expiresAt: number}>();
  private readonly inFlight = new Map<string, Promise<boolean>>();

  constructor(
    private readonly reader: FlagReader,
    private readonly flagKey: string,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  isEnabled(userId: string): Promise<boolean> {
    const cached = this.answers.get(userId);
    if (cached && cached.expiresAt > this.now()) return Promise.resolve(cached.value);
    if (cached) this.answers.delete(userId);
    const pending = this.inFlight.get(userId);
    if (pending) return pending;
    const request = this.read(userId).finally(() => this.inFlight.delete(userId));
    this.inFlight.set(userId, request);
    return request;
  }

  private async read(userId: string): Promise<boolean> {
    let value: unknown;
    try {
      value = await this.reader.getFeatureFlag(this.flagKey, userId, {sendFeatureFlagEvents: false, disableGeoip: true});
    } catch {
      throw flagUnavailable();
    }
    if (typeof value !== 'boolean') throw flagUnavailable();
    this.remember(userId, value);
    return value;
  }

  private remember(userId: string, value: boolean): void {
    if (!(this.ttlMs > 0)) return;
    if (this.answers.size >= MAX_CACHE_ENTRIES) {
      const at = this.now();
      for (const [key, entry] of this.answers) if (entry.expiresAt <= at) this.answers.delete(key);
      if (this.answers.size >= MAX_CACHE_ENTRIES) this.answers.delete(this.answers.keys().next().value as string);
    }
    this.answers.set(userId, {value, expiresAt: this.now() + this.ttlMs});
  }
}

/** Cliente PostHog sin reintentos, con timeout corto y el fetch saliente con User-Agent explícito. */
export function createPostHogClient(apiKey: string, host: string, fetcher: OutboundFetch): PostHog {
  return new PostHog(apiKey, {
    host,
    disableGeoip: true,
    fetchRetryCount: 0,
    requestTimeout: 5_000,
    featureFlagsRequestTimeoutMs: 5_000,
    fetch: (url, options) => fetcher(url, options),
  });
}
