/**
 * Configuración de saleads-sim. Todo sale de variables de entorno con valores
 * por defecto del contrato local (docs/CONTRATO-LOCAL.md). Los nombres de los
 * clientes, scopes y rutas son los de SaleADS dev: así ale-runtime, Hermes y
 * el CLI hablan con este servicio sin cambiar una línea.
 */

const list = (value: string | undefined, fallback: string[]): string[] => {
  if (value === undefined) return fallback;
  return value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
};

const int = (value: string | undefined, fallback: number): number => {
  const parsed = value === undefined ? NaN : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
};

const trimSlash = (value: string) => value.replace(/\/+$/, '');

export const DEMO_USER_ID = '00000000-0000-4000-a000-000000000001';
export const DEMO_BUSINESS_ID = 'a6b8e93d-386f-4141-96ff-4b49e137728a';

/** Los cinco scopes de SaleADS (sa-mcp-server `SUPPORTED_SCOPES`), en su orden canónico. */
export const SALEADS_SCOPES = ['saleads:read', 'saleads:strategy', 'saleads:campaigns', 'saleads:launch', 'saleads:events'] as const;
export type SaleadsScope = (typeof SALEADS_SCOPES)[number];

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const publicBaseUrl = trimSlash(env.SIM_PUBLIC_BASE_URL ?? 'https://saleads.local');
  const realm = env.SIM_REALM ?? 'sale-ads';
  const issuer = trimSlash(env.SIM_ISSUER ?? `${publicBaseUrl}/realms/${realm}`);
  const mcpUrl = env.SIM_MCP_URL ?? `${publicBaseUrl}/mcp`;
  return {
    port: int(env.PORT, 8090),
    dataDir: env.SIM_DATA_DIR ?? './data',
    publicBaseUrl,
    realm,
    /** `iss` de todos los tokens; ale-runtime lo exige https (KEYCLOAK_ISSUER). */
    issuer,
    /** Recurso canónico del MCP: `aud` del token del asistente (ale-runtime MCP_URL). */
    mcpUrl,
    /** Origen que se anuncia para el navegador en authorize (puede ser distinto del issuer). */
    authorizeBaseUrl: trimSlash(env.SIM_AUTHORIZE_BASE_URL ?? issuer),
    webClientId: env.SIM_WEB_CLIENT_ID ?? 'front',
    assistantClientId: env.SIM_ASSISTANT_CLIENT_ID ?? 'mcp-saleads-assistant-dev',
    /** Prefijos aceptados de redirect_uri (Keycloak valida la lista del cliente). */
    redirectPrefixes: list(env.SIM_REDIRECT_PREFIXES, [
      'http://localhost:3000/',
      'https://localhost/',
      'https://saleads.local/',
      'https://dev.saleads.ai/api/sales-assistant/oauth/callback',
    ]),
    accessTokenTtlS: int(env.SIM_ACCESS_TOKEN_TTL_S, 300),
    webTokenTtlS: int(env.SIM_WEB_TOKEN_TTL_S, 8 * 3600),
    refreshTokenTtlS: int(env.SIM_REFRESH_TOKEN_TTL_S, 30 * 86400),
    demoUserId: env.SIM_DEMO_USER_ID ?? DEMO_USER_ID,
    demoUserEmail: env.SIM_DEMO_USER_EMAIL ?? 'demo-owner@saleads.local',
    demoUserName: env.SIM_DEMO_USER_NAME ?? 'Dueña demo (simulado)',
    /** ale-runtime para el reenvío de Stock (`/internal/stock/...`). */
    metaAssistantUrl: trimSlash(env.SIM_META_ASSISTANT_URL ?? 'http://ale-runtime:8060'),
    /** = INTERNAL_API_TOKEN de ale-runtime. Vacío = las tools de Stock fallan como el MCP sin token. */
    metaAssistantToken: env.SIM_META_ASSISTANT_INTERNAL_TOKEN ?? '',
    /** Usuarios que ven las 15 `saleads_stock_*` (MCP_STOCK_TOOL_USER_IDS). */
    stockUserIds: list(env.SIM_STOCK_USER_IDS, [DEMO_USER_ID]),
    /** Comandos de solo lectura del Agent API (MCP_AGENT_API_COMMANDS de develop). */
    agentApiCommands: list(env.SIM_AGENT_API_COMMANDS, [
      'saleads_get_account_overview', 'saleads_get_business_bootstrap', 'saleads_get_business_profile',
      'saleads_list_offerings', 'saleads_get_meta_status', 'saleads_list_campaigns', 'saleads_get_campaign_ads',
      'saleads_get_campaign_health', 'saleads_get_box_metrics', 'saleads_get_results', 'saleads_get_operation',
      'saleads_get_help', 'saleads_search_locations',
    ]),
    /** Origen web de los enlaces de revisión de landings (MCP_LANDING_REVIEW_BASE_URL). */
    landingReviewBaseUrl: trimSlash(env.SIM_LANDING_REVIEW_BASE_URL ?? publicBaseUrl),
    /** Origen con el que se publican las landings (`url` exige https en el contrato). */
    landingPublicBaseUrl: trimSlash(env.SIM_LANDING_PUBLIC_BASE_URL ?? publicBaseUrl),
    /** Web de SaleADS para los handoffs (`action_url`). */
    webBaseUrl: trimSlash(env.SIM_WEB_BASE_URL ?? publicBaseUrl),
    /** Duración simulada de las operaciones async y espera síncrona (25 s en el real). */
    asyncDelayMs: int(env.SIM_ASYNC_DELAY_MS, 3000),
    syncWaitMs: int(env.SIM_SYNC_WAIT_MS, 25_000),
    sseHeartbeatMs: int(env.SIM_SSE_HEARTBEAT_MS, 15_000),
    stockTimeoutMs: int(env.SIM_STOCK_TIMEOUT_MS, 245_000),
    /** Banderas que PostHog responde siempre en verdadero (más las que pida el cliente). */
    posthogFlags: list(env.SIM_POSTHOG_FLAGS, ['sales-assistant-enabled', 'meta-assistant-enabled']),
    /** Orígenes del navegador que pueden llamar al gateway clásico. `*` = cualquiera (solo local). */
    corsOrigins: list(env.SIM_CORS_ORIGINS, ['*']),
    instanceId: env.HOSTNAME ?? 'saleads-sim',
    version: '0.1.0',
  };
}

export type SimConfig = ReturnType<typeof loadConfig>;
