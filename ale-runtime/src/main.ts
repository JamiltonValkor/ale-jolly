import {FirstLoopService} from './first-loop/service';
import {LanguagePreferences} from './locale/preferences';
import {TrustedContextPublisher} from './notifications/trusted-contexts';
import {NotificationRepository} from './notifications/repository';
import {NotificationProjection} from './notifications/projection';
import {ManagedBusinessJobs,ManagedJobIntentRepository,isLegacyGenericJobVersion,type ManagedJobSyncDependencies} from './notifications/jobs';
import {NativeManagedJobsClient} from './notifications/native-jobs';
import type {SnapshotStorage} from './orqa/brain-snapshots';
import {FirstLoopRepository} from './first-loop/repository';
import {HttpFirstLoopRuns} from './first-loop/native-client';
import {NativeTurnRecovery,nativeReceiptConsumer} from './first-loop/native-recovery';
import {metaRuntimeExtensions} from './activation/vm-extensions';
import {metadataTar} from './activation/metadata-archive';
import {BrainFeedbackService, BrainFeedbackStore} from './orqa/brain-feedback';
import {SaleadsServicesClient} from './approvals/saleads-services';
import {SpendActions, spendExecutors} from './approvals/spend';
import {AgentActivationActions, agentActivationExecutor} from './approvals/agent-activation';
import {AgentBudgetRepository} from './approvals/agent-budget';
import {AgentBudgetService} from './approvals/agent-budget.service';
import {InstallSkillExecutor, SkillsApprovalCatalog, UninstallSkillExecutor} from './skills/skills-catalog';
import {SkillsWriter} from './skills/skills-writer';
import {OrqaSync, readySyncCallback} from './orqa/orqa-sync';
import {OrqaSweep} from './orqa/orqa-sweep';
import {HttpMcpToolClient} from './orqa/mcp-client';
import {ownedBusinessIds, selectedBusinessId, SEED_CONTENT_TYPE, SeedScheduler, SeedService, SeedSweepStore} from './orqa/seed';
import {BrainSnapshotService, BrainSnapshotStore} from './orqa/brain-snapshots';
import {BrainSnapshotPoller} from './orqa/brain-snapshot-poller';
import {KnowledgeSyncService, KnowledgeSyncStore} from './orqa/knowledge-sync';
import {BrainHubRepository} from './brain-hub/repository';
import {BrainHubService} from './brain-hub/service';
import {ApprovalsRepository} from './approvals/approvals-repository';
import {ApprovalsService} from './approvals/approvals.service';
import 'reflect-metadata';
import {NestFactory} from '@nestjs/core';
import {resolve} from 'node:path';
import {ActivationService} from './activation/activation.service';
import {BRAIN_MCP_URL, loadAgentBundle, withCliConfig, type McpConfig} from './activation/hermes-files';
import {Provisioner} from './activation/provisioner';
import {AiConfigService} from './ai/ai-config.service';
import {ManagedMetaBootstrap, ManagedMetaStateReader} from './ai/managed-meta';
import {isManagedMetaUser, META_API_BASE_URL, META_MODEL_ID, META_PROVIDER_ID} from './ai/meta-model';
import {MetaInferenceRelay} from './ai/meta-relay';
import {HERMES_API_TIMEOUT_S} from './ai/ai-outcome';
import {AiRepository} from './ai/ai-repository';
import {AppModule} from './app.module';
import {HermesConfigWriter} from './assistant-config/hermes-config-writer';
import {TimezoneService} from './assistant-config/timezone.service';
import {UserLocks} from './assistant-config/user-locks';
import {ChatRepository} from './chat/chat-repository';
import {ChatService} from './chat/chat.service';
import {DevicesRepository} from './devices/devices-repository';
import {DevicesService} from './devices/devices.service';
import {RestComputeClient} from './compute/compute-client';
import {MetadataServerTokenSource} from './compute/gcp-token';
import {RestInstanceClient} from './compute/instance-client';
import {configuration} from './config';
import {createPostHogClient, PostHogAssistantFlag} from './flags/assistant-flag';
import {HttpHermesClient} from './hermes/hermes-client';
import {RestLifecycleCompute} from './lifecycle/lifecycle-compute';
import {LifecycleService} from './lifecycle/lifecycle.service';
import {LifecycleStore} from './lifecycle/lifecycle-store';
import {
  GcsArchiveStore, GcsMemoryArchiver, GcsObjectLister, GcsObjectReader, GcsObjectWriter, IamCredentialsSigner, latestArchiveObject,
  signedGetUrlV4, signedPutUrlV4,
} from './lifecycle/memory-archive';
import {BusinessProfileService, BusinessProfileStore} from './business-profile/business-profile.service';
import {configureApp} from './http/configure-app';
import {ReadinessRepository} from './lifecycle/readiness-repository';
import {ReadinessStateReader} from './lifecycle/readiness-state-reader';
import {OAuthFlowSecrets} from './oauth/authorize';
import {KeycloakRevocationClient} from './oauth/revoke-client';
import {KeycloakTokenClient} from './oauth/token-client';
import {outboundFetch, outboundHeaders} from './outbound/http-client';
import {AssistantRepository} from './persistence/assistant-repository';
import {Database} from './persistence/database';
import {FieldCipher} from './security/field-cipher';
import {IdentityVerifier} from './security/identity';
import {CredentialRenewal} from './renewal/credential-renewal';
import {CredentialStore} from './renewal/credential-store';
import {RestInstanceMetadata} from './renewal/instance-metadata';
import {RenewalScheduler} from './renewal/renewal-scheduler';
import {RenewalAwareStateReader} from './renewal/renewal-state-reader';
import {loadStockAddon} from './stock/addon';
import {managedMetaPrepare} from './stock/sync-driver';
import {stockJobsBundle, stockJobSync} from './stock/jobs';
import {STOCK_LIMITS} from './stock/config';
import {buildStock, stockSettings, type StockRuntime} from './stock/module';
import {gcsDocumentStore, metaInvoiceModel} from './stock/documents';
import {gcsPhotoStore} from './stock/photos';

