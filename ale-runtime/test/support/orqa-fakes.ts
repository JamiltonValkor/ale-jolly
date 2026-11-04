import {UserLocks} from '../../src/assistant-config/user-locks';
import {HermesConfigWriter} from '../../src/assistant-config/hermes-config-writer';
import {BRAIN_MCP_URL, loadAgentBundle, type AgentBundle} from '../../src/activation/hermes-files';
import type {BusinessTypeV1} from '../../src/contracts/v1';
import type {
  HermesJobInput, HermesJobsApi, HermesTarget, JobCreateOutcome, JobsListOutcome, JobTextPatch, JobUpdateOutcome,
} from '../../src/hermes/hermes-client';
import {OrqaSync, type OrqaSyncOptions} from '../../src/orqa/orqa-sync';
import type {AssistantEvent, AssistantRow} from '../../src/persistence/assistant-repository';
import {FieldCipher} from '../../src/security/field-cipher';
import {SkillsWriter} from '../../src/skills/skills-writer';
import {API_SERVER_KEY, FakeHermes, FakeInstances, HEALTHY, INSTANCE} from './hermes-fakes';

/** Arnés de OrqaSync (OSB-009, MCB-003, MCB-020): una VM lista con Compute y Hermes falsos. */
export const USER = '11111111-1111-4111-8111-111111111111';
export const BRAIN_IMAGE = 'us-central1-docker.pkg.dev/saleads-dev/saleads-brain/saleads-brain@sha256:c7dd3f0d05fb8b150bad55da5885e50152f83685ec0958044f9a923710d14157';
export const BUNDLE = loadAgentBundle('distribution/saleads-sales-agent/1.2.0', 'saleads-sales-agent@1.2.0');
export const mcp = {mcpUrl: 'https://dev.saleads.ai/mcp', clientId: 'mcp-saleads-assistant-dev', scope: 'openid saleads:read', brainMcpUrl: BRAIN_MCP_URL};

/** Trabajo vivo en el Hermes falso; `origin` como lo guarda el REST de Hermes (sin IPs aquí). */
export interface FakeJob {
  id: string; name: string; prompt: string; skills: string[]; schedule: string; enabled: boolean;
  origin: {platform: string | null; chatId: string | null};
}
export const REST_ORIGIN = {platform: 'api_server', chatId: 'api'};

/** Hermes con Cron API: guarda los trabajos creados (también los pausados) y aplica los PATCH como Hermes. */
export class FakeJobsHermes extends FakeHermes implements HermesJobsApi {
  jobs: FakeJob[] = [];
  readonly created: Array<{target: HermesTarget; job: HermesJobInput}> = [];
  readonly updates: Array<{id: string; patch: JobTextPatch}> = [];
  listCalls = 0;
  failCreate: JobCreateOutcome | null = null;
  /** Por nombre: lo que responde `updateJob` en vez de aplicar el cambio. */
  failUpdate: Record<string, JobUpdateOutcome> = {};
  private ids = 0;

  nextId(): string {return (++this.ids).toString(16).padStart(12, '0');}

  add(job: Partial<FakeJob> & {name: string}): FakeJob {
    const full: FakeJob = {id: this.nextId(), prompt: 'p', skills: [], schedule: '0 9 * * *', enabled: true, origin: {...REST_ORIGIN}, ...job};
    this.jobs.push(full);
    return full;
  }

  async listJobs(): Promise<JobsListOutcome> {
    this.listCalls++;
    return {
      kind: 'ok', names: this.jobs.map(job => job.name),
      jobs: this.jobs.map(job => ({id: job.id, name: job.name, prompt: job.prompt, skills: [...job.skills], enabled: job.enabled, origin: {...job.origin}})),
    };
  }

  async createJob(target: HermesTarget, job: HermesJobInput): Promise<JobCreateOutcome> {
    if (this.failCreate) return this.failCreate;
    this.created.push({target, job});
    this.add({name: job.name, prompt: job.prompt, skills: [...job.skills], schedule: job.schedule});
    return {kind: 'created'};
  }

  async updateJob(_target: HermesTarget, id: string, patch: JobTextPatch): Promise<JobUpdateOutcome> {
    this.updates.push({id, patch: JSON.parse(JSON.stringify(patch)) as JobTextPatch});
    const job = this.jobs.find(item => item.id === id);
    if (!job) return {kind: 'not_found'};
    const failure = this.failUpdate[job.name];
    if (failure) return failure;
    // Hermes aplica solo los campos de su lista blanca que vienen en el cuerpo.
    Object.assign(job, patch);
    return {kind: 'updated'};
  }
}

export function setup(options: Partial<OrqaSyncOptions> = {}, bundle: AgentBundle = BUNDLE, canSynchronize?: (userId: string) => boolean) {
  const types: BusinessTypeV1[] = [];
  const cipher = new FieldCipher(Buffer.alloc(32, 7));
  const row = {
    user_id: USER, status: 'ready', step: null, instance_name: INSTANCE, ai_provider: 'openrouter', ai_model: 'deepseek/deepseek-chat-v3.1',
    timezone: 'America/New_York', api_server_key_enc: cipher.seal('assistants.api_server_key_enc', USER, API_SERVER_KEY),
    created_at: new Date('2026-10-30T00:00:00Z'),
  } as unknown as AssistantRow;
  const events: AssistantEvent[] = [];
  const instances = new FakeInstances();
  const hermes = new FakeJobsHermes();
  hermes.healthDefault = HEALTHY;
  /** `orqa.synced` anteriores de esta VM (versiones del bundle), como los devuelve el repositorio. */
  const history: string[] = [];
  const repository = {
    findActive: async () => row, appendEvent: async (event: AssistantEvent) => {events.push(event);},
    syncedBundleVersions: async () => [...history],
  };
  /** Candados por usuario compartidos entre pods simulados (en el servicio son uno por proceso). */
  const locks = new UserLocks();
  const installed = [{item_id: 'skill.beauty.process', files: {'SKILL.md': '---\nname: beauty\n---\n'}}];
  const make = () => new OrqaSync({
    bundle, brainImage: BRAIN_IMAGE, ackTimeoutMs: 1_000, restartTimeoutMs: 1_000, healthTimeoutMs: 1_000,
    requestTimeoutMs: 1_000, pollIntervalMs: 1, retryAfterMs: 60_000, ...options,
  }, {
    repository, instances, hermes, cipher, config: new HermesConfigWriter(mcp, instances), canSynchronize,
    skills: new SkillsWriter(bundle.skills, repository, instances, async () => types), installedFiles: async () => installed, businessTypes: async () => types,
    locks, sleep: async () => undefined,
  });
  return {row, events, instances, hermes, make, cipher, types, history, locks, repository};
}
