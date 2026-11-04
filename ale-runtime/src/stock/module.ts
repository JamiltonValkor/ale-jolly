import type {Pool} from 'pg';
import type {OutboundFetch} from '../outbound/http-client';
import {serviceUnavailable} from '../domain/errors';
import {StockAccess} from './access';
import {StockClock} from './clock';
import {Autonomy} from './autonomy';
import {AUTONOMY_AREAS, INITIAL_AUTONOMY_LEVEL, parseBusinessSeeds, type StockSettings} from './config';
import {DeviceOps} from './device-ops';
import {StockDocuments, type DocumentStore, type InvoiceModel} from './documents';
import {createLedger, type StockLedger} from './ledger';
import {StockMaintenance} from './maintenance';
import {Negotiation} from './negotiation';
import {Notices} from './notices';
import {mcpOfferingsReader, type OfferingsReader, type OfferingsReaderDeps} from './offerings';
import {StockPhotos, type PhotoStore} from './photos';
import {Proposals} from './proposals';
import {StockReads} from './reads';
import {Rotation} from './rotation';
import {nestedStockDb, poolStockDb, type StockDb} from './store';
import {BenchSupplierChannel, type SupplierChannel} from './supplier-channel';
import {TELEGRAM_BOT_TOKEN, TELEGRAM_USER_ID, TelegramSupplierChannel} from './supplier-telegram';
import {Suppliers} from './suppliers';
import {StockAlerts} from './alerts';
import {StockSyncDriver, type StockSyncDeps} from './sync-driver';
import {StockUsage} from './usage';
import {StockWake, type WakeVm} from './wake';

export interface StockDeps {
  pool: Pick<Pool, 'query'>;
  /** Por defecto, el pool. Las pruebas con PGlite inyectan su propia transacción. */
  db?: StockDb;
  /** Lectura de ofertas con el MCP y el token del dueño. Sin ella, ligar una oferta responde 503. */
  ownerMcp?: OfferingsReaderDeps;
  offerings?: OfferingsReader;
  /** Idioma del asistente para el enlace profundo. */
  locale?(userId: string): Promise<string | null>;
  /** Propiedad del negocio: 404 si es ajeno, 503 si no se puede saber. */
  assertOwned?(userId: string, businessId: string): Promise<void>;
  now?: () => Date;
  /** Bucket de fotos. Sin él (`STOCK_BUCKET` vacío), pedir foto responde 503. */
  photoStore?: PhotoStore;
  /** Bucket de documentos. Sin él, registrar responde 503. */
  documentStore?: DocumentStore;
  /** Extracción de facturas. Sin `STOCK_EXTRACT_MODEL` no hay modelo, y extraer responde 503. */
  invoiceModel?: InvoiceModel;
  /** `STOCK_TOOL_WAIT_MS`. */
  toolWaitMs?: number;
  /** Keepalive de la conexión de eventos. */
  heartbeatMs?: number;
  /** Acceso a la VM para despertar a Ale. Sin él, `wake` responde `no_disponible`. */
  vm?: WakeVm;
  /** Reemplaza `StockWake` en pruebas del canal robot. */
  wake?: StockWake['wake'];
  /** Reemplaza el adaptador de `STOCK_SUPPLIER_CHANNEL`. */
  supplierChannel?: SupplierChannel;
  /** Canal `telegram`: token del bot del proveedor y cliente HTTP saliente. Sin esto, el canal queda apagado (503). */
  supplierTelegram?: {token: string; fetcher: OutboundFetch};
  /** Sincronización sin web. Sin esto no hay temporizador. */
  sync?: Omit<StockSyncDeps, 'userIds' | 'now'> & {intervalMs: number};
}

/** Lo que el resto del servicio conoce de Stock. Su ausencia significa apagado. */
export interface StockRuntime {
  settings: StockSettings;
  db: StockDb;
  clock: StockClock;
  ledger: StockLedger;
  proposals: Proposals;
  reads: StockReads;
  autonomy: Autonomy;
  notices: Notices;
  alerts: StockAlerts;
  rotation: Rotation;
  access: StockAccess;
  photos: StockPhotos;
  documents: StockDocuments;
  suppliers: Suppliers;
  negotiation: Negotiation;
  usage: StockUsage;
  /** Caducidad y retención. Solo existe encendido: con `STOCK_ENABLED=false` no corre nada. */
  maintenance: StockMaintenance;
  deviceOps: DeviceOps;
  wake: StockWake['wake'];
  /** Solo con inferencia gestionada: sin ella, `afterSync` correría en cada llamada. */
  syncDriver?: StockSyncDriver;
  /** Negocios habilitados del usuario, o vacío si no es usuario de Stock. */
  enabledBusinesses(userId: string): Promise<string[]>;
}

