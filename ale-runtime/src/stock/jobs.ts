import type {AgentBundle} from '../activation/hermes-files';
import type {HermesTarget, JobTextPatch, JobUpdateOutcome} from '../hermes/hermes-client';
import {managedJobTextHash as jobTextHash, scopedJobPrompt, type ManagedBusinessJobs, type ManagedJobIntentRepository, type ManagedJobSyncReport} from '../notifications/jobs';
import type {ManagedJobsApi} from '../notifications/native-jobs';
import type {StockAddon} from './addon';

type Sync = Parameters<ManagedBusinessJobs['synchronize']>[0];

/**
 * `ManagedBusinessJobs` recibe un solo bundle y recorre todos sus trabajos. Una segunda instancia con este bundle crea
 * solo los de Stock, sin tocar la de 1.5.13 ni sus hashes. Sin catálogo previo: `saleads:stock-tick` nunca fue genérico.
 */
export function stockJobsBundle(addon: Pick<StockAddon, 'jobs'>, bundle: AgentBundle): AgentBundle {
  return {...bundle, jobs: [...addon.jobs], knownJobHashes: {}, jobNamesByVersion: {}};
}

export interface StockJobTextDeps {
  /** El bundle de `stockJobsBundle`: sus trabajos traen el texto de la versión vigente del complemento. */
  bundle: Pick<AgentBundle, 'jobs'>;
  native: Pick<ManagedJobsApi, 'list'> & {updateText(target: HermesTarget, id: string, patch: JobTextPatch, timeoutMs: number): Promise<JobUpdateOutcome>};
  intents: Pick<ManagedJobIntentRepository, 'find' | 'retext'>;
  timeoutMs?: number;
}
export type StockJobSyncReport = ManagedJobSyncReport & {text_updated: string[]};

/**
 * IVB-023: `ManagedBusinessJobs` crea el trabajo con alcance y nunca cambia su texto, y `OrqaSync.updateJob` solo cubre
 * los genéricos. Con el complemento 1.0.1 en dev, `saleads:stock-tick` siguió con el prompt de 1.0.0. Aquí, tras la
 * sincronización normal, el texto se actualiza solo si el trabajo vivo conserva exactamente el texto que el servicio instaló
 * (`desired_hash` del intent activo): una edición del dueño queda intacta. Mismo nombre, horario y pausa.
 */
async function upgradeText(text: StockJobTextDeps, input: Sync, report: StockJobSyncReport): Promise<void> {
  const {context, target, instance_generation} = input;
  const timeout = text.timeoutMs ?? 10_000;
  for (const job of text.bundle.jobs) {
    const key = {owner_id: context.owner_id, business_id: context.business_id, instance_generation, base_name: job.name};
    const intent = await text.intents.find(key);
    // Sin intent activo o con otra sesión canónica, manda `ManagedBusinessJobs` y su reporte.
    if (!intent || intent.phase !== 'active' || !intent.native_job_id || intent.session_id !== context.session_id) continue;
    const prompt = scopedJobPrompt(job, context);
    const desired = jobTextHash(prompt, job.skills);
    if (desired === intent.desired_hash) continue;
    const listed = await text.native.list(target, timeout);
    if (listed.kind !== 'ok') {report.pending.push({name: intent.job_name, reason: 'text_update_inventory_unavailable'}); continue;}
    const live = listed.jobs.find(item => item.id === intent.native_job_id);
    if (!live || live.name !== intent.job_name || jobTextHash(live.prompt, live.skills) !== intent.desired_hash) {
      report.preserved.push({name: intent.job_name, reason: 'text_update_owner_edited'}); continue;
    }
    const outcome = await text.native.updateText(target, live.id, {prompt, skills: [...job.skills]}, timeout);
    // IVB-024 (sesión 4): Hermes respondió 400 por largo y solo quedó `text_update_failed`. El motivo va con códigos y largo.
    if (outcome.kind !== 'updated') {report.pending.push({name: intent.job_name, reason: `text_update_failed:${outcome.kind}${'status' in outcome ? `:${outcome.status}` : ''}:len=${prompt.length}`}); continue;}
    const after = await text.native.list(target, timeout);
    const updated = after.kind === 'ok' ? after.jobs.find(item => item.id === live.id) : undefined;
    if (!updated || jobTextHash(updated.prompt, updated.skills) !== desired) {report.pending.push({name: intent.job_name, reason: 'text_update_unconfirmed'}); continue;}
    if (!await text.intents.retext(key, intent.desired_hash, desired)) {report.pending.push({name: intent.job_name, reason: 'text_update_intent_changed'}); continue;}
    report.text_updated.push(intent.job_name);
  }
}

/** Filtra por usuario y por negocio: habilitar a alguien no crea el trabajo en sus otros negocios. */
export function stockJobSync(addon: Pick<StockAddon, 'enabledFor'>, jobs: Pick<ManagedBusinessJobs, 'synchronize'>,
  enabledBusinesses: (userId: string) => Promise<readonly string[]>, text?: StockJobTextDeps) {
  return async (input: Sync): Promise<StockJobSyncReport | null> => {
    const {owner_id: owner, business_id: business} = input.context;
    if (!addon.enabledFor(owner) || !(await enabledBusinesses(owner)).includes(business)) return null;
    const report: StockJobSyncReport = {...await jobs.synchronize(input), text_updated: []};
    if (text) await upgradeText(text, input, report);
    return report;
  };
}
