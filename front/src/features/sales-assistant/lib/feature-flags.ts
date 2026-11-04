// TDD-SKIP: pure feature-flag key constant, no logic to test
/**
 * Bandera PostHog que controla toda la feature «Mi asistente» (asistente de
 * ventas Hermes en un clic, ola saleads-hermes-one-click-mvp-v1).
 *
 * Por defecto está apagada (`useFeatureFlag` devuelve `false` mientras PostHog
 * no responde): sin la bandera no se ve la entrada ni se llama a
 * `/api/sales-assistant/*`.
 */
export const SALES_ASSISTANT_FLAG = 'sales-assistant-enabled'