export function stockSettings(config: {
  STOCK_ENABLED: boolean; STOCK_USER_IDS: string[]; STOCK_BUSINESS_SEEDS: string[]; STOCK_WEB_BASE_URL: string;
  STOCK_BENCH_ENABLED: boolean; STOCK_MAX_AUTONOMY_LEVEL: number;
  STOCK_SUPPLIER_CHANNEL?: '' | 'banco' | 'telegram'; STOCK_SUPPLIER_DESTINATION?: string; STOCK_SUPPLIER_SENDER_NAME?: string;
  STOCK_SUPPLIER_TELEGRAM_TOKEN?: string;
}): StockSettings {
  const userIds = new Set(config.STOCK_USER_IDS);
  const {STOCK_SUPPLIER_CHANNEL: supplierChannel = '', STOCK_SUPPLIER_DESTINATION: supplierDestination = '', STOCK_SUPPLIER_SENDER_NAME: supplierSenderName = ''} = config;
  if (config.STOCK_ENABLED && supplierChannel === 'banco' && (!supplierDestination || !config.STOCK_BENCH_ENABLED)) throw new Error('CONFIGURATION_INVALID: STOCK_SUPPLIER_CHANNEL');
  // Telegram: el destino es el id numérico de una persona y el bot es propio. El token no se guarda en los ajustes.
  if (config.STOCK_ENABLED && supplierChannel === 'telegram'
    && (!TELEGRAM_USER_ID.test(supplierDestination) || !TELEGRAM_BOT_TOKEN.test(config.STOCK_SUPPLIER_TELEGRAM_TOKEN ?? ''))) throw new Error('CONFIGURATION_INVALID: STOCK_SUPPLIER_CHANNEL');
  return {
    enabled: config.STOCK_ENABLED, userIds,
    seeds: config.STOCK_ENABLED ? parseBusinessSeeds(config.STOCK_BUSINESS_SEEDS, userIds) : [],
    webBaseUrl: config.STOCK_WEB_BASE_URL, benchEnabled: config.STOCK_BENCH_ENABLED, maxAutonomyLevel: config.STOCK_MAX_AUTONOMY_LEVEL,
    supplierChannel, supplierDestination, supplierSenderName,
  };
}

/**
 * Fábrica de Stock. Apagado devuelve `undefined` sin tocar la base. Encendido habilita los negocios sembrados con
 * DML de configuración idempotente (el DDL es de Flyway) y sus cuatro áreas de autonomía en nivel 2.
 */
