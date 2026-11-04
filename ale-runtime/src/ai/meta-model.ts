/** Managed Meta Assistant inference. No provider/model selection comes from the browser. */
export const META_PROVIDER_ID = 'meta-ai';
export const META_MODEL_ID = 'muse-spark-1.3-contributor';
export const META_API_BASE_URL = 'https://api.meta.ai/v1';
export const MAX_META_RELAY_BODY_BYTES = 8 * 1024 * 1024;
/** v10 also preserves native API acceptance receipts before gateway retention pruning. */
export const MIN_META_WATCHER_VERSION = 11;
export const MANAGED_META_MODE = Symbol('MANAGED_META_MODE');

export interface ManagedMetaScope {
  enabled: boolean;
  /** Single-pilot subject; retained when allUsers is not explicitly enabled. */
  userId: string;
  /** Deployment admission only. HTTP authentication and the assistant flag still apply. */
  allUsers?: boolean;
}

export function isManagedMetaUser(scope: ManagedMetaScope | undefined, userId: string | undefined): boolean {
  return scope?.enabled === true && !!userId?.trim() && (scope.allUsers === true || scope.userId === userId);
}

/** These Hermes tasks otherwise have their own provider/model defaults. */
export const META_AUXILIARY_TASKS = Object.freeze([
  'compression', 'vision', 'approval', 'skills_hub', 'mcp', 'title_generation',
  'background_review', 'curator', 'review', 'triage_specifier',
  'memory_query_rewrite', 'tts_audio_tags', 'voice_chat', 'kanban_decomposer',
  'profile_describer', 'goal_judge', 'monitor', 'moa_reference', 'moa_aggregator',
]);

export function managedMetaConfigLines(provider: string, baseUrl?: string): string[] {
  if (provider !== META_PROVIDER_ID) return [];
  return [
    'fallback_providers: []',
    'fallback_model: ""',
    'auxiliary:',
    ...META_AUXILIARY_TASKS.flatMap(task => [
      `  ${task}:`,
      `    provider: ${JSON.stringify(META_PROVIDER_ID)}`,
      `    model: ${JSON.stringify(META_MODEL_ID)}`,
      `    base_url: ${JSON.stringify(baseUrl ?? '')}`,
      '    api_key: ""',
      '    fallback_chain: []',
    ]),
    'delegation:',
    `  provider: ${JSON.stringify(META_PROVIDER_ID)}`,
    `  model: ${JSON.stringify(META_MODEL_ID)}`,
    `  base_url: ${JSON.stringify(baseUrl ?? '')}`,
    '  fallback_providers: []',
  ];
}