async function main(): Promise<void> {
  const config = configuration(process.env);
  const managedMetaScope = {enabled: config.MANAGED_META_ENABLED, userId: config.MANAGED_META_USER_ID, allUsers: config.MANAGED_META_ALL_USERS};
  const outbound = {userAgent: config.OUTBOUND_USER_AGENT, timeoutMs: config.OUTBOUND_TIMEOUT_MS};
  const fetcher = outboundFetch(outbound);
  const database = Database.connect(config.DATABASE_URL, config.DATABASE_POOL_MAX);
  const posthog = createPostHogClient(config.POSTHOG_API_KEY, config.POSTHOG_HOST, fetcher);
  const jwksUrl = new URL(config.KEYCLOAK_JWKS_URL);
  const identity = IdentityVerifier.remote(
    {issuer: config.KEYCLOAK_ISSUER, audience: config.OIDC_AUDIENCE, clients: config.OIDC_ALLOWED_CLIENTS},
    jwksUrl, outboundHeaders(outbound),
  );
  // Token del asistente: mismo realm y JWKS; azp = su cliente y aud = el MCP.
  const assistantTokens = IdentityVerifier.remote(
    {issuer: config.KEYCLOAK_ISSUER, audience: config.MCP_URL, clients: [config.ASSISTANT_OAUTH_CLIENT_ID]},
    jwksUrl, outboundHeaders(outbound),
  );
  const masterKey = Buffer.from(config.FIELD_ENCRYPTION_KEY, 'base64');
  const cipher = new FieldCipher(masterKey);
  const repository = new AssistantRepository(database);
  const assistantFlag = new PostHogAssistantFlag(posthog, config.ASSISTANT_FLAG_KEY, config.ASSISTANT_FLAG_CACHE_TTL_MS);
  const metaRelay = config.MANAGED_META_ENABLED && config.MANAGED_META_RELAY_BASE_URL ? new MetaInferenceRelay({
    scope: managedMetaScope, apiKey: config.MANAGED_META_API_KEY, timeoutMs: HERMES_API_TIMEOUT_S * 1000,
  }, {repository, cipher, flag: assistantFlag,
    fetcher: outboundFetch({userAgent: config.OUTBOUND_USER_AGENT, timeoutMs: HERMES_API_TIMEOUT_S * 1000}),
  }) : undefined;
  const tokens = new KeycloakTokenClient(
    {tokenUrl: config.KEYCLOAK_TOKEN_URL, clientId: config.ASSISTANT_OAUTH_CLIENT_ID, redirectUri: config.ASSISTANT_OAUTH_REDIRECT_URI},
    fetcher,
  );
  const gcpTokens = new MetadataServerTokenSource(fetcher, config.GCP_METADATA_TOKEN_URL);
  const computeLocation = {project: config.GCP_PROJECT, zone: config.GCP_ZONE, template: config.ASSISTANT_INSTANCE_TEMPLATE, apiBase: config.COMPUTE_API_BASE};
  const compute = new RestComputeClient(computeLocation, gcpTokens, fetcher);
  // Un solo transporte de instancia (get/setMetadata/guest attributes) para la renovación, la readiness y la IA.
  const instanceMetadata = new RestInstanceMetadata({project: config.GCP_PROJECT, apiBase: config.COMPUTE_API_BASE}, gcpTokens, fetcher);
  const instances = new RestInstanceClient(instanceMetadata, config.GCP_ZONE);
  // Hermes: mismo User-Agent; el plazo de cada llamada lo pone el llamador (3 s salud, ≤45 s el turno de prueba).
  // El chat (OCB-011) usa su propio transporte: su plazo total es el tope de un turno, no el de 45 s.
  const hermes = new HttpHermesClient(
    outboundFetch({userAgent: config.OUTBOUND_USER_AGENT, timeoutMs: config.AI_PROBE_TIMEOUT_MS}),
    config.HERMES_API_PORT,
    outboundFetch({userAgent: config.OUTBOUND_USER_AGENT, timeoutMs: config.CHAT_TURN_MAX_MS}),
  );
  // ORQA cliente (OSB-009): con imagen del cerebro, hermes-config registra su MCP interno.
  const brainImage = config.BRAIN_IMAGE || null;
  const mcp: McpConfig = {
    mcpUrl: config.MCP_URL, clientId: config.ASSISTANT_OAUTH_CLIENT_ID, scope: config.ASSISTANT_OAUTH_SCOPE,
    brainMcpUrl: brainImage ? BRAIN_MCP_URL : null,
  };
  const bundle = withCliConfig(loadAgentBundle(resolve(config.ASSISTANT_BUNDLE_DIR), config.ASSISTANT_BUNDLE_VERSION), {
    url: config.AGENT_API_URL || config.MCP_URL, clientId: config.ASSISTANT_OAUTH_CLIENT_ID, webUrl: config.WEB_APP_URL,
  });
  // Stock: complemento por usuario sobre el bundle. Apagado no lee el disco; un paquete inválido detiene el arranque.
  const stockConfig = stockSettings(config);
  const stockAddon = loadStockAddon(stockConfig, resolve(config.STOCK_ADDON_DIR), bundle.version,
    {brainImage: config.STOCK_BRAIN_IMAGE, tar: metadataTar});
  if (stockAddon) mcp.saleadsExclude = userId => stockAddon.saleadsExclude(userId);
  // Firma de URLs V4 sin key local (signBlob de IAM): archivo de memorias (OCB-012), su restauración (D50) y semilla (OSB-007).
  const signer = new IamCredentialsSigner(config.ASSISTANT_SIGNER_EMAIL, config.IAM_CREDENTIALS_API_BASE, gcpTokens, fetcher);
  const objectLister = new GcsObjectLister(config.STORAGE_API_BASE, gcpTokens, fetcher);
  const restoreUrl = async (userId: string, now: Date) => {
    const object = latestArchiveObject(userId, await objectLister.list(config.ASSISTANT_MEMORIES_BUCKET, `${userId}/`));
    if (!object) return null;
    return (await signedGetUrlV4({
      bucket: config.ASSISTANT_MEMORIES_BUCKET, object, now, ttlSeconds: config.RESTORE_URL_TTL_SECONDS, signer,
    })).url;
  };
  const provisioner = new Provisioner({
    managedMetaExtensions: config.MANAGED_META_ENABLED ? metaRuntimeExtensions() : undefined,
    zone: config.GCP_ZONE,
    runtimeNamespace: config.ASSISTANT_RUNTIME_NAMESPACE,
    issuer: config.KEYCLOAK_ISSUER,
    mcp,
    bundle,
    brainImage,
    operationTimeoutMs: config.COMPUTE_OPERATION_TIMEOUT_MS,
    retryDelayMs: config.COMPUTE_RETRY_DELAY_MS,
  }, {repository, compute, tokens, cipher, restoreUrl});
  // Renovación de la credencial (OCB-009): barrido ~7 días, resiembra y recuperación por SSO silencioso.
  const credentialStore = new CredentialStore(database);
  const renewal = new CredentialRenewal({
    repository, store: credentialStore, cipher, tokens,
    revocation: new KeycloakRevocationClient({revokeUrl: config.KEYCLOAK_REVOKE_URL, clientId: config.ASSISTANT_OAUTH_CLIENT_ID}, fetcher),
    metadata: instanceMetadata,
    issuer: config.KEYCLOAK_ISSUER,
    zone: config.GCP_ZONE,
    retryDebounceMs: config.ASSISTANT_RENEWAL_RETRY_DEBOUNCE_MS,
  });
  const renewalScheduler = new RenewalScheduler(renewal, credentialStore, {
    sweepIntervalMs: config.ASSISTANT_RENEWAL_SWEEP_INTERVAL_MS,
    maxAgeMs: config.ASSISTANT_RENEWAL_MAX_AGE_MS,
    batchSize: config.ASSISTANT_RENEWAL_BATCH_SIZE,
  });
  const activation = new ActivationService({
    repository, cipher, tokens, assistantTokens, provisioner, recovery: renewal,
    secrets: new OAuthFlowSecrets(masterKey),
    authorize: {
      authorizeUrl: config.KEYCLOAK_AUTHORIZE_URL,
      clientId: config.ASSISTANT_OAUTH_CLIENT_ID,
      redirectUri: config.ASSISTANT_OAUTH_REDIRECT_URI,
      scope: config.ASSISTANT_OAUTH_SCOPE,
    },
    flowTtlMs: config.ASSISTANT_OAUTH_FLOW_TTL_MS,
  });
  // ORQA cliente: buzón aislado en el schema brain_hub (OSB-015) y catálogo con aprobación (OSB-016).
  const brainHub = new BrainHubService({repository: new BrainHubRepository(database.pool), admins: new Set(config.BRAIN_HUB_ADMIN_USER_IDS)});
  // Tipo de negocio (MLB-002): elige las skills de types/ en hermes-skills (MLB-003).
  const businessProfileStore = new BusinessProfileStore(database);
  const businessTypes = (userId: string) => businessProfileStore.typesOf(userId);
  const skillsWriter = new SkillsWriter(bundle.skills, repository, instances, businessTypes, bundle.skillsEncoding,
    stockAddon ? userId => stockAddon.enabledFor(userId) ? stockAddon.skills : undefined : undefined);
  // Un cambio de config de la VM por usuario a la vez: PUT /ai, PUT /timezone, el start y ORQA (OCB-016, OSB-009).
  const configLocks = new UserLocks();
  const configWriter = new HermesConfigWriter(mcp, instances,
    config.MANAGED_META_ENABLED ? {...managedMetaScope, provider: META_PROVIDER_ID, model: META_MODEL_ID,
      baseUrl: config.MANAGED_META_RELAY_BASE_URL || undefined} : undefined);
  const orqa = new OrqaSync({
    managedMeta: managedMetaScope,
    bundle, brainImage,
    ackTimeoutMs: config.AI_ACK_TIMEOUT_MS,
    restartTimeoutMs: config.AI_CONFIGURE_DEADLINE_MS,
    healthTimeoutMs: config.READINESS_HEALTH_TIMEOUT_MS,
    requestTimeoutMs: config.CHAT_REQUEST_TIMEOUT_MS,
    pollIntervalMs: config.AI_POLL_INTERVAL_MS,
    retryAfterMs: config.ORQA_SYNC_RETRY_AFTER_MS,
    updateJobs: config.ORQA_JOB_UPDATES_ENABLED,
    explicitReads: config.SPECIALIST_EXPLICIT_READS_ENABLED,
    researcherNativeSearch: config.RESEARCHER_NATIVE_SEARCH_ENABLED,
  }, {
    repository, instances, hermes, cipher, config: configWriter, skills: skillsWriter,
    canSynchronize: userId => !config.MANAGED_META_ENABLED || managedMeta.isReady(userId,
      {configured: true, provider: META_PROVIDER_ID, model: META_MODEL_ID}),
    installedFiles: userId => brainHub.installedFiles(userId), businessTypes, locks: configLocks,
    ...(stockAddon ? {addon: stockAddon} : {}),
  });
  // MCB-020: la misma sincronización, también para los dueños que no abren la web (D21, D25).
  const orqaSweep = new OrqaSweep({
    enabled: config.ORQA_SYNC_SWEEP_ENABLED,
    delayMs: config.ORQA_SYNC_SWEEP_DELAY_MS,
    intervalMs: config.ORQA_SYNC_SWEEP_INTERVAL_MS,
    pauseMs: config.ORQA_SYNC_SWEEP_PAUSE_MS,
    includeLab: config.ORQA_SYNC_SWEEP_INCLUDE_LAB,
  }, {orqa, repository});
  const seedWriter = new GcsObjectWriter(config.STORAGE_API_BASE, gcpTokens, fetcher);
  const objectReader = new GcsObjectReader(config.STORAGE_API_BASE, gcpTokens, fetcher);
  const ownerMcp = new HttpMcpToolClient(config.MCP_URL, outboundFetch({userAgent: config.OUTBOUND_USER_AGENT, timeoutMs: config.SEED_TOOL_TIMEOUT_MS}));
  const seed = new SeedService({
    ttlSeconds: config.SEED_URL_TTL_SECONDS, toolTimeoutMs: config.SEED_TOOL_TIMEOUT_MS, debounceMs: 30 * 60_000,
  }, {
    repository, instances,
    accessToken: userId => renewal.accessToken(userId),
    mcp: ownerMcp,
    storage: {
      upload: (object, body) => seedWriter.upload(config.ASSISTANT_MEMORIES_BUCKET, object, body, SEED_CONTENT_TYPE),
      signedGetUrl: async (object, now, ttlSeconds) =>
        (await signedGetUrlV4({bucket: config.ASSISTANT_MEMORIES_BUCKET, object, now, ttlSeconds, signer})).url,
    },
  });
  // AAB-013: lo nuevo del cerebro llega a BI (knowledge-sync), por negocio, con cursor e idempotencia.
  const knowledgeSync = new KnowledgeSyncService({
    enabled: config.KNOWLEDGE_SYNC_ENABLED, biUrl: config.BI_SERVICE_URL, internalToken: config.SALEADS_SERVICES_INTERNAL_TOKEN,
  }, {
    // La fuente se conecta abajo: el servicio de fotos se crea después.
    source: {latestVersions: userId => brainSnapshots.latestVersions(userId), syncSource: (u, b, v) => brainSnapshots.syncSource(u, b, v)},
    cursors: new KnowledgeSyncStore(database),
    fetcher: outboundFetch({userAgent: config.OUTBOUND_USER_AGENT, timeoutMs: config.KNOWLEDGE_SYNC_TIMEOUT_MS}),
    repository,
  });
  // Fotos del cerebro (OSB-010): PUT firmado de 7 días rotado a los 6; versiones por negocio en el mismo bucket.
  const brainSnapshots = new BrainSnapshotService({uploadTtlSeconds: 7 * 86_400, rotateAfterMs: 6 * 86_400_000, debounceMs: 15 * 60_000}, {
    repository, instances,
    store: new BrainSnapshotStore(database),
    storage: {
      signedPutUrl: async (object, now, ttlSeconds) =>
        (await signedPutUrlV4({bucket: config.ASSISTANT_MEMORIES_BUCKET, object, now, ttlSeconds, signer})).url,
      download: (object, maxBytes) => objectReader.download(config.ASSISTANT_MEMORIES_BUCKET, object, maxBytes),
      upload: (object, body, contentType) => seedWriter.upload(config.ASSISTANT_MEMORIES_BUCKET, object, body, contentType),
    },
    ownedBusinesses: async userId => {
      const token = await renewal.accessToken(userId);
      if (!token) return null;
      const ids = await ownedBusinessIds(ownerMcp, token, config.SEED_TOOL_TIMEOUT_MS);
      return Array.isArray(ids) ? new Set(ids) : null;
    },
    onStored: (userId, businessIds) => knowledgeSync.onStored(userId, businessIds),
  });
  const trustedContexts = new TrustedContextPublisher(instances);
  const runtimeStorage:SnapshotStorage = {
    signedPutUrl: async (object, now, ttlSeconds) => (await signedPutUrlV4({bucket: config.ASSISTANT_MEMORIES_BUCKET, object, now, ttlSeconds, signer})).url,
    download: (object, maxBytes) => objectReader.download(config.ASSISTANT_MEMORIES_BUCKET, object, maxBytes),
    upload: (object, body, contentType) => seedWriter.upload(config.ASSISTANT_MEMORIES_BUCKET, object, body, contentType),
  };
  const notifications=new NotificationRepository(database,cipher);
  const firstLoopRepository=new FirstLoopRepository(database,cipher);
  const nativeTurnRecovery=new NativeTurnRecovery(firstLoopRepository);
  const notificationProjection=new NotificationProjection(notifications,runtimeStorage,instances,undefined,nativeReceiptConsumer(firstLoopRepository,nativeTurnRecovery,cipher));
  const nativeJobs=new NativeManagedJobsClient(fetcher,config.HERMES_API_PORT);
  const managedJobDeps:ManagedJobSyncDependencies={
    native:nativeJobs,intents:new ManagedJobIntentRepository(database),bindings:notifications,
    isManagedOwner:owner=>isManagedMetaUser(managedMetaScope,owner),
    publishBindings:async bindings=>{
      if(!bindings.length)return;const owner=bindings[0]!.owner_id;
      if(bindings.some(binding=>binding.owner_id!==owner))throw new Error('mixed_job_owners');
      const row=await repository.findActive(owner);if(!row)throw new Error('assistant_unavailable');
      await trustedContexts.bindJobs(row,bindings);
    },
    previouslyCreatedLegacy:async(owner,name)=>{
      const row=await repository.findActive(owner);if(!row)return false;
      const versions=await repository.syncedBundleVersions(owner,row.created_at);
      return versions.some(version=>isLegacyGenericJobVersion(version)&&bundle.jobNamesByVersion[version]?.includes(name));
    },
  };
  const managedJobs=new ManagedBusinessJobs(bundle,managedJobDeps);
  // S-19: el ciclo de Stock es un trabajo propio, solo para el usuario y negocio habilitados. `ManagedBusinessJobs` es de un
  // bundle, así que Stock lleva su propia instancia con un bundle que solo trae ese trabajo; la de 1.5.13 no cambia.
  const stockBundle=stockAddon?stockJobsBundle(stockAddon,bundle):null;
  const syncStockJobs=stockAddon&&stockBundle&&stockJobSync(stockAddon,new ManagedBusinessJobs(stockBundle,managedJobDeps),
    async owner=>stock?await stock.enabledBusinesses(owner):[],{bundle:stockBundle,native:nativeJobs,intents:managedJobDeps.intents as ManagedJobIntentRepository});
  const languages = new LanguagePreferences(database);
  const firstLoop = new FirstLoopService({...managedMetaScope, enabled: config.FIRST_LOOP_ENABLED && config.MANAGED_META_ENABLED,continuousLearning:!!bundle.profiles.curador}, {
    repository: firstLoopRepository, languages, assistants: repository, cipher, hermes,
    publishContext: (row, context) => trustedContexts.publish(row, context),
    languageChanged: async (row, preference) => {
      await trustedContexts.synchronizeLanguage(row,preference);
      await notifications.updateLocale(row.user_id,preference.response_locale,preference.locale_revision);
    },
    notifications: (row, business, session) => notificationProjection.messages(row,business,session),
    refreshNativeReceipts:row=>notificationProjection.refreshNativeReceipts(row),
    firstUseReady:async(row,business)=>{
      if (!await businessProfileStore.find(row.user_id,business)) return false;
      return orqa.readyForFirstUse(row);
    },
    synchronizeJobs:async(row,context,target)=>{
      const view=row.instance_name?await instances.getInstance(row.instance_name):null;
      if(!view?.generation)throw new Error('instance_generation_unavailable');
      const report=await managedJobs.synchronize({context,target,instance_generation:row.instance_name+':'+view.generation});
      if(report.pending.length)await repository.appendEvent({userId:row.user_id,kind:'orqa.jobs_pending',phase:'orqa',detail:'pending='+report.pending.length});
      const stockReport=await syncStockJobs?.({context,target,instance_generation:row.instance_name+':'+view.generation});
      if(stockReport?.pending.length)await repository.appendEvent({userId:row.user_id,kind:'stock.jobs_pending',phase:'orqa',detail:'pending='+stockReport.pending.length+' reasons='+stockReport.pending.map(item=>item.reason).join(',')});
      if(stockReport?.text_updated.length)await repository.appendEvent({userId:row.user_id,kind:'stock.job_text_updated',phase:'orqa',detail:'jobs='+stockReport.text_updated.join(',')});
    },
    runs: new HttpFirstLoopRuns(fetcher, config.HERMES_API_PORT), instances,
    storage: runtimeStorage,
    ownedBusinesses: async userId => {
      const token = await renewal.accessToken(userId); if (!token) return null;
      const ids = await ownedBusinessIds(ownerMcp, token, config.SEED_TOOL_TIMEOUT_MS); return Array.isArray(ids) ? new Set(ids) : null;
    },
    selectedBusiness: async userId => {
      const token = await renewal.accessToken(userId);
      return token ? selectedBusinessId(ownerMcp, token, config.SEED_TOOL_TIMEOUT_MS) : null;
    },
    bootstrap: async (userId, businessId) => {
      const token = await renewal.accessToken(userId); if (!token) return null;
      const result = await ownerMcp.call(token, 'saleads_get_business_bootstrap', {business_id: businessId}, config.SEED_TOOL_TIMEOUT_MS);
      return result.ok ? result.data : null;
    },
  });
  // Tipo de negocio del equipo (MLB-002): precarga de BI por el MCP con el token del dueño.
  const businessProfiles = new BusinessProfileService({toolTimeoutMs: config.SEED_TOOL_TIMEOUT_MS}, {
    store: businessProfileStore, mcp: ownerMcp, repository,
    accessToken: userId => renewal.accessToken(userId),
    // Cambiar el tipo cambia las skills: se resincroniza ya, sin reiniciar el pod (MLB-003).
    onTypeChanged: userId => {void orqa.resync(userId).catch(() => undefined);},
  });
  // Feedback del dueño sobre una memoria (MLB-014, D49): sesión aparte de Hermes, nunca su chat.
  const brainFeedback = new BrainFeedbackService({
    store: new BrainFeedbackStore(database), snapshots: brainSnapshots, repository, instances, hermes, cipher,
    ownedBusinesses: async userId => {
      const token = await renewal.accessToken(userId);
      if (!token) return null;
      const ids = await ownedBusinessIds(ownerMcp, token, config.SEED_TOOL_TIMEOUT_MS);
      return Array.isArray(ids) ? new Set(ids) : null;
    },
    timeoutMs: config.CHAT_REQUEST_TIMEOUT_MS,
  });
  // AAB-013 (D27): la foto nueva se ingiere en minutos, sin esperar la readiness ni el barrido diario.
  const snapshotPoller = new BrainSnapshotPoller({
    users: new SeedSweepStore(database),
    sync: userId => brainSnapshots.sync(userId),
    pushPending: userId => knowledgeSync.syncUser(userId),
  }, {intervalMs: config.BRAIN_SNAPSHOT_POLL_INTERVAL_MS, batchSize: 500});
  const seedScheduler = new SeedScheduler(seed, new SeedSweepStore(database), {intervalMs: config.SEED_SWEEP_INTERVAL_MS, batchSize: 500},
    [userId => brainSnapshots.sync(userId)]);
  const onReady = readySyncCallback(orqa, userId => Promise.all([
    seed.onReady(userId), brainSnapshots.onReady(userId), brainFeedback.deliver(userId).catch(() => 0),
  ]), config.MANAGED_META_ENABLED);
  const stateReader = new ReadinessStateReader({
    healthTimeoutMs: config.READINESS_HEALTH_TIMEOUT_MS,
    budgetMs: config.READINESS_BUDGET_MS,
    cacheTtlMs: config.READINESS_CACHE_TTL_MS,
    graceMs: config.READINESS_TRANSITION_GRACE_MS,
  }, {
    repository, readiness: new ReadinessRepository(database), instances, hermes, cipher,
    // ORQA: config → ack → /health → jobs; después la semilla del cerebro (OSB-007/009).
    onReady,
  });
  const timezone = new TimezoneService({
    repository, writer: configWriter, locks: configLocks,
    onStateChanged: userId => stateReader.invalidate(userId),
  });
  const ai = new AiConfigService({
    mcp,
    managedMeta: managedMetaScope, managedMetaBaseUrl: config.MANAGED_META_RELAY_BASE_URL || undefined,
    deadlineMs: config.AI_CONFIGURE_DEADLINE_MS,
    ackTimeoutMs: config.AI_ACK_TIMEOUT_MS,
    probeTimeoutMs: config.AI_PROBE_TIMEOUT_MS,
    pollIntervalMs: config.AI_POLL_INTERVAL_MS,
    healthTimeoutMs: config.READINESS_HEALTH_TIMEOUT_MS,
  }, {
    repository, ai: new AiRepository(database), instances, hermes, cipher, locks: configLocks,
    onStateChanged: userId => stateReader.invalidate(userId),
  });
  const managedMeta = new ManagedMetaBootstrap({
    ...managedMetaScope, apiKey: config.MANAGED_META_API_KEY,
  }, {read: userId => repository.findActive(userId), configure: (userId, input) => ai.configure(userId, input),
    credentialForUser: metaRelay ? userId => metaRelay.credentialForUser(userId) : undefined,
    reconcile: (userId, apiKey) => ai.reconcileManagedMeta(userId, apiKey),
  });
  const lifecycle = new LifecycleService({
    bucket: config.ASSISTANT_MEMORIES_BUCKET,
    archiveUrlTtlSeconds: config.ARCHIVE_URL_TTL_SECONDS,
    archiveTimeoutMs: config.ARCHIVE_TIMEOUT_MS,
    deleteTimeoutMs: config.VM_DELETE_TIMEOUT_MS,
    operationTimeoutMs: config.COMPUTE_OPERATION_TIMEOUT_MS,
    pollIntervalMs: config.LIFECYCLE_POLL_INTERVAL_MS,
  }, {
    repository, cipher,
    store: new LifecycleStore(database),
    compute: new RestLifecycleCompute(computeLocation, gcpTokens, fetcher),
    archiver: new GcsMemoryArchiver(signer, new GcsArchiveStore(config.STORAGE_API_BASE, gcpTokens, fetcher)),
    // Revoke RFC 7009 y renovación antes del start: los de OCB-009.
    credentials: renewal,
    // Zona cambiada con la VM apagada: se aplica antes del start (OCB-016).
    config: timezone,
  });
  // Stock se construye después del chat; el contexto de turno lo lee por este enlace tardío.
  const stockLink: {runtime?: StockRuntime} = {};
  // Proxy del chat (OCB-011): los fallos de tools mcp__saleads__* disparan la resiembra de OCB-009.
  const chat = new ChatService({
    requestTimeoutMs: config.CHAT_REQUEST_TIMEOUT_MS,
    upstreamIdleMs: config.CHAT_UPSTREAM_IDLE_MS,
  }, {
    repository, sessions: new ChatRepository(database), hermes, cipher, mcpFailures: renewal,
    // VM RUNNING + Hermes sin responder = reinicio del gateway (OCB-016).
    instances,
    inferenceReady: config.MANAGED_META_ENABLED ? row => managedMeta.isReady(row.user_id,
      {configured: row.ai_configured, provider: row.ai_provider, model: row.ai_model}) : undefined,
    prepareInference: config.MANAGED_META_ENABLED ? userId => managedMeta.request(userId) : undefined,
    onStateChanged: userId => stateReader.invalidate(userId),
    deviceContext: userId => firstLoop.deviceContext(userId),
    stockTurnContext: async userId => stockLink.runtime ? stockLink.runtime.notices.voiceContext(userId) : null,
    stockTurnUsage: async (userId, inputTokens) => {
      const runtime = stockLink.runtime;
      const businessId = (await runtime?.enabledBusinesses(userId))?.[0];
      if (runtime && businessId) await runtime.usage.record(runtime.db, businessId, 'tokens_ale', inputTokens);
    },
  });
  // Canal robot: apagado por defecto (ROBOT_CHANNEL_ENABLED); el robot es del usuario, no de un negocio.
  const devices = config.ROBOT_CHANNEL_ENABLED ? new DevicesService({
    pairingTtlMs: config.ROBOT_PAIRING_TTL_MS, maxPending: config.ROBOT_MAX_PENDING_PAIRINGS,
    claimUrl: config.ROBOT_CLAIM_URL || undefined, claimAttempts: 10, claimWindowMs: 10 * 60_000,
  }, new DevicesRepository(database)) : undefined;
  // MLB-013: gastar, pausar o reanudar lo aprueba el dueño en la web con su código; ejecuta este servicio.
  const services = new SaleadsServicesClient({
    strategyUrl: config.STRATEGY_SERVICE_URL, campaignUrl: config.CAMPAIGN_SERVICE_URL, subscriptionUrl: config.SUBSCRIPTION_SERVICE_URL,
    integrationUrl: config.INTEGRATION_SERVICE_URL, internalToken: config.SALEADS_SERVICES_INTERNAL_TOKEN, timeoutMs: config.SPEND_EXECUTOR_TIMEOUT_MS,
  }, outboundFetch({userAgent: config.OUTBOUND_USER_AGENT, timeoutMs: config.SPEND_EXECUTOR_TIMEOUT_MS}));
  const spend = new SpendActions(services);
  // AAB-012: encender lo que el agente publicó en pausa (un botón, sin código) y su presupuesto mensual aprobado.
  const agentBudgetRepository = new AgentBudgetRepository(database);
  const agent = new AgentActivationActions(services, agentBudgetRepository, {enabled: config.AGENT_ACTIVATION_APPROVALS_ENABLED, traceWriter: config.AGENT_TRACE_WRITER_ENABLED, liveProjection: true});
  const agentBudgets = new AgentBudgetService(agentBudgetRepository, (userId, businessId) => businessProfiles.assertOwned(userId, businessId));
  const approvals = new ApprovalsService({
    repository: new ApprovalsRepository(database),
    catalog: new SkillsApprovalCatalog(brainHub),
    spend,
    agent,
    executors: [new InstallSkillExecutor(brainHub, skillsWriter), new UninstallSkillExecutor(brainHub, skillsWriter), ...spendExecutors(spend),
      agentActivationExecutor(agent)],
  });
  // Stock (inventario-vivo-v1): apagado por defecto; sin bandera no hay consultas ni rutas. Es la única conexión.
  const stock = await buildStock(stockConfig, {pool: database.pool,
    locale: async userId => (await languages.get(userId))?.response_locale ?? null,
    ownerMcp: {mcp: ownerMcp, accessToken: userId => renewal.accessToken(userId), timeoutMs: config.SEED_TOOL_TIMEOUT_MS},
    assertOwned: (userId, businessId) => businessProfiles.assertOwned(userId, businessId),
    ...(config.STOCK_BUCKET ? {photoStore: gcsPhotoStore(config.STOCK_BUCKET, signer),
      documentStore: gcsDocumentStore(config.STOCK_BUCKET, signer, new GcsArchiveStore(config.STORAGE_API_BASE, gcpTokens, fetcher), objectReader)} : {}),
    ...(config.STOCK_EXTRACT_MODEL && config.MANAGED_META_API_KEY ? {invoiceModel: metaInvoiceModel({apiKey: config.MANAGED_META_API_KEY, model: config.STOCK_EXTRACT_MODEL, baseUrl: META_API_BASE_URL,
      fetcher: outboundFetch({userAgent: config.OUTBOUND_USER_AGENT, timeoutMs: STOCK_LIMITS.extractTimeoutMs})})} : {}),
    ...(config.STOCK_SUPPLIER_CHANNEL === 'telegram' ? {supplierTelegram: {token: config.STOCK_SUPPLIER_TELEGRAM_TOKEN,
      fetcher: outboundFetch({userAgent: config.OUTBOUND_USER_AGENT, timeoutMs: config.OUTBOUND_TIMEOUT_MS})}} : {}),
    toolWaitMs: config.STOCK_TOOL_WAIT_MS, heartbeatMs: config.CHAT_HEARTBEAT_MS,
    vm: {jobs: nativeJobs, repository, instances, cipher},
    // Con MANAGED_META_ENABLED=false, `afterSync` corre en cada llamada: el driver no arranca.
    ...(config.MANAGED_META_ENABLED ? {sync: {intervalMs: config.STOCK_SYNC_INTERVAL_MS, repository, onReady, prepare: managedMetaPrepare(managedMeta)}} : {})});
  stockLink.runtime = stock;
  const app = await NestFactory.create(AppModule.register({
    database,
    identity,
    flag: assistantFlag,
    cipher,
    // La readiness (OCB-008) queda envuelta por la renovación (OCB-009).
    stateReader: new ManagedMetaStateReader(new RenewalAwareStateReader(stateReader, renewal), managedMeta,
      userId => stateReader.notifyReady(userId)),
    activation,
    ai,
    managedMeta: managedMetaScope,
    metaRelay,
    timezone,
    lifecycle,
    chat,
    devices,
    stock,
    chatHeartbeatMs: config.CHAT_HEARTBEAT_MS,
    // ORQA cliente: aprobaciones de instalación (OSB-013) sobre el catálogo del buzón (OSB-015/016).
    approvals,
    agentBudgets,
    firstLoop,
    internalApiToken: config.INTERNAL_API_TOKEN,
    brainHub,
    brainSnapshots,
    brainFeedback,
    businessProfiles,
    shutdown: async () => {
      try {
        await renewalScheduler.stop();
        await seedScheduler.stop();
        await snapshotPoller.stop();
        await orqaSweep.stop();
        await stock?.syncDriver?.stop();
        await stock?.negotiation.stop();
        await stock?.maintenance.stop();
        await firstLoop.idle();
        await managedMeta.idle();
        await Promise.all([provisioner.idle(), renewal.idle()]);
        await posthog.shutdown();
      } finally {await database.close();}
    },
  }), {bodyParser: false, logger: ['log', 'warn', 'error']});
  configureApp(app);
  await app.listen(config.PORT, '0.0.0.0');
  if (config.ASSISTANT_RENEWAL_ENABLED) renewalScheduler.start();
  if (orqa.enabled) seedScheduler.start();
  if (orqa.enabled && config.BRAIN_SNAPSHOT_POLL_ENABLED) snapshotPoller.start();
  orqaSweep.start();
  stock?.syncDriver?.start();
  stock?.negotiation.start();
  stock?.maintenance.start();
  // Un borrado cortado por un reinicio del pod sigue solo (el front sondea GET /me).
  void lifecycle.resumePendingDeletions().catch(() => process.stderr.write('ASSISTANT_DELETION_RESUME_FAILED\n'));
}

void main().catch(error => {
  // Solo el código: el mensaje de configuración nunca lleva valores.
  const code = error instanceof Error && /^(CONFIGURATION_INVALID|BUNDLE_)/.test(error.message) ? error.message : 'ASSISTANT_STARTUP_FAILED';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
