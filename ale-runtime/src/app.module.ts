import {FirstLoopController,FirstLoopLanguageController} from './first-loop/controller';
import {FirstLoopService} from './first-loop/service';
import {Module, type DynamicModule, type OnApplicationShutdown} from '@nestjs/common';
import {ACTIVATION_SERVICE, type ActivationService} from './activation/activation.service';
import {AI_CONFIG_SERVICE, type AiConfigService} from './ai/ai-config.service';
import {MANAGED_META_MODE, type ManagedMetaScope} from './ai/meta-model';
import {MetaInferenceRelay} from './ai/meta-relay';
import {MetaRelayController} from './http/meta-relay.controller';
import type {BrainHubService} from './brain-hub/service';
import {ApprovalsController, InternalApprovalsController} from './approvals/approvals.controller';
import {APPROVALS_SERVICE, type ApprovalsService} from './approvals/approvals.service';
import {AGENT_BUDGET_SERVICE, type AgentBudgetService} from './approvals/agent-budget.service';
import {AgentBudgetController, InternalAgentBudgetController} from './http/agent-budget.controller';
import {TIMEZONE_SERVICE, type TimezoneService} from './assistant-config/timezone.service';
import {CHAT_SERVICE, type ChatService} from './chat/chat.service';
import {DEVICES_SERVICE, type DevicesService} from './devices/devices.service';
import {AssistantDevicesController, DeviceAuthGuard, DevicesController, STOCK_DEVICE_OPS} from './http/devices.controller';
import {serviceUnavailable} from './domain/errors';
import type {AssistantFlag} from './domain/ports';
import {ActivationController} from './http/activation.controller';
import {AiController} from './http/ai.controller';
import {AssistantController} from './http/assistant.controller';
import {CHAT_HEARTBEAT, ChatController} from './http/chat.controller';
import {ASSISTANT_FLAG, AssistantFlagGuard} from './http/assistant-flag.guard';
import {AuthGuard} from './http/auth.guard';
import {BrainHubAdminController, BRAIN_HUB_SERVICE, InternalBrainHubController, LearningSharingController} from './http/brain-hub.controller';
import {HealthController} from './http/health.controller';
import {InternalCatalogController, SkillsController} from './http/skills.controller';
import {BRAIN_FEEDBACK_SERVICE, BRAIN_SNAPSHOTS_SERVICE, BrainFeedbackController, BrainSnapshotsController} from './http/brain-snapshots.controller';
import type {BrainFeedbackService} from './orqa/brain-feedback';
import {BUSINESS_PROFILE_SERVICE, type BusinessProfileService} from './business-profile/business-profile.service';
import {BusinessProfileController} from './http/business-profile.controller';
import type {BrainSnapshotService} from './orqa/brain-snapshots';
import {INTERNAL_API_TOKEN, InternalTokenGuard} from './http/internal-token.guard';
import {TimezoneController} from './http/timezone.controller';
import {LifecycleController} from './lifecycle/lifecycle.controller';
import {LIFECYCLE_SERVICE, type LifecycleService} from './lifecycle/lifecycle.service';
import {Database} from './persistence/database';
import {FieldCipher} from './security/field-cipher';
import {IdentityVerifier} from './security/identity';
import {ASSISTANT_STATE_READER, SkeletonAssistantStateReader, type AssistantStateReader} from './state/assistant-state';
import {STOCK_RUNTIME, StockInternalController, StockWebController} from './stock/stock.controller';
import type {StockRuntime} from './stock/module';

