/**
 * Configuración de Stock. Los umbrales son valores de ingeniería para la demo: viven aquí y no en el modelo.
 * Nada de este archivo se lee fuera de `src/stock` salvo `stockSettings`, que usa `main.ts`.
 */
export interface BusinessSeed {businessId: string; userId: string; currency: string}

export interface StockSettings {
  enabled: boolean;
  userIds: ReadonlySet<string>;
  seeds: readonly BusinessSeed[];
  webBaseUrl: string;
  benchEnabled: boolean;
  maxAutonomyLevel: number;
  /** Adaptador del canal con el proveedor. Vacío, enviar y esperar responden 503. */
  supplierChannel: '' | 'banco' | 'telegram';
  /** Destino fijo: lo lee solo el adaptador. Nunca sale al modelo ni a una respuesta. */
  supplierDestination: string;
  /** Nombre con el que se presenta el asistente virtual (R29). */
  supplierSenderName: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CURRENCY = /^[A-Z]{3}$/;

export const AUTONOMY_AREAS = ['inventario', 'reposicion', 'negociacion', 'ofertas'] as const;
export const INITIAL_AUTONOMY_LEVEL = 2;

/**
 * `business_id:user_id:moneda`. El `user_id` admite `:`, por eso se parte por los extremos. Un usuario fuera de
 * `STOCK_USER_IDS` detiene el arranque: habilitar un negocio que nadie puede usar sería un error de despliegue.
 */
export function parseBusinessSeeds(raw: readonly string[], userIds: ReadonlySet<string>): BusinessSeed[] {
  const seeds = new Map<string, BusinessSeed>();
  for (const item of raw) {
    const first = item.indexOf(':');
    const last = item.lastIndexOf(':');
    const businessId = item.slice(0, first);
    const userId = item.slice(first + 1, last);
    const currency = item.slice(last + 1);
    if (first < 1 || last <= first || !UUID.test(businessId) || !userId || !CURRENCY.test(currency)) {
      throw new Error('CONFIGURATION_INVALID: STOCK_BUSINESS_SEEDS format');
    }
    if (!userIds.has(userId)) throw new Error('CONFIGURATION_INVALID: STOCK_BUSINESS_SEEDS user outside STOCK_USER_IDS');
    if (!seeds.has(businessId)) seeds.set(businessId, {businessId, userId, currency});
  }
  return [...seeds.values()];
}

/** Umbrales de rotación (`architecture.md` §13). Clasifican señales: la decisión comercial es del agente. */
export const STOCK_ROTATION = {
  baselineWeeks: 8,
  minWeeksWithSales: 4,
  stopMinRate: 2,
  stopDays: 7,
  slowRate: 1,
  noAdsCoverageDays: 45,
  /** «Pegando» (IVB-024): ventana corta de ventas con la pauta, cuánto sobre lo previsto y el mínimo para no leer una sola venta. */
  hotWindowDays: 2,
  hotFactor: 1.5,
  hotMinUnits: 2,
} as const;

/** Reposición (`architecture.md` §13). */
export const STOCK_REORDER = {bufferDays: 3, horizonDays: 30} as const;

/**
 * Listas cerradas de la negociación, ya sin tildes y en minúscula. Filtran el texto del modelo antes de salir; lo que un
 * proveedor escriba nunca pasa por aquí. `paymentPromises` no incluye «podemos pagar»: ofrecer un precio no es pagar.
 */
export const STOCK_NEGOTIATION = {
  maxMessages: 12,
  /** Lo más que ve Stock de un tirón: un proveedor que escribe sin parar no llena el contexto del modelo. */
  maxShownMessages: 24,
  /** Sin actividad por este tiempo la negociación vence: la cola con el proveedor es una sola. */
  abandonedHours: 72,
  maxTextChars: 1000,
  /** Montos que el proveedor escribe sin marca: por debajo de esto se lee como cantidad o días, no como precio. */
  minPlainPrice: 1000,
  moneyWords: ['cien', 'ciento', 'doscientos', 'doscientas', 'trescientos', 'trescientas', 'cuatrocientos', 'cuatrocientas', 'quinientos', 'quinientas', 'seiscientos', 'seiscientas',
    'setecientos', 'setecientas', 'ochocientos', 'ochocientas', 'novecientos', 'novecientas', 'mil', 'millon', 'millones', 'lucas', 'palos', 'lukas', 'luquitas', 'barras', 'pesos', 'cop', 'usd', 'dolares'],
  paymentPromises: ['te pago', 'te pagamos', 'le pago', 'le pagamos', 'pagamos hoy', 'pago hoy', 'ya pague', 'ya pagamos', 'ya te pague', 'te transfiero', 'te transferimos', 'te consigno', 'te consignamos',
    'te giro', 'te giramos', 'anticipo', 'abono', 'pago confirmado', 'pago garantizado', 'queda pagado'],
  closingPhrases: ['acepto', 'aceptamos', 'aceptado', 'de acuerdo', 'me sirve', 'nos sirve', 'trato hecho', 'cerramos', 'cerrado', 'compra cerrada', 'te compro', 'te compramos', 'lo compramos', 'lo compro', 'quedamos en', 'confirmo la compra', 'confirmamos la compra'],
  falseIdentity: ['soy el dueno', 'soy la duena', 'soy humano', 'soy humana', 'no soy un bot', 'no soy un robot', 'no soy asistente', 'no soy una ia', 'soy una persona'],
  /** Marca un mensaje entrante: es dato, y aquí se le avisa a Stock que además trae una orden. */
  injectionHints: ['ignora', 'olvida tus', 'instrucciones', 'instruccion', 'system prompt', 'nuevo mandato', 'sube el tope', 'tu tope', 'eres ahora', 'modo administrador', 'autorizado por'],
} as const;

/** Reglas de ingeniería de la demo. No son decisiones comerciales: esas son del agente. */
export const STOCK_LIMITS = {
  proposalTtlHours: 72,
  textMax: 300,
  voiceWindowSeconds: 180,
  /** Canal es atestiguado: un Ale engañado no reescribe todo el inventario de una sola vez. */
  channelBurstMax: 3,
  channelBurstSeconds: 600,
  similarityThreshold: 0.6,
  /** R15: dos cajas de la misma imagen son el mismo objeto desde este IoU. */
  variantOverlapIou: 0.5,
  recountEventTtlMinutes: 30,
  eventTtlMinutes: 30,
  eventRedeliverSeconds: 60,
  presenceTimeoutSeconds: 45,
  photoRetries: 2,
  photoPutTtlSeconds: 300,
  photoGetTtlSeconds: 900,
  /** Ciclo de vida del bucket (`docs/stock-operacion.md`): pasado esto el objeto ya no existe y la foto se declara vencida. */
  photoRetentionDays: 30,
  staleCountDays: 14,
  wakesPerDay: 8,
  wakeDebounceSeconds: 120,
  syncKickDebounceSeconds: 60,
  autonomyRepeatDays: 7,
  noticesPerDay: 3,
  noticeProductHours: 24,
  noticeStartHour: 7,
  noticeEndHour: 21,
  noticeTtlHours: 6,
  noticeTemplateHoldSeconds: 120,
  noticeContextSeconds: 180,
  /** 15 MB tras base64. Un archivo mayor pasa a revisión manual sin llamar al modelo. */
  documentMaxBytes: 15 * 1024 * 1024,
  documentPutTtlSeconds: 300,
  /** Plazo de una extracción en curso: pasado esto, un pod caído no deja el documento trabado. */
  documentClaimSeconds: 300,
  /** Tope de `facturas_sin_procesar` en `overview`: las más viejas primero. */
  unprocessedInvoices: 10,
  extractTimeoutMs: 120_000,
  extractAttempts: 2,
  extractionsPerDay: 20,
  invoiceConfidence: 0.8,
  invoiceRoundingUnits: 1,
  /** Fotos con la misma etiqueta dentro de este plazo son un mismo conteo, aunque Stock no pase `photo_id`. */
  photoCountWindowMinutes: 60,
  utteranceRetentionDays: 7,
  maintenanceIntervalMs: 3_600_000,
  retentionIntervalMs: 86_400_000,
  supplierPollMs: 5_000,
  supplierWaitPollMs: 1_000,
} as const;
