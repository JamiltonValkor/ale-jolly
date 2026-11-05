import {z} from 'zod';

/**
 * Configuración del servicio. Adaptado de 9282e1b:src/config.ts: sin la regla
 * de mismo origen issuer/JWKS (el JWKS es el Keycloak interno por HTTP, porque
 * el público pasa por Cloudflare y da 403 desde GKE), sin el literal de la base
 * vieja y sin el proveedor de banderas anterior (la bandera es PostHog).
 */
const url = (protocols: readonly string[]) => z.string().url().refine(value => {
  const parsed = new URL(value);
  return protocols.includes(parsed.protocol) && !parsed.username && !parsed.password;
});
const csv = z.string().min(1).transform(value => value.split(',').map(item => item.trim()))
  .refine(items => items.every(Boolean));

const schema = z.object({
  PORT: z.coerce.number().int().min(1024).max(65535).default(8060),
  DATABASE_URL: z.string().url().refine(value => ['postgres:', 'postgresql:'].includes(new URL(value).protocol)),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(20).default(5),
  // Managed Meta Assistant. All-account admission is opt-in; web auth and the backend flag remain required.
  FIRST_LOOP_ENABLED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  MANAGED_META_ENABLED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  MANAGED_META_ALL_USERS: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  // Canal robot (Ale en una Raspberry): apagado por defecto. Apagado = las rutas /devices/* no existen.
  ROBOT_CHANNEL_ENABLED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  ROBOT_PAIRING_TTL_MS: z.coerce.number().int().min(60_000).max(3_600_000).default(600_000),
  ROBOT_MAX_PENDING_PAIRINGS: z.coerce.number().int().min(1).max(10_000).default(200),
  // Página del front para reclamar el código (el robot la muestra como QR con `?code=`). Vacío = solo el código.
  ROBOT_CLAIM_URL: z.union([z.literal(''), url(['https:', 'http:'])]).default(''),
  // Stock (inventario-vivo-v1): apagado por defecto. Apagado = sin rutas, sin consultas y sin procesos (src/stock).
  STOCK_ENABLED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  // `csv` rechaza vacío, y vacío es el valor normal de estas dos llaves.
  STOCK_USER_IDS: z.string().default('').transform(value => value.split(',').map(item => item.trim()).filter(Boolean)),
  STOCK_BUSINESS_SEEDS: z.string().default('').transform(value => value.split(',').map(item => item.trim()).filter(Boolean)),
  STOCK_WEB_BASE_URL: z.union([z.literal(''), url(['https:'])]).default(''),
  STOCK_ADDON_DIR: z.string().min(1).default('distribution/stock-addon/1.0.8'),
  STOCK_BRAIN_IMAGE: z.string().regex(/^$|^[a-z0-9.-]+\/[^@\s]+@sha256:[a-f0-9]{64}$/).default(''),
  STOCK_BUCKET: z.string().regex(/^$|^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/).default(''),
  STOCK_RELAY_URL: z.union([z.literal(''), url(['https:'])]).default(''),
  STOCK_RELAY_KEY: z.string().trim().max(512).default(''),
  STOCK_BENCH_ENABLED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  STOCK_MAX_AUTONOMY_LEVEL: z.coerce.number().int().min(1).max(4).default(2),
  STOCK_TOOL_WAIT_MS: z.coerce.number().int().min(1_000).max(240_000).default(240_000),
  STOCK_SYNC_INTERVAL_MS: z.coerce.number().int().min(60_000).max(3_600_000).default(300_000),
  STOCK_EXTRACT_MODEL: z.string().trim().max(160).default(''),
  STOCK_SUPPLIER_CHANNEL: z.enum(['', 'banco', 'telegram']).default(''),
  // Bot de Telegram del proveedor, propio de ale-runtime y distinto del bot del asistente. Solo con canal `telegram`.
  STOCK_SUPPLIER_TELEGRAM_TOKEN: z.string().trim().max(200).default(''),
  STOCK_SUPPLIER_DESTINATION: z.string().trim().max(200).default(''),
  STOCK_SUPPLIER_SENDER_NAME: z.string().trim().max(120).default(''),
  MANAGED_META_USER_ID: z.string().trim().max(160).default(''),
  MANAGED_META_RELAY_BASE_URL: z.union([z.literal(''), url(['https:'])])
    .refine(value => !value || (!new URL(value).search && !new URL(value).hash))
    .default('').transform(value => value.replace(/\/$/, '')),
  MANAGED_META_API_KEY: z.string().trim().max(4096).default(''),
  // `iss` real de los tokens web de dev: https://keycloak-dev.saleads.ai/realms/sale-ads
  KEYCLOAK_ISSUER: url(['https:']),
  // La ubicación del JWKS es configuración, nunca la elige un `jku`/`x5u` del token.
  KEYCLOAK_JWKS_URL: url(['http:', 'https:']),
  // La audiencia solo se valida si tiene valor: el token de `front` no trae mapper de audiencia.
  OIDC_AUDIENCE: z.string().trim().default(''),
  OIDC_ALLOWED_CLIENTS: csv.default(['front']),
  POSTHOG_API_KEY: z.string().trim().min(1),
  POSTHOG_HOST: url(['https:']).default('https://posthog.saleads.ai'),
  ASSISTANT_FLAG_KEY: z.string().min(1).max(100).default('sales-assistant-enabled'),
  // Solo se cachean respuestas booleanas; 0 desactiva la caché.
  ASSISTANT_FLAG_CACHE_TTL_MS: z.coerce.number().int().min(0).max(300_000).default(30_000),
  // Clave AES-256-GCM de los campos cifrados (base64 de 32 bytes), desde el ExternalSecret.
  FIELD_ENCRYPTION_KEY: z.string().refine(value => Buffer.from(value, 'base64').byteLength === 32),
  // Cloudflare responde 403 al User-Agent por defecto (prueba real OCB-002, G-01).
  OUTBOUND_USER_AGENT: z.string().min(8).max(200).regex(/^[\x20-\x7e]+$/).default('SaleADS-Assistant-Service/0.1 (+https://saleads.ai)'),
  OUTBOUND_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(10_000),

  // --- Acceso propio del asistente al MCP (OCB-007; cliente público + PKCE, OCB-002 opción A) ---
  ASSISTANT_OAUTH_CLIENT_ID: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/).default('mcp-saleads-assistant-dev'),
  // Debe estar entre los redirects del cliente; el BFF no lo envía (OCF-002).
  ASSISTANT_OAUTH_REDIRECT_URI: url(['https:', 'http:']).default('https://dev.saleads.ai/api/sales-assistant/oauth/callback'),
  ASSISTANT_OAUTH_SCOPE: z.string().regex(/^[\x21-\x7e]+( [\x21-\x7e]+)*$/).max(500)
    .default('openid offline_access saleads-mcp saleads:read saleads:strategy saleads:campaigns saleads:launch saleads:events'),
  ASSISTANT_OAUTH_FLOW_TTL_MS: z.coerce.number().int().min(60_000).max(3_600_000).default(600_000),
  // Navegador → Keycloak público. Vacío = `${KEYCLOAK_ISSUER}/protocol/openid-connect/auth`.
  KEYCLOAK_AUTHORIZE_URL: z.union([z.literal(''), url(['https:'])]).default(''),
  // Canje y refresh por el Keycloak INTERNO (el público da 403 desde GKE). El `iss` sigue siendo KEYCLOAK_ISSUER.
  KEYCLOAK_TOKEN_URL: url(['http:', 'https:']).default('http://keycloak.keycloak.svc.cluster.local:8080/realms/sale-ads/protocol/openid-connect/token'),
  // RFC 7009 por el Keycloak INTERNO: revoca la sesión offline del asistente al borrar (OCB-009/012).
  KEYCLOAK_REVOKE_URL: url(['http:', 'https:']).default('http://keycloak.keycloak.svc.cluster.local:8080/realms/sale-ads/protocol/openid-connect/revoke'),
  // --- Renovación de la credencial del asistente (OCB-009) ---
  ASSISTANT_RENEWAL_ENABLED: z.enum(['true', 'false']).default('true').transform(value => value === 'true'),
  // Edad de la credencial guardada a partir de la cual se renueva y se resiembra (~7 días; idle offline = 30 días).
  ASSISTANT_RENEWAL_MAX_AGE_MS: z.coerce.number().int().min(3_600_000).max(25 * 86_400_000).default(7 * 86_400_000),
  ASSISTANT_RENEWAL_SWEEP_INTERVAL_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(6 * 3_600_000),
  ASSISTANT_RENEWAL_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(25),
  // Ventana mínima entre resiembras disparadas por fallos del MCP o por GET /me, por usuario.
  ASSISTANT_RENEWAL_RETRY_DEBOUNCE_MS: z.coerce.number().int().min(0).max(3_600_000).default(60_000),
  // Recurso canónico del MCP: va en config.yaml y es la audiencia exigida al token del asistente.
  MCP_URL: url(['https:']).default('https://dev.saleads.ai/mcp'),
  // AAB-005 (saleads-api-agencial-v1): origen de la Agent API /agent/v1 para el CLI de la VM. Vacío = el CLI cae
  // al origen de MCP_URL. Lo escribe el servicio en skills/saleads-cli/config.json: el agente no elige el host.
  AGENT_API_URL: z.union([z.literal(''), url(['https:'])]).default(''),
  // Web de SaleADS para los enlaces que Ale le manda al dueño (`saleads web`): sin ella, Ale no inventa direcciones.
  WEB_APP_URL: z.union([z.literal(''), url(['https:'])]).default(''),
  // MLB-013: ejecutores de aprobaciones de gasto, dentro del clúster (mismos endpoints que la web).
  STRATEGY_SERVICE_URL: url(['http:', 'https:']).default('http://strategy-service:8005'),
  CAMPAIGN_SERVICE_URL: url(['http:', 'https:']).default('http://campaign-service:8009'),
  INTEGRATION_SERVICE_URL: url(['http:', 'https:']).default('http://integration-service:4010'),
  SPEND_EXECUTOR_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(60_000),
  // AAB-012 (saleads-api-agencial-v1): encender lo que publicó el agente. Apagada hasta desplegar AAF-001 (C-31).
  AGENT_ACTIVATION_APPROVALS_ENABLED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  // MCB-012: los especialistas solo leen del MCP lo que sirve al canal del agente (lista exacta por especialista).
  SPECIALIST_EXPLICIT_READS_ENABLED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  // MCB-010 (D16/D17/D19): web_search nativo de la suscripción ChatGPT para el investigador, solo con openai-codex.
  // Solo escribe la capa: en Hermes a28a5d03 el probe de openai-native mira únicamente profiles/investigador/auth.json
  // y no hay mecanismo de credencial aprobado (compuerta grupo C, pasos 13/42). Apagada hasta validarla en el lab.
  RESEARCHER_NATIVE_SEARCH_ENABLED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  // C-18: escribir el rechazo del dueño en la traza del agente (CS AAB-010).
  AGENT_TRACE_WRITER_ENABLED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  SUBSCRIPTION_SERVICE_URL: url(['http:', 'https:']).default('http://subscription-service:8010'),
  // AAB-013: empuje del conocimiento del cerebro a BI (knowledge-sync interno, directo en el clúster, cabecera
  // x-internal-token con SALEADS_SERVICES_INTERNAL_TOKEN). Sondeo de la foto nueva cada 5 min (mínimo 60 s).
  BI_SERVICE_URL: url(['http:', 'https:']).default('http://business-intelligence-service:4011'),
  KNOWLEDGE_SYNC_ENABLED: z.enum(['true', 'false']).default('true').transform(value => value === 'true'),
  KNOWLEDGE_SYNC_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  BRAIN_SNAPSHOT_POLL_ENABLED: z.enum(['true', 'false']).default('true').transform(value => value === 'true'),
  BRAIN_SNAPSHOT_POLL_INTERVAL_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(300_000),
  // C-9/V-A7: token interno común (remoteRef saleads-dev-common-INTERNAL_API_TOKEN) para CS, STR y SUB. Vacío = esas
  // llamadas fallan cerrado y el encendido del agente queda `failed`.
  SALEADS_SERVICES_INTERNAL_TOKEN: z.union([z.literal(''), z.string().min(32).max(512).regex(/^[\x21-\x7e]+$/)]).default(''),
  // --- ORQA cliente: rutas /internal que llama el MCP (OSB-013). Vacío = esas rutas responden 503. ---
  INTERNAL_API_TOKEN: z.union([z.literal(''), z.string().min(32).max(512).regex(/^[\x21-\x7e]+$/)]).default(''),
  // --- ORQA cliente: admins del buzón del Cerebro SaleADS (sub de Keycloak, separados por coma). Vacío = nadie. ---
  BRAIN_HUB_ADMIN_USER_IDS: z.string().default('').transform(value => value.split(',').map(item => item.trim()).filter(Boolean)),

  // --- VM del asistente (Compute Engine, Workload Identity por el metadata server) ---
  GCP_PROJECT: z.string().regex(/^[a-z][-a-z0-9]{4,28}[a-z0-9]$/).default('saleads-dev'),
  GCP_ZONE: z.string().regex(/^[a-z]+-[a-z]+[0-9]-[a-z]$/).default('us-central1-a'),
  // Empty preserves existing VM names/idempotency. Isolated deployments also require separate state.
  ASSISTANT_RUNTIME_NAMESPACE: z.string().regex(/^$|^[a-z][a-z0-9-]{0,31}$/).default(''),
  ASSISTANT_INSTANCE_TEMPLATE: z.string()
    .regex(/^projects\/[a-z][-a-z0-9]{4,28}[a-z0-9]\/global\/instanceTemplates\/[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/)
    .default('projects/saleads-dev/global/instanceTemplates/sa-assistant-oneclick-dev-20261015162357982000000001'),
  COMPUTE_API_BASE: url(['https:', 'http:']).default('https://compute.googleapis.com/compute/v1'),
  GCP_METADATA_TOKEN_URL: url(['http:']).default('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token'),
  // Cuánto se sigue la operación de instances.insert para detectar un fallo de creación.
  COMPUTE_OPERATION_TIMEOUT_MS: z.coerce.number().int().min(0).max(600_000).default(120_000),
  COMPUTE_RETRY_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(3_000),

  // --- Bundle SOUL + skills (relativo al directorio de trabajo: /app en la imagen) ---
  ASSISTANT_BUNDLE_DIR: z.string().min(1).default('distribution/saleads-sales-agent/1.3.0'),
  ASSISTANT_BUNDLE_VERSION: z.string().regex(/^[A-Za-z0-9._@/-]{1,128}$/).default('saleads-sales-agent@1.3.0'),
  // MCB-003 (D21/D24): cada versión nueva actualiza el texto de las vueltas de SaleADS de los asistentes existentes
  // (no las del dueño ni las de Ale, ni las editadas; nunca recrea las borradas). Apagada = solo crea las que faltan.
  ORQA_JOB_UPDATES_ENABLED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  // Espera tras un sync de ORQA fallido antes de reintentarlo con el mismo usuario.
  ORQA_SYNC_RETRY_AFTER_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(600_000),
  // MCB-020 (D21/D25): barrido de servidor que lleva cada versión nueva a los asistentes listos aunque el dueño no
  // abra la web. En serie, con pausa entre VMs; las del laboratorio (sa-assistant-sim-*) quedan fuera por defecto.
  ORQA_SYNC_SWEEP_ENABLED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  ORQA_SYNC_SWEEP_DELAY_MS: z.coerce.number().int().min(0).max(3_600_000).default(120_000),
  ORQA_SYNC_SWEEP_INTERVAL_MS: z.coerce.number().int().min(60_000).max(7 * 86_400_000).default(6 * 3_600_000),
  ORQA_SYNC_SWEEP_PAUSE_MS: z.coerce.number().int().min(0).max(600_000).default(20_000),
  ORQA_SYNC_SWEEP_INCLUDE_LAB: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  // --- ORQA cliente (OSB-009): imagen privada del cerebro en Artifact Registry. Vacío = ORQA apagado. ---
  BRAIN_IMAGE: z.union([
    z.literal(''),
    // Fijada por digest: el watcher rechaza un tag (vm/startup-script.sh, ensure_brain).
    z.string().regex(/^us-central1-docker\.pkg\.dev\/[a-z][-a-z0-9]{4,28}[a-z0-9]\/saleads-brain\/[a-z0-9._-]+(?::[A-Za-z0-9._-]{1,128})?@sha256:[0-9a-f]{64}$/),
  ]).default(''),
  // Semilla del cerebro (OSB-007): GET firmado ≤ 1 h, barrido diario y plazo por tool del MCP.
  SEED_URL_TTL_SECONDS: z.coerce.number().int().min(300).max(3600).default(3600),
  SEED_SWEEP_INTERVAL_MS: z.coerce.number().int().min(60_000).max(7 * 86_400_000).default(86_400_000),
  SEED_TOOL_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(300_000).default(90_000),

  // --- Estado y readiness (OCB-008) y configuración de la IA (OCB-010) ---
  HERMES_API_PORT: z.coerce.number().int().min(1).max(65535).default(8642),
  READINESS_HEALTH_TIMEOUT_MS: z.coerce.number().int().min(200).max(10_000).default(3_000),
  // GET /assistants/me nunca espera más que esto a Compute + Hermes (AC: < 4 s).
  READINESS_BUDGET_MS: z.coerce.number().int().min(200).max(3_900).default(3_500),
  READINESS_CACHE_TTL_MS: z.coerce.number().int().min(0).max(60_000).default(5_000),
  // VM ausente o apagada durante la activación: se espera esto antes de declararlo.
  READINESS_TRANSITION_GRACE_MS: z.coerce.number().int().min(0).max(900_000).default(90_000),
  AI_CONFIGURE_DEADLINE_MS: z.coerce.number().int().min(5_000).max(89_000).default(85_000),
  AI_ACK_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(85_000).default(60_000),
  AI_PROBE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(85_000).default(45_000),
  AI_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(10_000).default(2_000),
  // --- Proxy del chat (OCB-011) ---
  // Crear la sesión y leer el historial en Hermes.
  CHAT_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(10_000),
  // Tope total de un turno (el idle del gateway es 600 s; un turno con muchas tools puede pasar de 1 min).
  CHAT_TURN_MAX_MS: z.coerce.number().int().min(60_000).max(3_600_000).default(1_800_000),
  // Sin bytes de Hermes (manda keepalive cada 10 s) durante esto → se corta el turno con `error`.
  CHAT_UPSTREAM_IDLE_MS: z.coerce.number().int().min(15_000).max(590_000).default(60_000),
  // Comentario keepalive hacia el BFF/gateway, muy por debajo del idle de 600 s.
  CHAT_HEARTBEAT_MS: z.coerce.number().int().min(1_000).max(300_000).default(15_000),
  // --- Desactivar, reactivar y borrar (OCB-012) ---
  // Bucket de memorias archivadas y GSA que firma las signed URL (signBlob vía IAM Credentials, sin key).
  ASSISTANT_MEMORIES_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/).default('saleads-dev-assistant-memories'),
  ASSISTANT_SIGNER_EMAIL: z.string().regex(/^[a-z][-a-z0-9]{4,28}[a-z0-9]@[a-z][-a-z0-9]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/)
    .default('sa-assistant-service@saleads-dev.iam.gserviceaccount.com'),
  STORAGE_API_BASE: url(['https:', 'http:']).default('https://storage.googleapis.com'),
  // Solo entornos locales: la foto de una propuesta que ve el navegador sale por esta base en vez de storage.googleapis.com.
  STOCK_PHOTO_WEB_BASE: url(['https:', 'http:']).optional(),
  IAM_CREDENTIALS_API_BASE: url(['https:', 'http:']).default('https://iamcredentials.googleapis.com/v1'),
  ARCHIVE_URL_TTL_SECONDS: z.coerce.number().int().min(300).max(3600).default(900),
  // GET firmado del último archivo para la VM nueva (D50): cubre el arranque y los reintentos del
  // watcher; si vence antes, la VM nace sin memorias. Máximo de V4: 7 días.
  RESTORE_URL_TTL_SECONDS: z.coerce.number().int().min(300).max(604_800).default(86_400),
  ARCHIVE_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(1_800_000).default(600_000),
  VM_DELETE_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(1_800_000).default(300_000),
  LIFECYCLE_POLL_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(5_000),
}).superRefine((value, context) => {
  if (!value.MANAGED_META_ENABLED) return;
  const required = value.MANAGED_META_ALL_USERS ? ['MANAGED_META_API_KEY', 'MANAGED_META_RELAY_BASE_URL'] as const : ['MANAGED_META_USER_ID', 'MANAGED_META_API_KEY'] as const;
  for (const key of required) {
    if (!value[key]) context.addIssue({code: 'custom', path: [key], message: 'required for managed Meta'});
  }
});

export type ServiceConfig = z.infer<typeof schema>;

export function configuration(input: NodeJS.ProcessEnv): ServiceConfig {
  const result = schema.safeParse(input);
  // Nunca se imprime el valor recibido: puede contener secretos.
  if (!result.success) throw new Error(`CONFIGURATION_INVALID: ${result.error.issues.map(issue => issue.path.join('.')).join(',')}`);
  const config = result.data;
  if (!config.KEYCLOAK_AUTHORIZE_URL) config.KEYCLOAK_AUTHORIZE_URL = `${config.KEYCLOAK_ISSUER.replace(/\/$/, '')}/protocol/openid-connect/auth`;
  return config;
}