/** Dependencias concretas; main.ts las construye y los tests las sustituyen. */
export interface AppDependencies {
  firstLoop?: FirstLoopService;
  database: Database;
  identity: IdentityVerifier;
  flag: AssistantFlag;
  cipher: FieldCipher;
  stateReader?: AssistantStateReader;
  /** Activación y callback OAuth (OCB-007). Sin ella, esas rutas responden 503. */
  activation?: ActivationService;
  /** Configurar la IA (OCB-010). Sin ella, PUT /assistants/me/ai responde 503. */
  ai?: AiConfigService;
  /** Meta Assistant is configured privately, without a browser provider/key form. */
  managedMeta?: ManagedMetaScope;
  metaRelay?: MetaInferenceRelay;
  /** Zona horaria (OCB-016). Sin ella, PUT /assistants/me/timezone responde 503. */
  timezone?: TimezoneService;
  /** Desactivar, reactivar y borrar (OCB-012). Sin él, esas rutas responden 503. */
  lifecycle?: LifecycleService;
  /** Proxy del chat (OCB-011). Sin él, las rutas de sesiones y stream responden 503. */
  chat?: ChatService;
  /**
   * Canal robot (emparejamiento + turnos del robot). Solo con `ROBOT_CHANNEL_ENABLED=true`: sin él, las
   * rutas `/devices/*` y `/assistants/me/devices` no existen (404).
   */
  devices?: DevicesService;
  /** Stock (inventario-vivo-v1). Solo con `STOCK_ENABLED=true`: sin él, las rutas de Stock no existen (404). */
  stock?: StockRuntime;
  /** Cada cuánto el stream manda un comentario keepalive (por defecto 15 s). */
  chatHeartbeatMs?: number;
  /** Aprobaciones de instalación (ORQA OSB-013). Sin ellas, esas rutas responden 503. */
  approvals?: ApprovalsService;
  /** Buzón del Cerebro SaleADS (OSB-015). Sin él, esas rutas responden 503. */
  brainHub?: BrainHubService;
  /** Fotos del cerebro (OSB-010). Sin ellas, esas rutas responden 503. */
  brainSnapshots?: BrainSnapshotService;
  /** Feedback del dueño sobre una memoria (MLB-014). Sin él, esa ruta responde 503. */
  brainFeedback?: BrainFeedbackService;
  /** Tipo de negocio (MLB-002). Sin él, esas rutas responden 503. */
  businessProfiles?: BusinessProfileService;
  /** Presupuesto mensual del agente (AAB-012). Sin él, esas rutas responden 503. */
  agentBudgets?: AgentBudgetService;
  /** Token de las rutas /internal que llama el MCP (OSB-013). Vacío = 503. */
  internalApiToken?: string;
  /** Se llama al apagar (cierra PostHog, pool de Postgres…). */
  shutdown?: () => Promise<void>;
}

const UNAVAILABLE_ACTIVATION = {
  activate: async () => {throw serviceUnavailable();},
  callback: async () => {throw serviceUnavailable();},
} as unknown as ActivationService;

const UNAVAILABLE_AI = {configure: async () => {throw serviceUnavailable();}} as unknown as AiConfigService;
const UNAVAILABLE_APPROVALS = {
  propose: async () => {throw serviceUnavailable();},
  requestCode: async () => {throw serviceUnavailable();},
  get: async () => {throw serviceUnavailable();},
  approve: async () => {throw serviceUnavailable();},
  reject: async () => {throw serviceUnavailable();},
  verification: async () => {throw serviceUnavailable();},
} as unknown as ApprovalsService;
const unavailable = async () => {throw serviceUnavailable();};
const UNAVAILABLE_BRAIN_HUB = {
  shareLesson: unavailable, ownerLessons: unavailable, sharing: unavailable, setSharing: unavailable, ackNotice: unavailable,
  adminLessons: unavailable, validate: unavailable, reject: unavailable, publish: unavailable, retire: unavailable, adminCatalog: unavailable,
  activeItem: unavailable, catalog: unavailable,
} as unknown as BrainHubService;
const UNAVAILABLE_BRAIN_SNAPSHOTS = {timeline: unavailable, version: unavailable, versionV2: unavailable, diff: unavailable} as unknown as BrainSnapshotService;
const UNAVAILABLE_BRAIN_FEEDBACK = {enqueue: unavailable} as unknown as BrainFeedbackService;
const UNAVAILABLE_BUSINESS_PROFILES = {get: unavailable, update: unavailable} as unknown as BusinessProfileService;
const UNAVAILABLE_AGENT_BUDGETS = {get: unavailable, put: unavailable, internalGet: unavailable, evaluate: unavailable} as unknown as AgentBudgetService;
const UNAVAILABLE_TIMEZONE = {update: async () => {throw serviceUnavailable();}} as unknown as TimezoneService;
const UNAVAILABLE_LIFECYCLE = {
  stop: async () => {throw serviceUnavailable();},
  start: async () => {throw serviceUnavailable();},
  remove: async () => {throw serviceUnavailable();},
} as unknown as LifecycleService;
const UNAVAILABLE_CHAT = {
  createSession: async () => {throw serviceUnavailable();},
  history: async () => {throw serviceUnavailable();},
  startTurn: async () => {throw serviceUnavailable();},
} as unknown as ChatService;

