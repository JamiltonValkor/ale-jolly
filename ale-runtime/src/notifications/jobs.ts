import {jobTextHash, type AgentBundle, type BundleJob} from '../activation/hermes-files';
import {TrustedContextV1} from '../contracts/continuous-loop';
import type {HermesTarget} from '../hermes/hermes-client';
import type {Database} from '../persistence/database';
import type {JobBinding} from './repository';
import {MANAGED_JOB_DELIVERY,MANAGED_JOB_HOLD,type ManagedJobsApi,type NativeManagedJob} from './native-jobs';

export interface Intent {
  owner_id:string;business_id:string;instance_generation:string;base_name:string;job_name:string;session_id:string;
  desired_hash:string;original_schedule:string;native_job_id:string|null;legacy_job_id:string|null;legacy_hash:string|null;
  create_attempted:boolean;legacy_pause_attempted:boolean;legacy_paused:boolean;created_at:Date;
  phase:'prepared'|'creating'|'created_paused'|'binding'|'active'|'preserved'|'missing'|'conflict';reason:string|null;
}
export type Key=Pick<Intent,'owner_id'|'business_id'|'instance_generation'|'base_name'>;
const params=(key:Key)=>[key.owner_id,key.business_id,key.instance_generation,key.base_name];
export class ManagedJobIntentRepository {
  constructor(private readonly db:Database){}
  async find(key:Key):Promise<Intent|null>{return (await this.db.pool.query('SELECT * FROM assistant.managed_job_intents WHERE owner_id=$1 AND business_id=$2 AND instance_generation=$3 AND base_name=$4',params(key))).rows[0] as Intent|undefined??null;}
  async prepare(input:Key&Pick<Intent,'job_name'|'session_id'|'desired_hash'|'original_schedule'|'legacy_job_id'|'legacy_hash'>):Promise<Intent>{
    await this.db.pool.query(`INSERT INTO assistant.managed_job_intents(owner_id,business_id,instance_generation,base_name,job_name,session_id,desired_hash,original_schedule,legacy_job_id,legacy_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,[...params(input),input.job_name,input.session_id,input.desired_hash,input.original_schedule,input.legacy_job_id,input.legacy_hash]);
    const saved=await this.find(input);if(!saved||saved.session_id!==input.session_id)throw new Error('managed_job_binding_conflict');return saved;
  }
  /** A retired generic job is owner-wide; its completed migration is not a pause of a new business. */
  async legacyMigrations(key:Key):Promise<Intent[]>{
    return (await this.db.pool.query(`SELECT * FROM assistant.managed_job_intents
      WHERE owner_id=$1 AND business_id<>$2 AND instance_generation=$3 AND base_name=$4
      AND legacy_job_id IS NOT NULL AND legacy_hash IS NOT NULL AND native_job_id IS NOT NULL
      AND create_attempted=true AND legacy_pause_attempted=true AND phase IN ('created_paused','binding','active')`,params(key))).rows as Intent[];
  }
  /** Detach only the exact unused legacy link whose service migration was independently observed. */
  async detachRetiredLegacy(intent:Intent):Promise<boolean>{
    return !!(await this.db.pool.query(`UPDATE assistant.managed_job_intents SET legacy_job_id=NULL,legacy_hash=NULL,
      phase=CASE WHEN phase='preserved' THEN 'prepared' ELSE phase END,reason=NULL,updated_at=now()
      WHERE owner_id=$1 AND business_id=$2 AND instance_generation=$3 AND base_name=$4
      AND session_id=$5 AND desired_hash=$6 AND original_schedule=$7 AND phase=$8 AND reason IS NOT DISTINCT FROM $9
      AND legacy_job_id IS NOT DISTINCT FROM $10 AND legacy_hash IS NOT DISTINCT FROM $11
      AND native_job_id IS NOT DISTINCT FROM $12 AND create_attempted=$13
      AND legacy_pause_attempted=false AND legacy_paused=false RETURNING owner_id`,
    [...params(intent),intent.session_id,intent.desired_hash,intent.original_schedule,intent.phase,intent.reason,
      intent.legacy_job_id,intent.legacy_hash,intent.native_job_id,intent.create_attempted])).rows.length;
  }
  async claimCreation(key:Key):Promise<boolean>{return !!(await this.db.pool.query(`UPDATE assistant.managed_job_intents SET create_attempted=true,phase='creating',updated_at=now()
    WHERE owner_id=$1 AND business_id=$2 AND instance_generation=$3 AND base_name=$4 AND create_attempted=false AND phase='prepared' RETURNING owner_id`,params(key))).rows.length;}
  async observed(key:Key,jobId:string):Promise<void>{
    const result=await this.db.pool.query(`UPDATE assistant.managed_job_intents SET native_job_id=$5,phase='created_paused',updated_at=now()
      WHERE owner_id=$1 AND business_id=$2 AND instance_generation=$3 AND base_name=$4 AND (native_job_id IS NULL OR native_job_id=$5) RETURNING owner_id`,[...params(key),jobId]);
    if(!result.rows.length)throw new Error('managed_job_identity_conflict');
  }
  async phase(key:Key,phase:Intent['phase'],reason:string|null=null):Promise<void>{await this.db.pool.query(`UPDATE assistant.managed_job_intents SET phase=$5,reason=$6,updated_at=now()
    WHERE owner_id=$1 AND business_id=$2 AND instance_generation=$3 AND base_name=$4`,[...params(key),phase,reason]);}
  /** IVB-023: el texto instalado pasa a la versión nueva solo si sigue siendo el que el servicio puso (`from`). */
  async retext(key:Key,from:string,to:string):Promise<boolean>{return !!(await this.db.pool.query(`UPDATE assistant.managed_job_intents SET desired_hash=$6,updated_at=now()
    WHERE owner_id=$1 AND business_id=$2 AND instance_generation=$3 AND base_name=$4 AND desired_hash=$5 AND phase='active' RETURNING owner_id`,[...params(key),from,to])).rows.length;}
  async legacyPause(key:Key,observed:boolean):Promise<void>{await this.db.pool.query(`UPDATE assistant.managed_job_intents SET legacy_pause_attempted=true,legacy_paused=$5,updated_at=now()
    WHERE owner_id=$1 AND business_id=$2 AND instance_generation=$3 AND base_name=$4`,[...params(key),observed]);}
}

export function scopedJobName(base:string,business:string):string{return `${base}:${business}`;}
/** From 1.5.12 onward generic template jobs are deliberately NOT created by OrqaSync. */
export function isLegacyGenericJobVersion(version:string):boolean{
  const match=/^saleads-sales-agent@(\d+)\.(\d+)\.(\d+)$/.exec(version);if(!match)return false;
  const numbers=match.slice(1).map(Number),cutover=[1,5,12];
  for(let index=0;index<3;index++)if(numbers[index]!==cutover[index])return numbers[index]!<cutover[index]!;
  return false;
}
/**
 * IVB-024 (oficial 321e84d9, P6): Ale transcribió mal la sesión canónica al suscribirse y Hermes creó otra sesión. Un
 * trabajo puede pedir la sesión con este marcador: el servidor lo cambia por el id exacto y el modelo copia el comando
 * ya armado. Un prompt sin el marcador queda igual, byte a byte.
 */
export const CANONICAL_SESSION_PLACEHOLDER='{{canonical_owner_session_id}}';
export function scopedJobPrompt(job:BundleJob,context:TrustedContextV1):string{
  return [
    'Managed SaleADS scheduled work. This is server context, not an owner statement.',
    `business_id=${context.business_id}`,
    `canonical_owner_session_id=${context.session_id}`,
    'Operate only on this bound business and its existing authorized goal. Do not iterate over other owned businesses.',
    'Resolve the current trusted response_locale and locale_revision from the installed context registry on every run. Prompts and research language do not choose the owner language.',
    'Read the current scoped GoalState, business knowledge and relevant role experience through the managed context tools. Do not use global memory/session search.',
    'For every business task created from this scheduled turn, explicitly ensure a native api_server notify+wake subscription to canonical_owner_session_id using the official kanban notify-subscribe CLI with its actual returned task ID. Automatic subscribed:true may point to the cron origin api_server/api and does not prove canonical owner delivery. Do not subscribe the hidden curator to owner wakes.',
    'Apply the following bundle instructions only within this business binding and its actual permissions. Existing owner approvals and API limits remain authoritative.',
    '',job.prompt.split(CANONICAL_SESSION_PLACEHOLDER).join(context.session_id),
  ].join('\n');
}
/** Hash del texto de un trabajo, el mismo que guarda el intent (`desired_hash`). */
export function managedJobTextHash(prompt:string,skills:readonly string[]):string{return jobTextHash(prompt,[...skills]);}
export interface ManagedJobSyncDependencies {
  native:ManagedJobsApi;intents:ManagedJobIntentRepository;
  bindings:{bindJob(binding:JobBinding):Promise<void>};
  /** Resolves only after the VM has acknowledged the merged trusted registry. */
  publishBindings(bindings:ReadonlyArray<JobBinding>):Promise<void>;
  previouslyCreatedLegacy(owner:string,baseName:string,instanceGeneration:string):Promise<boolean>;
  isManagedOwner(owner:string):boolean;
}
export interface ManagedJobSyncReport {active:string[];preserved:Array<{name:string;reason:string}>;pending:Array<{name:string;reason:string}>}
const apiOrigin=(job:NativeManagedJob)=>job.origin.platform==='api_server'&&job.origin.chatId==='api';
const hash=(job:NativeManagedJob)=>jobTextHash(job.prompt,job.skills);
interface Staged {intent:Intent;job:NativeManagedJob;binding:JobBinding}
type LegacyRetirement={state:'retired'|'pending'|'protected'|'unverifiable';donor:Intent};
const instant=(value:unknown):number=>Object.prototype.toString.call(value)==='[object Date]'?Date.prototype.getTime.call(value):
  typeof value==='string'?Date.parse(value):NaN;
const retirementWait=(retirement:LegacyRetirement|null):string|null=>retirement?.state==='pending'?'legacy_migration_pending':
  retirement?.state==='unverifiable'?'legacy_retirement_unverified':null;

/** One explicit selected flow. Newly-created jobs cannot execute until DB+VM bindings are acknowledged. */
export class ManagedBusinessJobs {
  constructor(private readonly bundle:AgentBundle,private readonly deps:ManagedJobSyncDependencies,private readonly timeoutMs=10000){}
  private async legacyRetirement(key:Key,job:BundleJob,jobs:ReadonlyArray<NativeManagedJob>,expected?:Intent):Promise<LegacyRetirement|null>{
    const generics=jobs.filter(item=>item.name===job.name);
    if(generics.length>1)return null;
    const generic=generics[0];
    // Unknown state, owner customization, or an explicit owner pause remains protected.
    if(generic&&(!apiOrigin(generic)||generic.enabled===null||generic.paused_reason!==null||!generic.schedule||
      !(this.bundle.knownJobHashes[job.name]??[]).includes(hash(generic))))return null;
    const donors=await this.deps.intents.legacyMigrations(key);
    for(const donor of donors){
      if(!(this.bundle.knownJobHashes[job.name]??[]).includes(donor.legacy_hash??''))continue;
      if(expected&&((expected.legacy_job_id!==null&&expected.legacy_job_id!==donor.legacy_job_id)||
        (expected.legacy_hash!==null&&expected.legacy_hash!==donor.legacy_hash)||expected.original_schedule!==donor.original_schedule))continue;
      if(generic&&(generic.id!==donor.legacy_job_id||hash(generic)!==donor.legacy_hash||generic.schedule!==donor.original_schedule))continue;
      // An absent generic can be ignored only after that exact identity was migrated, not when renamed/replaced.
      if(!generic&&jobs.some(item=>item.id===donor.legacy_job_id))continue;
      const scoped=jobs.find(item=>item.id===donor.native_job_id);
      if(!scoped||scoped.name!==scopedJobName(job.name,donor.business_id)||!apiOrigin(scoped)||
        hash(scoped)!==donor.desired_hash||scoped.schedule!==donor.original_schedule||scoped.deliver!==MANAGED_JOB_DELIVERY)continue;
      if(donor.phase==='active'&&donor.legacy_paused&&scoped.enabled===true){
        if(generic?.enabled===true)return {state:'protected',donor};
        if(generic){
          const paused=instant(generic.paused_at),created=instant(donor.created_at);
          if(!Number.isFinite(paused)||!Number.isFinite(created))return {state:'unverifiable',donor};
          if(paused<created||(expected&&(!Number.isFinite(instant(expected.created_at))||instant(expected.created_at)<paused)))continue;
        }else if(expected){
          // A missing generic has no immutable pause time. Do not rewrite historical owner-deletion decisions.
          return {state:'unverifiable',donor};
        }
        return {state:'retired',donor};
      }
      if(donor.phase!=='active'&&(scoped.enabled===true||(scoped.enabled===false&&scoped.paused_reason===MANAGED_JOB_HOLD)))return {state:'pending',donor};
    }
    return null;
  }
  async synchronize(input:{context:TrustedContextV1;target:HermesTarget;instance_generation:string}):Promise<ManagedJobSyncReport>{
    const context=TrustedContextV1.parse(input.context);
    if(!this.deps.isManagedOwner(context.owner_id)||context.actor_role!=='ale')throw new Error('managed_job_scope_required');
    if(!input.instance_generation||input.instance_generation.length>300)throw new Error('managed_job_generation_required');
    const report:ManagedJobSyncReport={active:[],preserved:[],pending:[]};
    const staged:Staged[]=[];
    const initial=await this.deps.native.list(input.target,this.timeoutMs);
    if(initial.kind!=='ok'){report.pending.push({name:'selected-flow',reason:'native_inventory_unavailable'});return report;}
    for(const job of this.bundle.jobs){
      const key:Key={owner_id:context.owner_id,business_id:context.business_id,instance_generation:input.instance_generation,base_name:job.name};
      const name=scopedJobName(job.name,context.business_id),prompt=scopedJobPrompt(job,context);
      let intent=await this.deps.intents.find(key);
      if(intent&&['preserved','missing','conflict'].includes(intent.phase)){
        if(intent.phase==='preserved'&&['owner_paused_legacy','owner_deleted_legacy'].includes(intent.reason??'')&&
          !intent.create_attempted&&!intent.native_job_id&&!intent.legacy_pause_attempted&&!intent.legacy_paused&&
          intent.session_id===context.session_id&&intent.desired_hash===jobTextHash(prompt,job.skills)&&
          !initial.jobs.some(item=>item.name===name)){
          const retirement=await this.legacyRetirement(key,job,initial.jobs,intent);
          if(retirementWait(retirement)){report.pending.push({name,reason:retirementWait(retirement)!});continue;}
          if(retirement?.state==='retired'&&await this.deps.intents.detachRetiredLegacy(intent))intent=await this.deps.intents.find(key);
        }
        if(intent&&['preserved','missing','conflict'].includes(intent.phase)){report.preserved.push({name,reason:intent.reason??intent.phase});continue;}
      }
      if(!intent){
        const legacy=initial.jobs.filter(j=>j.name===job.name),collision=initial.jobs.some(j=>j.name===name);
        const current=legacy[0];
        const retirement=await this.legacyRetirement(key,job,initial.jobs);
        if(retirementWait(retirement)){report.pending.push({name,reason:retirementWait(retirement)!});continue;}
        let reason:string|null=retirement?.state==='protected'?'owner_resumed_legacy':null;
        if(collision)reason='unregistered_scoped_name';
        else if(legacy.length>1)reason='ambiguous_legacy_name';
        else if(current&&(!apiOrigin(current)||!(this.bundle.knownJobHashes[job.name]??[]).includes(hash(current))))reason='custom_or_foreign_legacy';
        else if(current&&current.enabled!==true&&!retirement)reason=current.enabled===false?'owner_paused_legacy':'unknown_legacy_state';
        else if(current&&!current.schedule)reason='unsupported_legacy_schedule';
        else if(!current&&!retirement&&await this.deps.previouslyCreatedLegacy(context.owner_id,job.name,input.instance_generation))reason='owner_deleted_legacy';
        intent=await this.deps.intents.prepare({...key,job_name:name,session_id:context.session_id,desired_hash:jobTextHash(prompt,job.skills),
          original_schedule:retirement?.donor.original_schedule??current?.schedule??job.schedule,legacy_job_id:retirement?.state==='retired'?null:current?.id??null,legacy_hash:retirement?.state!=='retired'&&current?hash(current):null});
        if(reason){await this.deps.intents.phase(key,'preserved',reason);report.preserved.push({name,reason});continue;}
      }
      if(intent.session_id!==context.session_id){report.pending.push({name,reason:'canonical_session_changed'});continue;}
      let inventory=await this.deps.native.list(input.target,this.timeoutMs);
      if(inventory.kind!=='ok'){report.pending.push({name,reason:'native_inventory_unavailable'});continue;}
      let matches=inventory.jobs.filter(j=>j.name===name);
      if(matches.length>1){await this.deps.intents.phase(key,'conflict','duplicate_scoped_jobs');report.preserved.push({name,reason:'duplicate_scoped_jobs'});continue;}
      if(!matches.length&&intent.native_job_id){await this.deps.intents.phase(key,'missing','owner_deleted_scoped_job');report.preserved.push({name,reason:'owner_deleted_scoped_job'});continue;}
      if(!matches.length&&!intent.create_attempted){
        if(await this.deps.intents.claimCreation(key)){
          await this.deps.native.createPaused(input.target,{name,schedule:intent.original_schedule,prompt,skills:[...job.skills],deliver:MANAGED_JOB_DELIVERY},this.timeoutMs);
        }
        // A create ACK does not establish identity. Reconcile the authoritative
        // inventory even on rejection/network failure; never send another POST.
        inventory=await this.deps.native.list(input.target,this.timeoutMs);
        if(inventory.kind!=='ok'){report.pending.push({name,reason:'create_ack_unconfirmed'});continue;}
        matches=inventory.jobs.filter(j=>j.name===name);
      }
      if(matches.length!==1){report.pending.push({name,reason:matches.length?'duplicate_scoped_jobs':'create_ack_unconfirmed'});continue;}
      const live=matches[0]!;
      if(!apiOrigin(live)||hash(live)!==intent.desired_hash||live.schedule!==intent.original_schedule||live.deliver!==MANAGED_JOB_DELIVERY){
        await this.deps.intents.phase(key,'preserved','scoped_job_modified');report.preserved.push({name,reason:'scoped_job_modified'});continue;
      }
      if(intent.native_job_id&&intent.native_job_id!==live.id){await this.deps.intents.phase(key,'conflict','scoped_job_replaced');report.preserved.push({name,reason:'scoped_job_replaced'});continue;}
      if(!intent.native_job_id&&live.enabled!==false){
        // Wrong/unverified native versions must not be treated as safely paused.
        await this.deps.native.pause(input.target,live.id,this.timeoutMs);
        report.pending.push({name,reason:'creation_not_confirmed_paused'});continue;
      }
      if(live.enabled===null){report.pending.push({name,reason:'unknown_scoped_state'});continue;}
      if(live.enabled===false&&live.paused_reason!==MANAGED_JOB_HOLD){
        await this.deps.intents.phase(key,'preserved','owner_paused_scoped_job');report.preserved.push({name,reason:'owner_paused_scoped_job'});continue;
      }
      await this.deps.intents.observed(key,live.id);
      intent=(await this.deps.intents.find(key))!;
      const binding:JobBinding={owner_id:context.owner_id,business_id:context.business_id,session_id:context.session_id,job_id:live.id,
        response_locale:context.response_locale,locale_revision:context.locale_revision};
      await this.deps.bindings.bindJob(binding);
      staged.push({intent,job:live,binding});
    }
    if(!staged.length)return report;
    try{await this.deps.publishBindings(staged.map(item=>item.binding));}
    catch{for(const {intent} of staged)report.pending.push({name:intent.job_name,reason:'registry_ack_pending'});return report;}
    for(const {intent:stagedIntent} of staged){
      await this.deps.intents.phase(stagedIntent,'binding');
      const intent=(await this.deps.intents.find(stagedIntent))!;
      let inventory=await this.deps.native.list(input.target,this.timeoutMs);
      if(inventory.kind!=='ok'){report.pending.push({name:intent.job_name,reason:'native_inventory_unavailable'});continue;}
      let live=inventory.jobs.find(j=>j.id===intent.native_job_id);
      if(!live||hash(live)!==intent.desired_hash||!apiOrigin(live)||live.deliver!==MANAGED_JOB_DELIVERY||live.schedule!==intent.original_schedule){
        report.pending.push({name:intent.job_name,reason:'job_changed_before_admission'});continue;
      }
      if(intent.legacy_job_id&&!intent.legacy_paused){
        const legacy=inventory.jobs.find(j=>j.id===intent.legacy_job_id);
        if(!legacy||!apiOrigin(legacy)||hash(legacy)!==intent.legacy_hash){report.preserved.push({name:intent.job_name,reason:'legacy_changed_before_migration'});continue;}
        const retirement=!intent.legacy_pause_attempted?await this.legacyRetirement(intent,this.bundle.jobs.find(job=>job.name===intent.base_name)!,inventory.jobs,intent):null;
        if(retirementWait(retirement)){report.pending.push({name:intent.job_name,reason:retirementWait(retirement)!});continue;}
        if(retirement?.state==='protected'){report.preserved.push({name:intent.job_name,reason:'owner_resumed_legacy'});continue;}
        if(legacy.enabled===false&&!intent.legacy_pause_attempted){
          if(retirement?.state!=='retired'||!await this.deps.intents.detachRetiredLegacy(intent)){
            report.preserved.push({name:intent.job_name,reason:'owner_paused_legacy'});continue;
          }
        }else{
          if(legacy.enabled===null){report.pending.push({name:intent.job_name,reason:'unknown_legacy_state'});continue;}
          if(legacy.enabled===true){
            await this.deps.intents.legacyPause(intent,false);
            await this.deps.native.pause(input.target,legacy.id,this.timeoutMs);
            inventory=await this.deps.native.list(input.target,this.timeoutMs);
            if(inventory.kind!=='ok'||inventory.jobs.find(j=>j.id===legacy.id)?.enabled!==false){report.pending.push({name:intent.job_name,reason:'legacy_pause_unconfirmed'});continue;}
          }
          await this.deps.intents.legacyPause(intent,true);
        }
      }
      // Refresh after legacy migration and before admission: an owner pause or
      // text/schedule edit never becomes an implicit request to resume.
      inventory=await this.deps.native.list(input.target,this.timeoutMs);
      if(inventory.kind!=='ok'){report.pending.push({name:intent.job_name,reason:'native_inventory_unavailable'});continue;}
      live=inventory.jobs.find(j=>j.id===intent.native_job_id);
      if(!live||hash(live)!==intent.desired_hash||live.schedule!==intent.original_schedule||live.deliver!==MANAGED_JOB_DELIVERY){report.pending.push({name:intent.job_name,reason:'job_changed_before_admission'});continue;}
      if(live.enabled===false&&live.paused_reason===MANAGED_JOB_HOLD){
        await this.deps.native.resume(input.target,live.id,this.timeoutMs);
        inventory=await this.deps.native.list(input.target,this.timeoutMs);
        if(inventory.kind!=='ok'||inventory.jobs.find(j=>j.id===live!.id)?.enabled!==true){report.pending.push({name:intent.job_name,reason:'resume_ack_unconfirmed'});continue;}
      }else if(live.enabled!==true){report.preserved.push({name:intent.job_name,reason:'owner_paused_scoped_job'});continue;}
      await this.deps.intents.phase(intent,'active');report.active.push(intent.job_name);
    }
    return report;
  }
}
