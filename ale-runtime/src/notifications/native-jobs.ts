import type {HermesJobInput, HermesTarget, JobCreateOutcome, JobTextPatch, JobUpdateOutcome} from '../hermes/hermes-client';
import type {OutboundFetch} from '../outbound/http-client';

export const MANAGED_JOB_HOLD = 'saleads-managed-binding-pending/1';
export const MANAGED_JOB_DELIVERY = 'saleads_home:current';
export interface NativeManagedJob {
  id:string; name:string; prompt:string; skills:string[]; enabled:boolean|null;
  schedule:string|null; deliver:string|null; paused_reason:string|null; paused_at?:string|null;
  origin:{platform:string|null;chatId:string|null};
}
export type NativeManagedJobsOutcome = {kind:'ok';jobs:NativeManagedJob[]}|{kind:'unauthorized'}|{kind:'unreachable';reason:string};
export interface ManagedJobsApi {
  list(target:HermesTarget,timeoutMs:number):Promise<NativeManagedJobsOutcome>;
  createPaused(target:HermesTarget,job:HermesJobInput,timeoutMs:number):Promise<JobCreateOutcome>;
  pause(target:HermesTarget,id:string,timeoutMs:number):Promise<JobUpdateOutcome>;
  resume(target:HermesTarget,id:string,timeoutMs:number):Promise<JobUpdateOutcome>;
}
const ID=/^[a-f0-9]{12}$/;
const IPV4=/^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const record=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
const text=(value:unknown):string|null=>typeof value==='string'?value:null;

/** Exact upstream a28a5d03 API: create forwards paused/paused_reason atomically.
 * Existing classic job clients and owner-authored schedules remain unchanged. */
