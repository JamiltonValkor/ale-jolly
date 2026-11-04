import type {ProvidersResponseV1} from '../contracts/v1';
import {META_PROVIDER_ID} from './meta-model';

/**
 * Catálogo versionado de proveedores con API key que acepta Hermes v0.21.6
 * (NousResearch/hermes-agent@818c13be, leído el 2026-11-03):
 *
 * - `id` es el id del proveedor en Hermes (va en `config.yaml` → `model.provider`):
 *   hermes_cli/auth.py `_REGISTRY_ROWS` y plugins/model-providers/<id>/__init__.py.
 * - `envVar` es la variable de la key que Hermes lee del `.env` (la primera de
 *   `api_key_env_vars`/`env_vars` que es una key literal).
 *
 * El orden lo da el back: OpenAI, Anthropic, Gemini y OpenRouter primero
 * (OCB-010). Quedan fuera los de OAuth o suscripción (nous, openai-codex,
 * xai-oauth, qwen-oauth, minimax-oauth, copilot, solstice), los de SDK de nube
 * (bedrock, vertex), los locales (lmstudio, custom), los que además exigen una
 * base URL propia (azure-foundry) y los planes de coding.
 *
 * Comprobado de punta a punta en dev: solo `openrouter` (OCB-002/OCB-005). El
 * resto sale del código fijado; «probar al guardar» es la red de seguridad.
 */
export interface AiProvider { id: string; label: string; envVar: string; verifiedInDev: boolean }

export const AI_PROVIDERS_VERSION = 'hermes-agent@0.21.6+818c13be';

export const AI_PROVIDERS: readonly AiProvider[] = Object.freeze([
  {id: 'openai-api', label: 'OpenAI', envVar: 'OPENAI_API_KEY', verifiedInDev: false},
  {id: 'anthropic', label: 'Anthropic', envVar: 'ANTHROPIC_API_KEY', verifiedInDev: false},
  {id: 'gemini', label: 'Google Gemini (AI Studio)', envVar: 'GEMINI_API_KEY', verifiedInDev: false},
  {id: 'openrouter', label: 'OpenRouter', envVar: 'OPENROUTER_API_KEY', verifiedInDev: true},
  {id: 'deepseek', label: 'DeepSeek', envVar: 'DEEPSEEK_API_KEY', verifiedInDev: false},
  {id: 'xai', label: 'xAI (Grok)', envVar: 'XAI_API_KEY', verifiedInDev: false},
  {id: 'zai', label: 'Z.AI (GLM)', envVar: 'GLM_API_KEY', verifiedInDev: false},
  {id: 'kimi-coding', label: 'Kimi / Moonshot', envVar: 'KIMI_API_KEY', verifiedInDev: false},
  {id: 'minimax', label: 'MiniMax', envVar: 'MINIMAX_API_KEY', verifiedInDev: false},
  {id: 'alibaba', label: 'Qwen Cloud (DashScope)', envVar: 'DASHSCOPE_API_KEY', verifiedInDev: false},
  {id: 'nvidia', label: 'NVIDIA NIM', envVar: 'NVIDIA_API_KEY', verifiedInDev: false},
  {id: 'huggingface', label: 'Hugging Face', envVar: 'HF_TOKEN', verifiedInDev: false},
  {id: 'fireworks', label: 'Fireworks AI', envVar: 'FIREWORKS_API_KEY', verifiedInDev: false},
  {id: 'deepinfra', label: 'DeepInfra', envVar: 'DEEPINFRA_API_KEY', verifiedInDev: false},
  {id: 'novita', label: 'NovitaAI', envVar: 'NOVITA_API_KEY', verifiedInDev: false},
  {id: 'ai-gateway', label: 'Vercel AI Gateway', envVar: 'AI_GATEWAY_API_KEY', verifiedInDev: false},
  {id: 'kilocode', label: 'Kilo Code', envVar: 'KILOCODE_API_KEY', verifiedInDev: false},
  {id: 'ollama-cloud', label: 'Ollama Cloud', envVar: 'OLLAMA_API_KEY', verifiedInDev: false},
  {id: 'arcee', label: 'Arcee AI', envVar: 'ARCEEAI_API_KEY', verifiedInDev: false},
  {id: META_PROVIDER_ID, label: 'Meta Model API', envVar: 'MODEL_API_KEY', verifiedInDev: false},
].map(provider => Object.freeze(provider)));

export function findProvider(id: string): AiProvider | null {
  return AI_PROVIDERS.find(provider => provider.id === id) ?? null;
}

/** `GET /assistants/me/providers`: todos piden key; ninguno es OAuth. */
export function providersResponse(managedMeta = false): ProvidersResponseV1 {
  if (managedMeta) return [{id: META_PROVIDER_ID, label: 'Meta Model API', needs_key: false}];
  return AI_PROVIDERS.map(({id, label}) => ({id, label, needs_key: true}));
}
