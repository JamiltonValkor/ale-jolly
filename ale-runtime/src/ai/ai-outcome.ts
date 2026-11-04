import {withMetadataValues, type MetadataItem} from '../compute/metadata';
import type {AiProvider} from './providers';

/**
 * Clasificación del turno de prueba fallido (OCB-010) a partir del texto que
 * Hermes dejó en `assistant.completed`/`error`. Ese texto ya viene redactado
 * por Hermes y aquí solo se compara: nunca se guarda, se registra ni se devuelve.
 *
 * Textos de Hermes v0.21.6 (agent/turn_failure_copy.py, agent/agent_init.py):
 * - key: «{label} rejected your API key…» / «…rejected the sign-in».
 * - modelo: «Model '…' isn't available on {label}» / «…which is below the
 *   minimum 64,000 required by Hermes Agent» (MINIMUM_CONTEXT_LENGTH).
 * - bloqueo por política o CDN: es un rechazo del proveedor, no de la key.
 */
export type ProbeFailure = 'key_not_loaded' | 'invalid_key' | 'incompatible_model' | 'provider_rejected';

const KEY_NOT_LOADED = /no api key|api key (?:is )?(?:not set|missing|not found)|missing (?:an? )?api key|no credentials (?:found|configured)/i;
const PROVIDER_BLOCK = /because of a policy|firewall\/cdn|blocked the request/i;
const INVALID_KEY = /rejected your api key|rejected the sign-in|invalid[ _-]?api[ _-]?key|incorrect api key|unauthori[sz]ed|authentication (?:failed|error)|\b401\b|\b403\b/i;
const INCOMPATIBLE_MODEL = /below the minimum|isn'?t available on|is not available on|model_not_found|not a valid model|no endpoints found|does not exist|unknown model|\b404\b/i;

export function classifyProbeFailure(text: string): ProbeFailure {
  if (KEY_NOT_LOADED.test(text)) return 'key_not_loaded';
  if (PROVIDER_BLOCK.test(text)) return 'provider_rejected';
  if (INVALID_KEY.test(text)) return 'invalid_key';
  if (INCOMPATIBLE_MODEL.test(text)) return 'incompatible_model';
  return 'provider_rejected';
}

/** Id de modelo aceptado (se cita en YAML con JSON.stringify, pero se acota igual). */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
/**
 * Caracteres de una key que viajan sin ambigüedad en una línea de `.env`
 * (python-dotenv): ASCII visible sin comillas, `\`, `#` ni `$`.
 */
export const API_KEY = /^[\x21-\x7e]{8,4096}$/;
const API_KEY_FORBIDDEN = /["'`\\#$]/;

export function acceptableApiKey(value: string): boolean {
  return API_KEY.test(value) && !API_KEY_FORBIDDEN.test(value);
}

/**
 * Tope de una llamada al modelo. Por defecto Hermes espera hasta 30 min mientras el proveedor mantenga
 * viva la conexión (`HERMES_API_TIMEOUT=1800`): en el E2E simulado un turno de Ale quedó 14 min colgado
 * y el chat del dueño congelado. Con 5 min, Hermes corta y reintenta.
 */
export const HERMES_API_TIMEOUT_S = 300;

/**
 * `hermes-env`: la variable del proveedor elegido y el tope por llamada; el watcher reescribe `.env` completo.
 * El cerebro hereda este `.env` y llama a OpenRouter: con OpenRouter usa el MISMO modelo que eligió el dueño
 * (sin esto quedaba en su modelo por defecto, DeepSeek v3.1 hasta 2026-10-31, aunque el asistente usara otro más barato).
 */
export function hermesEnv(provider: AiProvider, apiKey: string, model?: string, metaBaseUrl?: string): string {
  // El modelo lo escribe el dueño: solo un id con forma de modelo llega al `.env` (nunca otra variable).
  const brain = provider.id === 'openrouter' && model && MODEL_ID.test(model) ? `BRAIN_LLM_MODEL=${model}\n` : '';
  const meta = provider.id === 'meta-ai' && metaBaseUrl ? `META_BASE_URL=${metaBaseUrl}\n` : '';
  return `${provider.envVar}=${apiKey}\nHERMES_API_TIMEOUT=${HERMES_API_TIMEOUT_S}\n${brain}${meta}`;
}

/** Reemplaza (o agrega) solo `hermes-env` y `hermes-config` sobre TODA la metadata actual. */
export function withAiValues(current: readonly MetadataItem[], values: {env: string; config: string}): MetadataItem[] {
  return withMetadataValues(current, {'hermes-env': values.env, 'hermes-config': values.config});
}
