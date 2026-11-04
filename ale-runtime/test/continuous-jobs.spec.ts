import {randomBytes} from 'node:crypto';
import {jobTextHash,type AgentBundle} from '../src/activation/hermes-files';
import type {TrustedContextV1} from '../src/contracts/continuous-loop';
import type {HermesJobInput,HermesTarget} from '../src/hermes/hermes-client';
import {ManagedBusinessJobs,ManagedJobIntentRepository,isLegacyGenericJobVersion,scopedJobName,scopedJobPrompt} from '../src/notifications/jobs';
import {MANAGED_JOB_DELIVERY,MANAGED_JOB_HOLD,NativeManagedJobsClient,type ManagedJobsApi,type NativeManagedJob} from '../src/notifications/native-jobs';
import {NotificationRepository,type JobBinding} from '../src/notifications/repository';
import {FieldCipher} from '../src/security/field-cipher';
import {isManagedMetaUser} from '../src/ai/meta-model';
import {startTestDatabase,type TestDatabase} from './support/pglite-db';

const BUSINESS='11111111-1111-4111-8111-111111111111';
const OTHER='22222222-2222-4222-8222-222222222222';
const target:HermesTarget={ip:'10.20.0.10',apiServerKey:'synthetic-api-key'};
const context:TrustedContextV1={schema_version:'trusted-context/1',owner_id:'fixture-owner',business_id:BUSINESS,session_id:'fixture-session',
  actor_role:'ale',native_task_id:null,native_run_id:null,response_locale:'pt',locale_revision:1,capabilities:['saleads:read'],mandate_id:null,pending_context:false};
const base={name:'saleads:loop-tick',schedule:'0 */3 * * *',prompt:'Advance the existing authorized goal using actual evidence.',skills:['saleads-loop-orchestration']};
const bundle:AgentBundle={version:'fixture@1.5.12',soul:'',skills:'',profiles:{},jobs:[base],knownJobHashes:{[base.name]:[jobTextHash(base.prompt,base.skills)]},jobNamesByVersion:{}};
let nextNativeId=1;

class NativeFake implements ManagedJobsApi {
  jobs:NativeManagedJob[]=[];events:string[]=[];created=0;hidden=false;lostCreateAck=false;
  async list(){this.events.push('list');return {kind:'ok' as const,jobs:this.hidden?[]:structuredClone(this.jobs)};}
  async createPaused(_target:HermesTarget,job:HermesJobInput){
    this.created++;this.events.push('create-paused');
    this.jobs.push({id:(nextNativeId++).toString(16).padStart(12,'0'),...structuredClone(job),enabled:false,paused_reason:MANAGED_JOB_HOLD,paused_at:new Date().toISOString(),origin:{platform:'api_server',chatId:'api'}});
    return this.lostCreateAck?{kind:'unreachable' as const,reason:'network'}:{kind:'created' as const};
  }
  async pause(_target:HermesTarget,id:string){
    this.events.push('pause:'+id);const job=this.jobs.find(j=>j.id===id);
    if(!job)return {kind:'not_found' as const};job.enabled=false;job.paused_reason=null;job.paused_at=new Date().toISOString();return {kind:'updated' as const};
  }
  async resume(_target:HermesTarget,id:string){
    this.events.push('resume:'+id);const job=this.jobs.find(j=>j.id===id);
    if(!job)return {kind:'not_found' as const};job.enabled=true;job.paused_reason=null;job.paused_at=null;return {kind:'updated' as const};
  }
  legacy(patch:Partial<NativeManagedJob>={}){const job:NativeManagedJob={id:'abcdef000001',name:base.name,prompt:base.prompt,skills:[...base.skills],schedule:base.schedule,enabled:true,deliver:'all',paused_reason:null,paused_at:null,origin:{platform:'api_server',chatId:'api'},...patch};this.jobs.push(job);return job;}
}