/**
 * Módulo raíz. Las carpetas de las tareas siguientes se conectan aquí:
 * `src/oauth` + `src/activation` + `src/compute` (OCB-007), `src/state` (OCB-008),
 * `src/oauth` renovación (OCB-009), `src/ai` (OCB-010), `src/chat` (OCB-011),
 * `src/lifecycle` (OCB-012) y `src/assistant-config` (OCB-016).
 */
@Module({})
export class AppModule {
  static register(deps: AppDependencies): DynamicModule {
    class ShutdownHook implements OnApplicationShutdown {
      async onApplicationShutdown(): Promise<void> {
        await deps.shutdown?.();
      }
    }
    return {
      module: AppModule,
      controllers: [...(deps.metaRelay ? [MetaRelayController] : []), ...(deps.firstLoop ? [FirstLoopController,FirstLoopLanguageController] : []), HealthController, AssistantController, ActivationController, AiController, TimezoneController, LifecycleController, ChatController, ApprovalsController, InternalApprovalsController,
        InternalBrainHubController, LearningSharingController, BrainHubAdminController, SkillsController, InternalCatalogController,
        BrainSnapshotsController, BrainFeedbackController, BusinessProfileController, AgentBudgetController, InternalAgentBudgetController,
        ...(deps.devices ? [DevicesController, AssistantDevicesController] : []),
        ...(deps.stock ? [StockInternalController, StockWebController] : [])],
      providers: [
        ...(deps.metaRelay ? [{provide: MetaInferenceRelay, useValue: deps.metaRelay}] : []),
        ...(deps.firstLoop ? [{provide: FirstLoopService, useValue: deps.firstLoop}] : []),
        ...(deps.devices ? [{provide: DEVICES_SERVICE, useValue: deps.devices}, DeviceAuthGuard] : []),
        ...(deps.stock ? [{provide: STOCK_RUNTIME, useValue: deps.stock}, {provide: STOCK_DEVICE_OPS, useValue: deps.stock.deviceOps}] : []),
        {provide: Database, useValue: deps.database},
        {provide: IdentityVerifier, useValue: deps.identity},
        {provide: ASSISTANT_FLAG, useValue: deps.flag},
        {provide: FieldCipher, useValue: deps.cipher},
        {provide: ACTIVATION_SERVICE, useValue: deps.activation ?? UNAVAILABLE_ACTIVATION},
        {provide: AI_CONFIG_SERVICE, useValue: deps.ai ?? UNAVAILABLE_AI},
        {provide: MANAGED_META_MODE, useValue: deps.managedMeta ?? {enabled: false, userId: ''}},
        {provide: TIMEZONE_SERVICE, useValue: deps.timezone ?? UNAVAILABLE_TIMEZONE},
        {provide: LIFECYCLE_SERVICE, useValue: deps.lifecycle ?? UNAVAILABLE_LIFECYCLE},
        {provide: CHAT_SERVICE, useValue: deps.chat ?? UNAVAILABLE_CHAT},
        {provide: APPROVALS_SERVICE, useValue: deps.approvals ?? UNAVAILABLE_APPROVALS},
        {provide: BRAIN_HUB_SERVICE, useValue: deps.brainHub ?? UNAVAILABLE_BRAIN_HUB},
        {provide: BRAIN_SNAPSHOTS_SERVICE, useValue: deps.brainSnapshots ?? UNAVAILABLE_BRAIN_SNAPSHOTS},
        {provide: BRAIN_FEEDBACK_SERVICE, useValue: deps.brainFeedback ?? UNAVAILABLE_BRAIN_FEEDBACK},
        {provide: BUSINESS_PROFILE_SERVICE, useValue: deps.businessProfiles ?? UNAVAILABLE_BUSINESS_PROFILES},
        {provide: AGENT_BUDGET_SERVICE, useValue: deps.agentBudgets ?? UNAVAILABLE_AGENT_BUDGETS},
        {provide: INTERNAL_API_TOKEN, useValue: deps.internalApiToken ?? ''},
        {provide: CHAT_HEARTBEAT, useValue: deps.chatHeartbeatMs ?? 15_000},
        {provide: ASSISTANT_STATE_READER, useValue: deps.stateReader ?? new SkeletonAssistantStateReader()},
        {provide: ShutdownHook, useClass: ShutdownHook},
        AuthGuard,
        AssistantFlagGuard,
        InternalTokenGuard,
      ],
    };
  }
}