export class NativeManagedJobsClient implements ManagedJobsApi {
  constructor(private readonly fetcher:OutboundFetch,private readonly port:number) {}
  private base(target:HermesTarget):string {
    if(!IPV4.test(target.ip)||!Number.isSafeInteger(this.port)||this.port<1||this.port>65535)throw new Error('invalid_hermes_target');
    return `http://${target.ip}:${this.port}`;
  }
  private headers(target:HermesTarget){return {authorization:`Bearer ${target.apiServerKey}`,'content-type':'application/json'};}
  async list(target:HermesTarget,timeoutMs:number):Promise<NativeManagedJobsOutcome>{
    let response:Response;
    try{response=await this.fetcher(`${this.base(target)}/api/jobs?include_disabled=true`,{headers:this.headers(target),signal:AbortSignal.timeout(timeoutMs)});}
    catch{return {kind:'unreachable',reason:'network'};}
    if(response.status===401||response.status===403){await response.arrayBuffer();return {kind:'unauthorized'};}
    if(!response.ok){await response.arrayBuffer();return {kind:'unreachable',reason:`jobs_${response.status}`};}
    let body:Record<string,unknown>|null;
    try{body=record(await response.json());}catch{return {kind:'unreachable',reason:'invalid_jobs'};}
    if(!Array.isArray(body?.jobs))return {kind:'unreachable',reason:'invalid_jobs'};
    const jobs:NativeManagedJob[]=[];
    for(const value of body.jobs){
      const job=record(value);if(!job||typeof job.id!=='string'||!ID.test(job.id)||typeof job.name!=='string')return {kind:'unreachable',reason:'invalid_job_identity'};
      const origin=record(job.origin),schedule=record(job.schedule);
      let expression:string|null=null;
      if(typeof job.schedule==='string'&&job.schedule.trim())expression=job.schedule;
      else if(schedule?.kind==='cron'&&typeof schedule.expr==='string')expression=schedule.expr;
      else if(schedule?.kind==='interval'&&Number.isSafeInteger(schedule.minutes)&&Number(schedule.minutes)>0)expression=`every ${schedule.minutes}m`;
      jobs.push({id:job.id,name:job.name,prompt:text(job.prompt)??'',
        skills:Array.isArray(job.skills)?job.skills.filter((v):v is string=>typeof v==='string'):[],
        enabled:typeof job.enabled==='boolean'?job.enabled:null,schedule:expression,deliver:text(job.deliver),paused_reason:text(job.paused_reason),paused_at:text(job.paused_at),
        origin:{platform:text(origin?.platform),chatId:text(origin?.chat_id)}});
    }
    return {kind:'ok',jobs};
  }
  async createPaused(target:HermesTarget,job:HermesJobInput,timeoutMs:number):Promise<JobCreateOutcome>{
    let response:Response;
    try{response=await this.fetcher(`${this.base(target)}/api/jobs`,{method:'POST',headers:this.headers(target),signal:AbortSignal.timeout(timeoutMs),
      body:JSON.stringify({...job,paused:true,paused_reason:MANAGED_JOB_HOLD})});}
    catch{return {kind:'unreachable',reason:'network'};}
    await response.arrayBuffer();
    if(response.status===401||response.status===403)return {kind:'unauthorized'};
    if(response.ok)return {kind:'created'};
    if(response.status>=400&&response.status<500)return {kind:'rejected',status:response.status};
    return {kind:'unreachable',reason:`job_${response.status}`};
  }
  pause(target:HermesTarget,id:string,timeoutMs:number):Promise<JobUpdateOutcome>{return this.action(target,id,'pause',timeoutMs);}
  resume(target:HermesTarget,id:string,timeoutMs:number):Promise<JobUpdateOutcome>{return this.action(target,id,'resume',timeoutMs);}
  /** IVB-023: cambia solo el texto (prompt y skills) de un trabajo existente; nombre, horario y pausa no se tocan. */
  async updateText(target:HermesTarget,id:string,patch:JobTextPatch,timeoutMs:number):Promise<JobUpdateOutcome>{
    if(!ID.test(id))return {kind:'rejected',status:0};
    const body:JobTextPatch={};
    if(patch.prompt!==undefined)body.prompt=patch.prompt;
    if(patch.skills!==undefined)body.skills=[...patch.skills];
    if(!Object.keys(body).length)return {kind:'rejected',status:0};
    let response:Response;
    try{response=await this.fetcher(`${this.base(target)}/api/jobs/${id}`,{method:'PATCH',headers:this.headers(target),signal:AbortSignal.timeout(timeoutMs),body:JSON.stringify(body)});}
    catch{return {kind:'unreachable',reason:'network'};}
    await response.arrayBuffer();
    if(response.status===401||response.status===403)return {kind:'unauthorized'};
    if(response.status===404)return {kind:'not_found'};
    if(response.ok)return {kind:'updated'};
    if(response.status>=400&&response.status<500)return {kind:'rejected',status:response.status};
    return {kind:'unreachable',reason:`job_${response.status}`};
  }
  /** Hermes `trigger_job` borra la pausa: quien llame debe leer `enabled` y `paused_reason` antes. */
  run(target:HermesTarget,id:string,timeoutMs:number):Promise<JobUpdateOutcome>{return this.action(target,id,'run',timeoutMs);}
  private async action(target:HermesTarget,id:string,action:'pause'|'resume'|'run',timeoutMs:number):Promise<JobUpdateOutcome>{
    if(!ID.test(id))return {kind:'rejected',status:0};
    let response:Response;
    try{response=await this.fetcher(`${this.base(target)}/api/jobs/${id}/${action}`,{method:'POST',headers:this.headers(target),signal:AbortSignal.timeout(timeoutMs)});}
    catch{return {kind:'unreachable',reason:'network'};}
    await response.arrayBuffer();
    if(response.status===401||response.status===403)return {kind:'unauthorized'};
    if(response.status===404)return {kind:'not_found'};
    if(response.ok)return {kind:'updated'};
    if(response.status>=400&&response.status<500)return {kind:'rejected',status:response.status};
    return {kind:'unreachable',reason:`job_${response.status}`};
  }
}