describe('managed selected-business jobs and durable native admission',()=>{
  let pg:TestDatabase,bindings:NotificationRepository,intents:ManagedJobIntentRepository;
  let serial=0;
  beforeAll(async()=>{pg=await startTestDatabase();bindings=new NotificationRepository(pg.database,new FieldCipher(randomBytes(32)));intents=new ManagedJobIntentRepository(pg.database);});
  afterAll(async()=>pg.close());
  function setup(options:{publish?:(rows:ReadonlyArray<JobBinding>)=>Promise<void>;deleted?:boolean;managed?:boolean;generation?:string}={}){
    const native=new NativeFake(),published:JobBinding[][]=[];
    const generation=options.generation??`fixture-vm:${++serial}`;
    const deps={native,intents,bindings,isManagedOwner:()=>options.managed??true,previouslyCreatedLegacy:async(_owner:string,_name:string,_generation:string)=>options.deleted??false,
      publishBindings:async(rows:ReadonlyArray<JobBinding>)=>{native.events.push('publish');published.push([...rows]);if(options.publish)await options.publish(rows);}};
    return {native,published,generation,deps,service:new ManagedBusinessJobs(bundle,deps),input:{context,target,instance_generation:generation}};
  }
  it('creates atomically paused, observes native identity, publishes scoped bindings before the first resume',async()=>{
    const test=setup({publish:async rows=>{
      expect(test.native.jobs.every(job=>job.enabled===false)).toBe(true);
      for(const row of rows)expect(await bindings.binding(row.owner_id,row.job_id)).toMatchObject(row);
    }});
    const report=await test.service.synchronize(test.input);
    expect(report.active).toEqual([scopedJobName(base.name,BUSINESS)]);
    expect(test.native.created).toBe(1);
    expect(test.native.events.indexOf('publish')).toBeLessThan(test.native.events.findIndex(event=>event.startsWith('resume:')));
    expect(test.published[0]).toEqual([expect.objectContaining({business_id:BUSINESS,session_id:context.session_id,response_locale:'pt'})]);
    expect(test.native.jobs[0]).toMatchObject({deliver:MANAGED_JOB_DELIVERY,schedule:base.schedule});
  });
  it('admits another account through explicit managed scope without sharing its job bindings or intents',async()=>{
    const scope={enabled:true,userId:context.owner_id,allUsers:true};
    const first=setup(),second=setup();
    const isManagedOwner=(owner:string)=>isManagedMetaUser(scope,owner);
    const otherContext={...context,owner_id:'unrelated-managed-owner',business_id:OTHER,session_id:'unrelated-owner-session',response_locale:'fr'};
    await new ManagedBusinessJobs(bundle,{...first.deps,isManagedOwner}).synchronize(first.input);
    await new ManagedBusinessJobs(bundle,{...second.deps,isManagedOwner}).synchronize({...second.input,context:otherContext});
    expect(second.native.created).toBe(1);expect(first.native.created).toBe(1);
    const otherBinding=second.published[0]![0]!;
    expect(otherBinding).toMatchObject({owner_id:otherContext.owner_id,business_id:OTHER,session_id:otherContext.session_id,response_locale:'fr'});
    expect(await bindings.binding(context.owner_id,otherBinding.job_id)).toBeNull();
    expect(second.native.jobs[0]!.prompt).toContain('canonical_owner_session_id='+otherContext.session_id);
    expect(second.native.jobs[0]!.prompt).not.toContain(BUSINESS);
    const key={owner_id:otherContext.owner_id,business_id:OTHER,instance_generation:second.generation,base_name:base.name};
    expect(await intents.find(key)).toMatchObject({owner_id:otherContext.owner_id,phase:'active'});
    expect(await intents.find({...key,owner_id:context.owner_id})).toBeNull();
  });
  it('migrates only known bundle text and API origin, preserving the original schedule',async()=>{
    const test=setup();const legacy=test.native.legacy({schedule:'5 4 * * *'});
    await test.service.synchronize(test.input);
    expect(legacy.enabled).toBe(false);
    expect(test.native.jobs.find(job=>job.name===scopedJobName(base.name,BUSINESS))?.schedule).toBe('5 4 * * *');
    expect(test.native.events.indexOf('publish')).toBeLessThan(test.native.events.indexOf('pause:'+legacy.id));
    expect(test.native.events.indexOf('pause:'+legacy.id)).toBeLessThan(test.native.events.findIndex(event=>event.startsWith('resume:')));
    expect(legacy.prompt).toBe(base.prompt);expect(legacy.deliver).toBe('all');
  });
  it.each([
    [{enabled:false},'owner_paused_legacy'],
    [{prompt:'An owner customization.'},'custom_or_foreign_legacy'],
    [{origin:{platform:'telegram',chatId:'owner'}},'custom_or_foreign_legacy'],
    [{enabled:null},'unknown_legacy_state'],
    [{schedule:null},'unsupported_legacy_schedule'],
  ] as const)('never modifies protected legacy jobs %#',async(patch,reason)=>{
    const test=setup();test.native.legacy(patch as Partial<NativeManagedJob>);
    const before=structuredClone(test.native.jobs),report=await test.service.synchronize(test.input);
    expect(report.preserved[0]?.reason).toBe(reason);expect(test.native.jobs).toEqual(before);
    expect(test.native.created).toBe(0);expect(test.native.events.some(event=>event.startsWith('pause:'))).toBe(false);
  });
  it('does not restore a known legacy job that the owner deleted',async()=>{
    const test=setup({deleted:true});
    expect((await test.service.synchronize(test.input)).preserved[0]?.reason).toBe('owner_deleted_legacy');
    expect(test.native.created).toBe(0);
  });
  it('a freshly synchronized 1.5.12 bundle does not make empty native inventory look owner-deleted',async()=>{
    const test=setup();
    const versions=['saleads-sales-agent@1.5.12'];
    const namesByVersion={'saleads-sales-agent@1.5.12':[base.name]};
    test.deps.previouslyCreatedLegacy=async(_owner,name)=>versions.some(version=>
      isLegacyGenericJobVersion(version)&&(namesByVersion[version as keyof typeof namesByVersion]??[]).includes(name));
    const service=new ManagedBusinessJobs({...bundle,jobNamesByVersion:namesByVersion},test.deps);
    const report=await service.synchronize(test.input);
    expect(report.preserved).toEqual([]);expect(report.pending).toEqual([]);
    expect(report.active).toEqual([scopedJobName(base.name,BUSINESS)]);
    expect(test.native.created).toBe(1);expect(test.native.jobs[0]?.enabled).toBe(true);
    expect(test.native.events.indexOf('create-paused')).toBeLessThan(test.native.events.indexOf('publish'));
    expect(test.native.events.indexOf('publish')).toBeLessThan(test.native.events.findIndex(event=>event.startsWith('resume:')));
    await new ManagedBusinessJobs({...bundle,jobNamesByVersion:namesByVersion},test.deps).synchronize(test.input);
    expect(test.native.created).toBe(1);
  });
  it('a truly old 1.5.11 generic job recorded before its deletion remains protected',async()=>{
    const test=setup();
    const versions=['saleads-sales-agent@1.5.11','saleads-sales-agent@1.5.12'];
    const namesByVersion:Record<string,string[]>={'saleads-sales-agent@1.5.11':[base.name],'saleads-sales-agent@1.5.12':[base.name]};
    test.deps.previouslyCreatedLegacy=async(_owner,name)=>versions.some(version=>
      isLegacyGenericJobVersion(version)&&(namesByVersion[version]??[]).includes(name));
    const report=await new ManagedBusinessJobs({...bundle,jobNamesByVersion:namesByVersion},test.deps).synchronize(test.input);
    expect(report.preserved).toEqual([{name:scopedJobName(base.name,BUSINESS),reason:'owner_deleted_legacy'}]);
    expect(test.native.created).toBe(0);expect(test.published).toEqual([]);expect(test.native.jobs).toEqual([]);
  });
  it('lost create ACK is reconciled by listing; restart never creates a duplicate',async()=>{
    const test=setup();test.native.lostCreateAck=true;
    await test.service.synchronize(test.input);
    const restarted=new ManagedBusinessJobs(bundle,test.deps);
    await restarted.synchronize(test.input);
    expect(test.native.created).toBe(1);expect(test.native.jobs).toHaveLength(1);
  });
  it('an absent uncertain create remains pending without repeated POSTs even after restart',async()=>{
    const test=setup();test.native.hidden=true;
    const first=await test.service.synchronize(test.input);
    expect(first.pending[0]?.reason).toBe('create_ack_unconfirmed');
    await new ManagedBusinessJobs(bundle,test.deps).synchronize(test.input);
    expect(test.native.created).toBe(1);
    test.native.hidden=false;
    expect((await new ManagedBusinessJobs(bundle,test.deps).synchronize(test.input)).active).toHaveLength(1);
    expect(test.native.created).toBe(1);
  });
  it('failed publisher ACK leaves the new job paused and legacy unchanged, then safely resumes after recovery',async()=>{
    let unavailable=true;
    const test=setup({publish:async()=>{if(unavailable)throw new Error('controlled missing guest ACK');}});
    const legacy=test.native.legacy();
    const first=await test.service.synchronize(test.input);
    expect(first.pending[0]?.reason).toBe('registry_ack_pending');
    expect(legacy.enabled).toBe(true);expect(test.native.jobs.find(job=>job.id!==legacy.id)?.enabled).toBe(false);
    unavailable=false;
    expect((await new ManagedBusinessJobs(bundle,test.deps).synchronize(test.input)).active).toHaveLength(1);
    expect(test.native.created).toBe(1);expect(legacy.enabled).toBe(false);
  });
  it('preserves an owner pause and deletion of a scoped job across restart',async()=>{
    const paused=setup();await paused.service.synchronize(paused.input);
    paused.native.jobs[0]!.enabled=false;paused.native.jobs[0]!.paused_reason='Paused by owner.';
    const report=await new ManagedBusinessJobs(bundle,paused.deps).synchronize(paused.input);
    expect(report.preserved[0]?.reason).toBe('owner_paused_scoped_job');expect(paused.native.jobs[0]?.enabled).toBe(false);
    const deleted=setup();await deleted.service.synchronize(deleted.input);deleted.native.jobs=[];
    expect((await new ManagedBusinessJobs(bundle,deleted.deps).synchronize(deleted.input)).preserved[0]?.reason).toBe('owner_deleted_scoped_job');
    expect(deleted.native.created).toBe(1);
  });

  function otherInput(test:ReturnType<typeof setup>){return {...test.input,context:{...context,business_id:OTHER,session_id:'fixture-other-session'}};}
  async function preserveOther(test:ReturnType<typeof setup>,reason='owner_paused_legacy',legacy:NativeManagedJob|null=test.native.jobs.find(job=>job.name===base.name)??null){
    const other=otherInput(test);
    const saved=await intents.prepare({owner_id:context.owner_id,business_id:OTHER,instance_generation:test.generation,base_name:base.name,
      job_name:scopedJobName(base.name,OTHER),session_id:other.context.session_id,
      desired_hash:jobTextHash(scopedJobPrompt(base,other.context),base.skills),original_schedule:legacy?.schedule??base.schedule,
      legacy_job_id:legacy?.id??null,legacy_hash:legacy?jobTextHash(legacy.prompt,legacy.skills):null});
    await intents.phase(saved,'preserved',reason);
    return saved;
  }
  it('retext only moves an active intent from the exact installed hash (IVB-023)',async()=>{
    const OLD='a'.repeat(64),NEW='b'.repeat(64),OTHER_HASH='c'.repeat(64),NEWER='d'.repeat(64);
    const key={owner_id:context.owner_id,business_id:'7e88bd4a-0000-4000-8000-00000000e7e7',instance_generation:'retext-gen',base_name:base.name};
    await intents.prepare({...key,job_name:scopedJobName(base.name,key.business_id),session_id:'retext-session',desired_hash:OLD,original_schedule:base.schedule,legacy_job_id:null,legacy_hash:null});
    expect(await intents.retext(key,OLD,NEW)).toBe(false);
    await intents.phase(key,'active');
    expect(await intents.retext(key,OTHER_HASH,NEW)).toBe(false);
    expect(await intents.retext(key,OLD,NEW)).toBe(true);
    expect(await intents.find(key)).toMatchObject({desired_hash:NEW,phase:'active'});
    expect(await intents.retext(key,OLD,NEWER)).toBe(false);
  });
  it('admits a second business after the same generic was migrated for the first, without touching either prior job',async()=>{
    const test=setup();const legacy=test.native.legacy();
    await test.service.synchronize(test.input);
    const first=structuredClone(test.native.jobs),events=test.native.events.length;
    const report=await test.service.synchronize(otherInput(test));
    expect(report.active).toEqual([scopedJobName(base.name,OTHER)]);expect(report.preserved).toEqual([]);
    expect(test.native.created).toBe(2);expect(test.native.jobs.slice(0,2)).toEqual(first);
    const second=test.native.jobs.find(job=>job.name===scopedJobName(base.name,OTHER))!;
    expect(second.prompt).toContain(`business_id=${OTHER}`);expect(second.prompt).not.toContain(BUSINESS);
    expect(second.prompt).toContain('canonical_owner_session_id=fixture-other-session');
    expect(test.native.events.slice(events)).not.toContain('pause:'+legacy.id);
    expect(test.native.events.slice(events)).not.toContain('resume:'+legacy.id);
    expect(test.published.at(-1)).toEqual([expect.objectContaining({business_id:OTHER,session_id:'fixture-other-session'})]);
  });
  it('recovers only the unattempted second-business intent incorrectly preserved by an automatic legacy pause',async()=>{
    const test=setup();const legacy=test.native.legacy();await test.service.synchronize(test.input);
    const saved=await preserveOther(test);
    expect((await intents.find(saved))?.phase).toBe('preserved');
    const report=await new ManagedBusinessJobs(bundle,test.deps).synchronize(otherInput(test));
    expect(report.active).toEqual([scopedJobName(base.name,OTHER)]);
    expect(await intents.find(saved)).toMatchObject({phase:'active',reason:null,legacy_job_id:null,legacy_hash:null,legacy_pause_attempted:false});
    await test.service.synchronize(otherInput(test));expect(test.native.created).toBe(2);expect(legacy.enabled).toBe(false);
  });
  it.each([false,true])('does not mistake a retired and subsequently removed global job for a deletion by business B: saved=%s',async(saved)=>{
    const test=setup({deleted:true});const legacy=test.native.legacy();await test.service.synchronize(test.input);
    test.native.jobs=test.native.jobs.filter(job=>job.id!==legacy.id);
    const historical=saved?await preserveOther(test,'owner_deleted_legacy',null):null;
    const report=await test.service.synchronize(otherInput(test));
    if(historical){
      expect(report.pending).toEqual([{name:scopedJobName(base.name,OTHER),reason:'legacy_retirement_unverified'}]);
      expect((await intents.find(historical))?.phase).toBe('preserved');expect(test.native.created).toBe(1);
    }else{expect(report.active).toEqual([scopedJobName(base.name,OTHER)]);expect(test.native.created).toBe(2);}
    expect(test.native.jobs.every(job=>job.name!==base.name)).toBe(true);
  });
  it('waits while business A has retired the generic but has not completed admission, then admits B on retry',async()=>{
    const test=setup();test.native.legacy();
    const resume=test.native.resume.bind(test.native);
    let unblock!:()=>void,entered!:()=>void;
    const waiting=new Promise<void>(resolve=>{unblock=resolve;});const atAdmission=new Promise<void>(resolve=>{entered=resolve;});
    test.native.resume=async(nativeTarget,id)=>{entered();await waiting;return resume(nativeTarget,id);};
    const first=test.service.synchronize(test.input);
    await atAdmission;
    try{
      const report=await test.service.synchronize(otherInput(test));
      expect(report.pending).toEqual([{name:scopedJobName(base.name,OTHER),reason:'legacy_migration_pending'}]);
      expect(report.preserved).toEqual([]);expect(test.native.created).toBe(1);
      expect(await intents.find({owner_id:context.owner_id,business_id:OTHER,instance_generation:test.generation,base_name:base.name})).toBeNull();
    }finally{unblock();}
    await first;
    expect((await test.service.synchronize(otherInput(test))).active).toEqual([scopedJobName(base.name,OTHER)]);
  });
  it('never reopens a historical B pause that predates the service retirement',async()=>{
    const test=setup();const legacy=test.native.legacy({enabled:false,paused_at:'2001-01-01T00:00:00.000Z'});const saved=await preserveOther(test);
    legacy.enabled=true;legacy.paused_at=null;
    await test.service.synchronize(test.input);
    expect((await test.service.synchronize(otherInput(test))).preserved[0]?.reason).toBe('owner_paused_legacy');
    expect((await intents.find(saved))?.phase).toBe('preserved');expect(test.native.created).toBe(1);
  });
  it.each([undefined,null,'not-a-timestamp'] as const)('requires a valid native pause time for recovery: %s',async(paused)=>{
    const test=setup();const legacy=test.native.legacy();await test.service.synchronize(test.input);const saved=await preserveOther(test);
    legacy.paused_at=paused;
    const report=await test.service.synchronize(otherInput(test));
    expect(report.pending).toEqual([{name:scopedJobName(base.name,OTHER),reason:'legacy_retirement_unverified'}]);
    expect((await intents.find(saved))?.phase).toBe('preserved');expect(test.native.created).toBe(1);
  });
  it('concurrent retries of an incorrectly preserved B intent create at most one scoped job',async()=>{
    const test=setup();test.native.legacy();await test.service.synchronize(test.input);await preserveOther(test);
    await Promise.all([test.service.synchronize(otherInput(test)),new ManagedBusinessJobs(bundle,test.deps).synchronize(otherInput(test))]);
    const final=await test.service.synchronize(otherInput(test));
    expect(final.active).toEqual([scopedJobName(base.name,OTHER)]);
    expect(test.native.created).toBe(2);expect(test.native.jobs.filter(job=>job.name===scopedJobName(base.name,OTHER))).toHaveLength(1);
  });
  it('holds B prepared before the retirement rather than infer the cause of its prior pause',async()=>{
    const test=setup();const legacy=test.native.legacy();const saved=await preserveOther(test);await intents.phase(saved,'prepared');
    await test.service.synchronize(test.input);
    expect((await test.service.synchronize(otherInput(test))).preserved[0]?.reason).toBe('owner_paused_legacy');
    expect((await intents.find(saved))?.legacy_job_id).toBe(legacy.id);
    expect(test.native.jobs.find(job=>job.name===scopedJobName(base.name,OTHER))?.enabled).toBe(false);
    expect(test.native.events.filter(event=>event==='pause:'+legacy.id)).toHaveLength(1);
  });
  it.each(['paused','deleted','text','schedule','origin','delivery','unknown'] as const)('does not trust a donor scoped job that is %s',async(change)=>{
    const test=setup();const legacy=test.native.legacy();await test.service.synchronize(test.input);await preserveOther(test);
    const donor=test.native.jobs.find(job=>job.name===scopedJobName(base.name,BUSINESS))!;
    if(change==='paused'){donor.enabled=false;donor.paused_reason='Paused by owner.';}
    if(change==='deleted')test.native.jobs=test.native.jobs.filter(job=>job.id!==donor.id);
    if(change==='text')donor.prompt+=' Owner edit.';
    if(change==='schedule')donor.schedule='0 12 * * *';
    if(change==='origin')donor.origin={platform:'telegram',chatId:'owner'};
    if(change==='delivery')donor.deliver='all';
    if(change==='unknown')donor.enabled=null;
    const before=structuredClone(test.native.jobs);
    expect((await test.service.synchronize(otherInput(test))).preserved[0]?.reason).toBe('owner_paused_legacy');
    expect(test.native.created).toBe(1);expect(test.native.jobs).toEqual(before);expect(legacy.enabled).toBe(false);
  });
  it.each(['owner','generation','base','legacy-id','legacy-hash'] as const)('does not reuse migration evidence with another %s',async(change)=>{
    const test=setup();test.native.legacy();await test.service.synchronize(test.input);
    if(change==='owner')await pg.database.pool.query('UPDATE assistant.managed_job_intents SET owner_id=$2 WHERE instance_generation=$1',[test.generation,'different-owner']);
    if(change==='generation')await pg.database.pool.query('UPDATE assistant.managed_job_intents SET instance_generation=$2 WHERE instance_generation=$1',[test.generation,'different-generation']);
    if(change==='base')await pg.database.pool.query('UPDATE assistant.managed_job_intents SET base_name=$2 WHERE instance_generation=$1',[test.generation,'saleads:another-job']);
    if(change==='legacy-id')await pg.database.pool.query('UPDATE assistant.managed_job_intents SET legacy_job_id=$2 WHERE instance_generation=$1',[test.generation,'abcdef999999']);
    if(change==='legacy-hash')await pg.database.pool.query('UPDATE assistant.managed_job_intents SET legacy_hash=$2 WHERE instance_generation=$1',[test.generation,'0'.repeat(64)]);
    expect((await test.service.synchronize(otherInput(test))).preserved[0]?.reason).toBe('owner_paused_legacy');expect(test.native.created).toBe(1);
  });
  it.each(['pause-reason','resumed','text','origin','unknown','duplicate','replacement'] as const)('preserves a generic changed after automatic retirement: %s',async(change)=>{
    const test=setup();const legacy=test.native.legacy();await test.service.synchronize(test.input);
    if(change==='pause-reason')legacy.paused_reason='Paused by owner.';
    if(change==='resumed')legacy.enabled=true;
    if(change==='text')legacy.prompt+=' Owner edit.';
    if(change==='origin')legacy.origin={platform:'telegram',chatId:'owner'};
    if(change==='unknown')legacy.enabled=null;
    if(change==='duplicate')test.native.legacy({id:'abcdef000002',enabled:false});
    if(change==='replacement')legacy.id='abcdef000002';
    const before=structuredClone(test.native.jobs);const report=await test.service.synchronize(otherInput(test));
    expect(report.active).toEqual([]);expect(report.preserved).toHaveLength(1);expect(test.native.created).toBe(1);expect(test.native.jobs).toEqual(before);
  });
  it('does not reopen an already attempted or differently bound preserved B intent',async()=>{
    const test=setup();test.native.legacy();await test.service.synchronize(test.input);const saved=await preserveOther(test);
    await pg.database.pool.query('UPDATE assistant.managed_job_intents SET create_attempted=true WHERE instance_generation=$1 AND business_id=$2',[test.generation,OTHER]);
    expect((await test.service.synchronize(otherInput(test))).preserved[0]?.reason).toBe('owner_paused_legacy');
    expect((await intents.find(saved))?.phase).toBe('preserved');expect(test.native.created).toBe(1);
    const changed={...otherInput(test),context:{...otherInput(test).context,session_id:'changed-canonical'}};
    expect((await test.service.synchronize(changed)).preserved[0]?.reason).toBe('owner_paused_legacy');
    expect(test.native.created).toBe(1);
  });
  it('registers only the explicitly selected flow and uses runtime language, not a prompt literal',async()=>{
    const test=setup();await test.service.synchronize(test.input);
    const prompt=test.native.jobs[0]!.prompt;
    expect(prompt).toContain(`business_id=${BUSINESS}`);expect(prompt).not.toContain(OTHER);
    expect(prompt).toContain('current trusted response_locale');expect(prompt).not.toMatch(/response_locale=(?:pt|es|en)/);
    await test.service.synchronize({...test.input,context:{...context,response_locale:'es',locale_revision:2}});
    expect(test.native.jobs).toHaveLength(1);expect(test.native.jobs[0]?.prompt).toBe(prompt);
    expect(test.published.at(-1)?.[0]).toMatchObject({response_locale:'es',locale_revision:2});
  });
  it('never acts in classic mode or accepts a changed canonical session',async()=>{
    const classic=setup({managed:false});await expect(classic.service.synchronize(classic.input)).rejects.toThrow('managed_job_scope_required');expect(classic.native.events).toEqual([]);
    const test=setup();await test.service.synchronize(test.input);
    const changed=await test.service.synchronize({...test.input,context:{...context,session_id:'other-session'}});
    expect(changed.pending[0]?.reason).toBe('canonical_session_changed');expect(test.native.created).toBe(1);
  });
});