export async function buildStock(settings: StockSettings, deps: StockDeps): Promise<StockRuntime | undefined> {
  if (!settings.enabled) return undefined;
  for (const seed of settings.seeds) {
    await deps.pool.query(
      `INSERT INTO assistant.stock_enabled_businesses(business_id, user_id, currency) VALUES ($1, $2, $3)
       ON CONFLICT (business_id) DO NOTHING`, [seed.businessId, seed.userId, seed.currency]);
    for (const area of AUTONOMY_AREAS) {
      await deps.pool.query(
        `INSERT INTO assistant.stock_autonomy(business_id, area, level) VALUES ($1, $2, $3)
         ON CONFLICT (business_id, area) DO NOTHING`, [seed.businessId, area, INITIAL_AUTONOMY_LEVEL]);
    }
  }
  const db = deps.db ?? poolStockDb(deps.pool);
  const clock = new StockClock(db, deps.now);
  const offerings = deps.offerings ?? (deps.ownerMcp ? mcpOfferingsReader(deps.ownerMcp) : {find: async () => {throw serviceUnavailable();}});
  const now = deps.now ?? (() => new Date());
  const autonomy = new Autonomy(db, settings);
  const usage = new StockUsage({db, clock, now, benchEnabled: settings.benchEnabled});
  const notices = new Notices({db, clock, settings, now, usage});
  const rotation = new Rotation({db, clock, offerings});
  const stockWake = new StockWake({db, now, vm: deps.vm, usage});
  const wake: StockWake['wake'] = deps.wake ?? ((userId, businessId, reason) => stockWake.wake(userId, businessId, reason));
  const suppliers = new Suppliers({db, clock, rotation});
  const alerts = new StockAlerts({db, clock, rotation, suppliers, notices});
  const proposals = new Proposals({db, clock, offerings, rotation, suppliers, wake, benchEnabled: settings.benchEnabled, autonomy, notices, webBaseUrl: settings.webBaseUrl, locale: deps.locale,
    photoStore: deps.photoStore, now});
  const benchChannel = settings.supplierChannel === 'banco' ? new BenchSupplierChannel(settings.supplierDestination) : undefined;
  const telegramChannel = settings.supplierChannel === 'telegram' && deps.supplierTelegram
    ? new TelegramSupplierChannel(settings.supplierDestination, deps.supplierTelegram.token, deps.supplierTelegram.fetcher) : undefined;
  const negotiation = new Negotiation({db, clock, autonomy, notices, wake, senderName: settings.supplierSenderName, channel: deps.supplierChannel ?? benchChannel ?? telegramChannel,
    waitMs: deps.toolWaitMs ?? 240_000, now});
  const access = new StockAccess({db, settings, assertOwned: deps.assertOwned ?? (async () => {throw serviceUnavailable();})});
  const photos = new StockPhotos({db, clock, store: deps.photoStore, waitMs: deps.toolWaitMs ?? 240_000, now, usage});
  const documents = new StockDocuments({db, clock, now, usage, benchEnabled: settings.benchEnabled, store: deps.documentStore, model: deps.invoiceModel});
  const syncDriver = deps.sync ? new StockSyncDriver({intervalMs: deps.sync.intervalMs}, {...deps.sync, userIds: settings.userIds, now}) : undefined;
  /**
   * IVB-024 (P8): `bench_seed` es atómico. Propuestas, libro, avisos y uso de un lote van en una sola transacción, con
   * todo lo que lee o escribe atado a ella. Despertar a Ale es una llamada afuera: se guarda y sale solo si el lote cerró.
   */
  const atomicProposals = async <T>(work: (scoped: Proposals) => Promise<T>): Promise<T> => {
    const deferred: Array<() => Promise<unknown>> = [];
    const result = await db.tx(async tx => {
      const sdb = nestedStockDb(tx);
      const sclock = new StockClock(sdb, deps.now);
      const susage = new StockUsage({db: sdb, clock: sclock, now, benchEnabled: settings.benchEnabled});
      const srotation = new Rotation({db: sdb, clock: sclock, offerings});
      const later: StockWake['wake'] = async (...args) => {deferred.push(() => wake(...args)); return 'solicitado';};
      return work(new Proposals({db: sdb, clock: sclock, offerings, rotation: srotation, suppliers: new Suppliers({db: sdb, clock: sclock, rotation: srotation}), wake: later,
        benchEnabled: settings.benchEnabled, autonomy: new Autonomy(sdb, settings), notices: new Notices({db: sdb, clock: sclock, settings, now, usage: susage}),
        webBaseUrl: settings.webBaseUrl, locale: deps.locale, photoStore: deps.photoStore, now}));
    });
    for (const call of deferred) await call().catch(() => undefined);
    return result;
  };
  const deviceOps = new DeviceOps({db, settings, photos, proposals, atomicProposals, access, clock, now, notices, heartbeatMs: deps.heartbeatMs ?? 15_000, wake, usage,
    ...(benchChannel ? {supplierReply: (text: string) => void benchChannel.reply(text)} : {}),
    ...(syncDriver ? {kick: (userId: string) => syncDriver.kick(userId)} : {})});
  return {
    settings, db, clock, ledger: createLedger(db), autonomy, notices, alerts, rotation, proposals, photos, documents, suppliers, negotiation, usage, deviceOps, access, wake,
    maintenance: new StockMaintenance({db, negotiation, now}),
    ...(syncDriver ? {syncDriver} : {}),
    reads: new StockReads(db, clock),
    enabledBusinesses: async userId => {
      if (!settings.userIds.has(userId)) return [];
      const {rows} = await db.query<{business_id: string}>(
        'SELECT business_id FROM assistant.stock_enabled_businesses WHERE user_id = $1 ORDER BY business_id', [userId]);
      return rows.map(row => row.business_id);
    },
  };
}