describe('exact pinned native cron HTTP adapter',()=>{
  it.each([
    ['saleads-sales-agent@1.5.11',true],['saleads-sales-agent@1.4.0',true],
    ['saleads-sales-agent@1.5.12',false],['saleads-sales-agent@1.5.13',false],
    ['saleads-sales-agent@1.10.0',false],['saleads-sales-agent@2.0.0',false],
    ['unrelated-bundle@1.5.11',false],['saleads-sales-agent@unknown',false],
  ] as const)('classifies generic-job creation history at the actual cutoff: %s', (version,expected)=>{
    expect(isLegacyGenericJobVersion(version)).toBe(expected);
  });
  it('uses the atomic paused flag and exact pause/resume paths, rejecting invalid IDs before I/O',async()=>{
    const calls:Array<{url:string;init?:RequestInit}>=[];
    const client=new NativeManagedJobsClient(async(input,init)=>{calls.push({url:String(input),init});return new Response('{}',{status:200});},8642);
    await client.createPaused(target,{...base,deliver:MANAGED_JOB_DELIVERY},1000);
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({paused:true,paused_reason:MANAGED_JOB_HOLD,deliver:MANAGED_JOB_DELIVERY});
    await client.pause(target,'abcdef123456',1000);await client.resume(target,'abcdef123456',1000);
    expect(calls.map(call=>new URL(call.url).pathname)).toEqual(['/api/jobs','/api/jobs/abcdef123456/pause','/api/jobs/abcdef123456/resume']);
    expect((await client.pause(target,'../foreign',1000)).kind).toBe('rejected');expect(calls).toHaveLength(3);
  });
  it('reads disabled jobs and preserves canonical native cron/interval schedules',async()=>{
    const job={id:'abcdef123456',name:base.name,prompt:base.prompt,skills:base.skills,enabled:false,state:'paused',paused_reason:MANAGED_JOB_HOLD,paused_at:'2027-01-02T03:04:05Z',deliver:MANAGED_JOB_DELIVERY,origin:{platform:'api_server',chat_id:'api'}};
    const client=new NativeManagedJobsClient(async()=>Response.json({jobs:[{...job,schedule:{kind:'cron',expr:'0 4 * * *'}},{...job,id:'abcdef123457',schedule:{kind:'interval',minutes:15}}]}),8642);
    const read=await client.list(target,1000);
    expect(read.kind).toBe('ok');if(read.kind!=='ok')throw new Error('fixture failed');
    expect(read.jobs.map(j=>j.schedule)).toEqual(['0 4 * * *','every 15m']);expect(read.jobs.every(j=>j.enabled===false)).toBe(true);expect(read.jobs.every(j=>j.paused_at==='2027-01-02T03:04:05Z')).toBe(true);
    expect(scopedJobPrompt(base,context)).toContain(base.prompt);
  });
});
