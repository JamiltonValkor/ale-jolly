import 'reflect-metadata';
import {Test} from '@nestjs/testing';
import request from 'supertest';
import {FirstLoopController} from '../src/first-loop/controller';
import {LanguagePreferences} from '../src/locale/preferences';
import {AuthGuard} from '../src/http/auth.guard';
import {AssistantFlagGuard} from '../src/http/assistant-flag.guard';
import {configureApp} from '../src/http/configure-app';
import {HttpHermesClient} from '../src/hermes/hermes-client';
import {startTestDatabase,type TestDatabase} from './support/pglite-db';
import {gzipSync} from 'node:zlib';import {randomBytes} from 'node:crypto';
import {FirstLoopService,type FirstLoopDeps} from '../src/first-loop/service';import {FirstLoopRepository} from '../src/first-loop/repository';import {FieldCipher} from '../src/security/field-cipher';
const owner='owner-test',business='11111111-1111-4111-8111-111111111111',client='22222222-2222-4222-8222-222222222222';
describe('first loop ownership and native acceptance',()=>{
 let pg:TestDatabase,repo:FirstLoopRepository,svc:FirstLoopService;let snapshot:Buffer|null=null;const runs={start:jest.fn(async(..._args:unknown[])=>({run_id:'run_test',status:'queued'})),status:jest.fn(async()=>'completed'),capabilities:jest.fn(async()=>({supported:true,durable:true,retention_seconds:86400}))};
 beforeAll(async()=>{pg=await startTestDatabase();const cipher=new FieldCipher(randomBytes(32));repo=new FirstLoopRepository(pg.database,cipher);const languages=new LanguagePreferences(pg.database);await languages.synchronize(owner,{language_code:'en',source_updated_at:'2026-10-31T10:00:00Z'});svc=new FirstLoopService({enabled:true,userId:owner},{repository:repo,languages,cipher,assistants:{findActive:async()=>({user_id:owner,status:'ready',ai_configured:true,private_ip:'10.0.0.1',instance_name:'own-vm',api_server_key_enc:cipher.seal('assistants.api_server_key_enc',owner,'fake-key')}) as never},hermes:{ensureSession:async()=>({kind:'ok'}),messages:async()=>({kind:'ok',messages:[]})} as never,runs,instances:{getInstance:async()=>({fingerprint:'f',items:[]}),setMetadata:async()=>{}} as never,storage:{signedPutUrl:async()=> 'https://storage.googleapis.com/test/object',download:async()=>snapshot,upload:async()=>{}},ownedBusinesses:async()=>new Set([business]),bootstrap:async()=>({business:{ready:true}})});});
 afterAll(async()=>pg.close());
 it('rejects another owner and foreign business without accepting runs',async()=>{await expect(svc.state('other',business,'en')).rejects.toMatchObject({code:'NOT_FOUND'});await expect(svc.state(owner,'33333333-3333-4333-8333-333333333333','en')).rejects.toMatchObject({code:'NOT_FOUND'});expect(runs.start).not.toHaveBeenCalled();});
 it('accepts one orientation then persists one owner message despite duplicate delivery',async()=>{const state=await svc.state(owner,business,'en');await svc.idle();const input={flow_id:state.flow_id,client_message_id:client,text:'Research my offering',response_locale:'en'};const a=await svc.message(owner,business,input);const b=await svc.message(owner,business,input);await svc.idle();expect(a.turn.client_message_id).toBe(b.turn.client_message_id);expect(runs.start).toHaveBeenCalledTimes(2);await expect(svc.message(owner,business,{...input,text:'different'})).rejects.toMatchObject({status:409});});
 it('rejects fabricated owner provenance and then accepts real quoted brief',async()=>{const f=(await repo.flow(owner,business))!;const b={flow_id:f.id,business_id:business,brief_revision:1,brief:{goal:'Research my offering',offering:null,market:null,constraints:[],owner_message_ids:[client],owner_quotes:[{client_message_id:client,quote:'fake statement'}]},missing_fields:[]};const make=()=>gzipSync(JSON.stringify({schema_version:'first-loop-projection/1',observed_at:new Date().toISOString(),generation:'a'.repeat(64),briefs:[b],works:[]}));snapshot=make();expect((await svc.state(owner,business,'en')).brief_revision).toBe(0);b.brief.owner_quotes[0]!.quote='Research my offering';snapshot=make();const s=await svc.state(owner,business,'en');expect(s.phase).toBe('confirm_brief');expect(s.brief_revision).toBe(1);});
 it('double kickoff and lost acknowledgement reuse the same work and native idempotency key',async()=>{const f=(await repo.flow(owner,business))!;const body={flow_id:f.id,brief_revision:1};const a=await svc.kickoff(owner,business,body,'request-key-1');const b=await svc.kickoff(owner,business,body,'request-key-1');await svc.idle();expect(a.work_id).toBe(b.work_id);expect(runs.start).toHaveBeenCalledTimes(3);const w=await svc.work(owner,business,a.work_id!);expect(w.status).toBe('unknown');expect(w.tasks).toEqual([]);await expect(svc.kickoff(owner,business,{...body,brief_revision:2},'request-key-1')).rejects.toMatchObject({status:409});});
 it('binds authentic feedback once and advances one revision without duplicate native work',async()=>{
  const f=(await repo.flow(owner,business))!;const w=(await repo.latestWork(owner,business))!;
  const stages=['research','strategy','structure'];const profiles=['investigador','estratega','estructurador'];
  const tasks=stages.map((stage,i)=>({id:'task-'+stage,profile:profiles[i],stage,revision:1,title:stage,status:'completed',native_status:'done',parents:i?['task-'+stages[i-1]]:[],run_refs:['native-'+stage],execution_verified:true,updated_at:new Date().toISOString()}));
  const artifacts=stages.map(stage=>({id:'a'.repeat(64),task_id:'task-'+stage,stage,revision:1,title:stage,content_type:'text/markdown',content:'Supported proposal',sha256:'b'.repeat(64),bytes:18,response_locale:'en',sources:[{title:'Source',url:'https://example.org/evidence'}]}));
  snapshot=gzipSync(JSON.stringify({schema_version:'first-loop-projection/1',observed_at:new Date().toISOString(),generation:'c'.repeat(64),briefs:[],works:[{work_id:w.id,business_id:business,tasks,artifacts}]}));
  expect((await svc.work(owner,business,w.id)).status).toBe('awaiting_feedback');
  const body={artifact_revision:1,client_message_id:'44444444-4444-4444-8444-444444444444',text:'Make the assumptions more conservative',response_locale:'en'};
  const a=await svc.feedback(owner,business,w.id,body,'feedback-key-1');const b=await svc.feedback(owner,business,w.id,body,'feedback-key-1');await svc.idle();expect(a.work_id).toBe(b.work_id);
  const updated=(await repo.work(owner,business,w.id))!;expect(updated.revision).toBe(2);expect(updated.feedback_count).toBe(1);
  expect((await repo.turns(f.id)).filter(t=>t.kind==='feedback')).toHaveLength(1);expect(runs.start).toHaveBeenCalledTimes(4);
 });


 it('binds an active-work followup to only the registered owner/business flow',async()=>{
  const f=(await repo.flow(owner,business))!;const w=(await repo.latestWork(owner,business))!;
  await svc.message(owner,business,{flow_id:f.id,client_message_id:'66666666-6666-4666-8666-666666666666',text:'Explain this proposal',response_locale:'en'});await svc.idle();
  const context=String(runs.start.mock.calls.at(-1)![3]);expect(context).toContain('work_id: '+w.id);expect(context).toContain('work_revision: '+w.revision);expect(context).toContain('business_id: '+business);
  const count=runs.start.mock.calls.length;await expect(svc.message(owner,'77777777-7777-4777-8777-777777777777',{flow_id:f.id,client_message_id:'88888888-8888-4888-8888-888888888888',text:'Other business',response_locale:'en'})).rejects.toMatchObject({code:'NOT_FOUND'});expect(runs.start).toHaveBeenCalledTimes(count);
 });
 it('recovers a lost native acceptance by replaying the same durable key after bounded backoff',async()=>{
  const f=(await repo.flow(owner,business))!;const keys:string[]=[];
  runs.start.mockImplementationOnce(async(...args:unknown[])=>{keys.push(String(args[4]));throw new Error('lost acknowledgment');}).mockImplementationOnce(async(...args:unknown[])=>{keys.push(String(args[4]));return {run_id:'run_original_native',status:'queued'};});
  const body={flow_id:f.id,client_message_id:'55555555-5555-4555-8555-555555555555',text:'Check my proposed research',response_locale:'en'};
  await svc.message(owner,business,body);await svc.idle();const failed=(await repo.turns(f.id)).find(t=>t.client_message_id===body.client_message_id)!;expect(failed.status).toBe('unknown');expect(failed.run_id).toBeNull();
  await svc.state(owner,business,'en');await svc.idle();expect(keys).toHaveLength(1);
  const deps=(svc as unknown as {deps:FirstLoopDeps}).deps;
  const recovered=new FirstLoopService({enabled:true,userId:owner},{...deps,now:()=>new Date(Date.now()+30000)});
  await recovered.state(owner,business,'en');await recovered.idle();
  const saved=(await repo.turns(f.id)).find(t=>t.client_message_id===body.client_message_id)!;expect(saved.run_id).toBe('run_original_native');expect(keys).toHaveLength(2);expect(new Set(keys).size).toBe(1);
 });

 it('serves real initial GET and reload when a bounded business bootstrap exceeds credential size',async()=>{
  const largeBusiness='99999999-9999-4999-8999-999999999999';
  const deps=(svc as unknown as {deps:FirstLoopDeps}).deps;
  const bootstrap={business:{name:'Synthetic business',offerings:[{description:'Documented business evidence. '.repeat(2000)}]}};
  const large=new FirstLoopService({enabled:true,userId:owner},{...deps,ownedBusinesses:async()=>new Set([largeBusiness]),bootstrap:async()=>bootstrap});
  const module=await Test.createTestingModule({controllers:[FirstLoopController],providers:[{provide:FirstLoopService,useValue:large}]}).overrideGuard(AuthGuard).useValue({canActivate:(context:{switchToHttp:()=>{getRequest:()=>{principal?:unknown}}})=>{context.switchToHttp().getRequest().principal={userId:owner};return true;}}).overrideGuard(AssistantFlagGuard).useValue({canActivate:()=>true}).compile();
  const app=configureApp(module.createNestApplication());await app.init();
  try{
   const path='/assistants/me/businesses/'+largeBusiness+'/first-loop?response_locale=en';
   const first=await request(app.getHttpServer()).get(path).expect(200);await large.idle();
   const turn=(await repo.turns(first.body.flow_id))[0]!;
   expect(Buffer.byteLength(JSON.stringify(repo.payload(turn)),'utf8')).toBeGreaterThan(32*1024);
   const reload=await request(app.getHttpServer()).get(path).expect(200);await large.idle();
   expect(reload.body.flow_id).toBe(first.body.flow_id);expect(await repo.turns(first.body.flow_id)).toHaveLength(1);
  }finally{await app.close();}
 });

 it('uses stable unique native titles for two business flows alongside the general SaleADS session',async()=>{
  const businesses=['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
  const sessions=new Map([['saleads-main','SaleADS']]);
  const titles=new Map([['SaleADS','saleads-main']]);
  const fetcher=jest.fn(async(input:string|URL,options?:RequestInit)=>{
   const url=String(input);
   if(options?.method==='POST'&&url.endsWith('/api/sessions')){
    const body=JSON.parse(String(options.body)) as {id:string;title:string};
    if(sessions.has(body.id))return new Response('{}',{status:409});
    if(titles.has(body.title))return new Response(JSON.stringify({error:{code:'invalid_title'}}),{status:400});
    sessions.set(body.id,body.title);titles.set(body.title,body.id);return new Response('{}',{status:201});
   }
   return new Response(JSON.stringify({data:[]}),{status:200});
  });
  const deps=(svc as unknown as {deps:FirstLoopDeps}).deps;
  const isolated=new FirstLoopService({enabled:true,userId:owner},{...deps,hermes:new HttpHermesClient(fetcher,8642),ownedBusinesses:async()=>new Set(businesses)});
  const created=[];
  for(const b of businesses){const state=await isolated.state(owner,b,'en');await isolated.idle();created.push(state);}
  for(const state of created){
   expect((await repo.turns(state.flow_id))[0]!.run_id).toBe('run_test');
   expect(sessions.get(state.session_id)).toBe('SaleADS first loop '+state.flow_id);
  }
  await isolated.state(owner,businesses[0]!,'en');await isolated.idle();
  expect(sessions.size).toBe(3);expect(titles.get('SaleADS')).toBe('saleads-main');
  expect(fetcher.mock.calls.filter(([url,options])=>options?.method==='POST'&&String(url).endsWith('/api/sessions'))).toHaveLength(2);
 });

 it('hides native Kanban notifications and assistant silence without dropping wrapped owner literals',async()=>{
  const b='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const deps=(svc as unknown as {deps:FirstLoopDeps}).deps;
  const ownerPrefix='CLIENT_MESSAGE_ID: '+client+'\nOWNER_MESSAGE_DATA:\n';
  const history=[
   {role:'user',content:'[kanban] Native task completed'},
   {role:'user',content:'  [kanban] Native task started'},
   {role:'assistant',content:'[SILENT]'},
   {role:'assistant',content:' \n[SILENT]\n'},
   {role:'user',content:ownerPrefix+'[kanban] literal owner text'},
   {role:'user',content:ownerPrefix+'[SILENT]'},
   {role:'user',content:ownerPrefix+'Keep the proposal conservative.\n\nSERVER_CONTEXT: authentic owner feedback'},
   {role:'assistant',content:'This explanation quotes [SILENT] as a literal.'},
   {role:'assistant',content:'The research is complete.'},
  ];
  const isolated=new FirstLoopService({enabled:true,userId:owner},{...deps,ownedBusinesses:async()=>new Set([b]),hermes:{...deps.hermes,ensureSession:async()=>({kind:'ok'}),messages:async()=>({kind:'ok',messages:history})} as never});
  const state=await isolated.state(owner,b,'en');await isolated.idle();
  expect(state.messages.map(m=>({role:m.role,text:m.text}))).toEqual([
   {role:'user',text:'[kanban] literal owner text'},
   {role:'user',text:'[SILENT]'},
   {role:'user',text:'Keep the proposal conservative.'},
   {role:'assistant',text:'This explanation quotes [SILENT] as a literal.'},
   {role:'assistant',text:'The research is complete.'},
  ]);
 });

 it('binds real feedback to an adopted revision two and advances once to revision three',async()=>{
  const b='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const deps=(svc as unknown as {deps:FirstLoopDeps}).deps;
  const isolated=new FirstLoopService({enabled:true,userId:owner},{...deps,ownedBusinesses:async()=>new Set([b])});
  const flow=await repo.ensureFlow(owner,b,'en');
  await repo.saveBrief(flow,2,{goal:'Synthetic proposal',offering:null,market:null,constraints:[],owner_message_ids:[client],owner_quotes:[{client_message_id:client,quote:'Synthetic proposal'}]},[]);
  const original=(await repo.createWork((await repo.flow(owner,b))!))!;
  expect(original.revision).toBe(1);
  // Synthetic fixture for the separately guarded operator metadata adoption.
  await pg.database.pool.query('UPDATE assistant.first_loop_works SET revision=2 WHERE id=$1',[original.id]);
  const adopted=(await repo.work(owner,b,original.id))!;
  const stages=['research','strategy','structure'],profiles=['investigador','estratega','estructurador'];
  const tasks=stages.map((stage,i)=>({id:'adopted-'+stage,profile:profiles[i],stage,revision:2,title:stage,status:'completed',native_status:'done',parents:i?['adopted-'+stages[i-1]]:[],run_refs:[String(i+1)],execution_verified:true,updated_at:null}));
  const artifacts=stages.map(stage=>({id:'a'.repeat(64),task_id:'adopted-'+stage,stage,revision:2,title:stage,content_type:'text/markdown',content:'Supported proposal',sha256:'b'.repeat(64),bytes:18,response_locale:'en',sources:[{title:'Source',url:'https://example.org/evidence'}]}));
  await repo.saveProjection(adopted,'a'.repeat(64),new Date(),{observed_at:new Date().toISOString(),generation:'a'.repeat(64),tasks,artifacts});
  const body={artifact_revision:2,client_message_id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',text:'Keep the supported constraints',response_locale:'en'};
  const count=runs.start.mock.calls.length;
  await isolated.feedback(owner,b,adopted.id,body,'adopted-feedback-key');await isolated.idle();
  await isolated.feedback(owner,b,adopted.id,body,'adopted-feedback-key');await isolated.idle();
  const saved=(await repo.work(owner,b,adopted.id))!;
  expect(saved.revision).toBe(3);expect(saved.feedback_count).toBe(1);expect(runs.start.mock.calls).toHaveLength(count+1);
  const context=String(runs.start.mock.calls.at(-1)![3]);expect(context).toContain('work_revision: 3');expect(context).toContain('brief_revision: 2');
  await expect(isolated.feedback(owner,b,adopted.id,{...body,artifact_revision:1,client_message_id:'ffffffff-ffff-4fff-8fff-ffffffffffff'},'stale-adopted-feedback-key')).rejects.toMatchObject({status:409});
  expect((await repo.work(owner,b,adopted.id))!.revision).toBe(3);
 });

 it('queries an exact acceptance receipt without dispatch, and rejects foreign or missing receipts',async()=>{
  const before=runs.start.mock.calls.length;
  const receipt=await svc.messageReceipt(owner,business,client);
  expect(receipt.turn.client_message_id).toBe(client);
  await expect(svc.messageReceipt('other',business,client)).rejects.toMatchObject({code:'NOT_FOUND'});
  await expect(svc.messageReceipt(owner,business,'12345678-1234-4234-8234-123456789012')).rejects.toMatchObject({code:'NOT_FOUND'});
  await svc.idle();expect(runs.start.mock.calls.length).toBe(before);
 });
 it('starts contextual guided onboarding on open, without an owner command, and preserves the existing flow on reload',async()=>{
  const deps=(svc as unknown as {deps:FirstLoopDeps}).deps;
  const before=runs.start.mock.calls.length;const flow=(await repo.flow(owner,business))!;const previous=await repo.turns(flow.id);
  const guided=new FirstLoopService({enabled:true,userId:owner,continuousLearning:true},{...deps,bootstrap:async()=>({business:{name:'Synthetic beauty business',offerings:[{name:'Documented offering'}]}})});
  const first=await guided.state(owner,business);await guided.idle();
  expect(first.flow_id).toBe(flow.id);expect(runs.start.mock.calls).toHaveLength(before+1);
  const call=runs.start.mock.calls.at(-1)!;
  expect(String(call[2])).toContain('FIRST_USE_ORIENTATION');expect(String(call[2])).toContain('Synthetic beauty business');
  expect(String(call[3])).toContain('assistant_proposed');expect(String(call[3])).not.toContain('Only a confirmed kickoff authorizes');
  expect(String(call[3])).toContain('Take initiative and guide the owner');
  const after=await repo.turns(flow.id);expect(after).toHaveLength(previous.length+1);
  expect(repo.payload(after.at(-1)!).owner_text).toBeUndefined();
  await guided.state(owner,business);await guided.idle();expect(runs.start.mock.calls).toHaveLength(before+1);
 });

 it('persists the current-state rule for Meta orientation and ordinary messages and forwards that exact payload once',async()=>{
  const b='10101010-1010-4010-8010-101010101010';
  const deps=(svc as unknown as {deps:FirstLoopDeps}).deps;
  let nativeCount=0;
  const native={...runs,start:jest.fn(async(_target:unknown,_session:string,_text:string,_instructions:string,_key:string)=>({run_id:'meta-current-state-'+(++nativeCount),status:'queued'}))};
  const meta=new FirstLoopService({enabled:true,userId:owner,continuousLearning:true},{...deps,runs:native,ownedBusinesses:async()=>new Set([b])});
  const state=await meta.state(owner,b);await meta.idle();
  const orientation=(await repo.turns(state.flow_id))[0]!;
  const orientationPayload=repo.payload(orientation);
  expect(orientationPayload.instructions).toContain('SALEADS_MUTABLE_STATE_FRESHNESS_POLICY_V1');
  expect(native.start.mock.calls[0]![3]).toBe(orientationPayload.instructions);
  const input={flow_id:state.flow_id,client_message_id:'20202020-2020-4020-8020-202020202020',text:'What is the next step for the existing landing?',response_locale:'en'};
  await meta.message(owner,b,input);await meta.idle();
  const accepted=(await repo.turn(state.flow_id,input.client_message_id))!;
  const payload=repo.payload(accepted);
  expect(payload.owner_text).toBe(input.text);
  expect(payload.instructions).toContain('SALEADS_MUTABLE_STATE_FRESHNESS_POLICY_V1');
  expect(payload.instructions).toMatch(/checkpoints, not authoritative current commercial state/);
  expect(payload.instructions).toMatch(/already available authorized SaleADS MCP\/CLI read/);
  expect(payload.instructions).toMatch(/read is unavailable or fails, state what remains unverified/);
  expect(native.start.mock.calls[1]!.slice(2,4)).toEqual([payload.text,payload.instructions]);
  await meta.message(owner,b,input);await meta.messageReceipt(owner,b,input.client_message_id);await meta.idle();
  const replayed=(await repo.turn(state.flow_id,input.client_message_id))!;
  expect(replayed.id).toBe(accepted.id);expect(replayed.run_id).toBe(accepted.run_id);
  expect(replayed.payload_enc).toEqual(accepted.payload_enc);expect(repo.payload(replayed)).toEqual(payload);
  expect(native.start).toHaveBeenCalledTimes(2); // One orientation plus one ordinary message.
 });

 it('keeps the classic payload and its accepted replay unchanged when the same flow later uses Meta',async()=>{
  const b='30303030-3030-4030-8030-303030303030';
  const deps=(svc as unknown as {deps:FirstLoopDeps}).deps;
  const native={...runs,start:jest.fn(async(_target:unknown,_session:string,_text:string,_instructions:string,_key:string)=>({run_id:'classic-accepted',status:'queued'}))};
  const dependencies={...deps,runs:native,ownedBusinesses:async()=>new Set([b])};
  const classic=new FirstLoopService({enabled:true,userId:owner},dependencies);
  const flow=await repo.ensureFlow(owner,b,'en');
  const input={flow_id:flow.id,client_message_id:'40404040-4040-4040-8040-404040404040',text:'Review the existing proposal.',response_locale:'en'};
  await classic.message(owner,b,input);await classic.idle();
  const accepted=(await repo.turn(flow.id,input.client_message_id))!;
  const payload=repo.payload(accepted);
  expect(payload.instructions).toContain('SALEADS_FIRST_LOOP_CONTEXT_V1');
  expect(payload.instructions).not.toContain('SALEADS_MUTABLE_STATE_FRESHNESS_POLICY_V1');
  expect(native.start.mock.calls[0]!.slice(2,4)).toEqual([payload.text,payload.instructions]);
  const meta=new FirstLoopService({enabled:true,userId:owner,continuousLearning:true},dependencies);
  await meta.message(owner,b,input);await meta.idle();
  const replayed=(await repo.turn(flow.id,input.client_message_id))!;
  expect(replayed.payload_enc).toEqual(accepted.payload_enc);expect(repo.payload(replayed)).toEqual(payload);
  expect(replayed.run_id).toBe('classic-accepted');expect(native.start).toHaveBeenCalledTimes(1);
 });

 it('recovers lost Meta acceptance with frozen instructions and the same key without a second native effect',async()=>{
  const b='50505050-5050-4050-8050-505050505050';
  const deps=(svc as unknown as {deps:FirstLoopDeps}).deps;
  const effects=new Map<string,{text:string;instructions:string}>();
  const native={...runs,start:jest.fn(async(_target:unknown,_session:string,text:string,instructions:string,key:string)=>{
   if(!effects.has(key)){effects.set(key,{text,instructions});throw new Error('Accepted but acknowledgement lost');}
   expect({text,instructions}).toEqual(effects.get(key));
   return {run_id:'meta-original-native-effect',status:'queued'};
  })};
  const now=new Date();const dependencies={...deps,runs:native,ownedBusinesses:async()=>new Set([b])};
  const meta=new FirstLoopService({enabled:true,userId:owner,continuousLearning:true},{...dependencies,now:()=>now});
  const flow=await repo.ensureFlow(owner,b,'en');
  const input={flow_id:flow.id,client_message_id:'60606060-6060-4060-8060-606060606060',text:'What should happen next?',response_locale:'en'};
  await meta.message(owner,b,input);await meta.idle();
  const accepted=(await repo.turn(flow.id,input.client_message_id))!;
  const payload=repo.payload(accepted);
  expect(accepted.status).toBe('unknown');expect(accepted.run_id).toBeNull();
  expect(payload.instructions).toContain('SALEADS_MUTABLE_STATE_FRESHNESS_POLICY_V1');
  await meta.message(owner,b,input);await meta.idle();expect(native.start).toHaveBeenCalledTimes(1);
  const recovered=new FirstLoopService({enabled:true,userId:owner,continuousLearning:true},{...dependencies,now:()=>new Date(now.getTime()+30000)});
  await recovered.message(owner,b,input);await recovered.idle();
  const replayed=(await repo.turn(flow.id,input.client_message_id))!;
  expect(replayed.run_id).toBe('meta-original-native-effect');
  expect(replayed.payload_enc).toEqual(accepted.payload_enc);expect(repo.payload(replayed)).toEqual(payload);
  expect(native.start).toHaveBeenCalledTimes(2);expect(effects.size).toBe(1);
  expect(new Set(native.start.mock.calls.map(call=>call[4])).size).toBe(1);
 });

 it('reserves one durable Meta turn when its retry overtakes the original before reservation',async()=>{
  const b='70707070-7070-4070-8070-707070707070';
  const deps=(svc as unknown as {deps:FirstLoopDeps}).deps;
  let originalAtReservation!:()=>void,releaseOriginal!:()=>void;
  const originalWaiting=new Promise<void>(resolve=>{originalAtReservation=resolve;});
  const originalGate=new Promise<void>(resolve=>{releaseOriginal=resolve;});
  let nativeStarted!:()=>void,releaseNative!:()=>void;
  const nativeWaiting=new Promise<void>(resolve=>{nativeStarted=resolve;});
  const nativeGate=new Promise<void>(resolve=>{releaseNative=resolve;});
  const native={...runs,start:jest.fn(async(_target:unknown,_session:string,_text:string,_instructions:string,_key:string)=>{
   nativeStarted();await nativeGate;
   return {run_id:'run_'+'b'.repeat(32),status:'queued'};
  })};
  const dependencies={...deps,runs:native,ownedBusinesses:async()=>new Set([b])};
  // Separate service instances have separate in-memory locks, as after an HTTP retry reaches another pod.
  const originalService=new FirstLoopService({enabled:true,userId:owner,continuousLearning:true},dependencies);
  const retryService=new FirstLoopService({enabled:true,userId:owner,continuousLearning:true},dependencies);
  const flow=await repo.ensureFlow(owner,b,'en');
  const input={flow_id:flow.id,client_message_id:'80808080-8080-4080-8080-808080808080',text:'Review the next step without changing my proposal.',response_locale:'en'};
  const realReserve=repo.reserveTurn.bind(repo);
  const reservation=jest.spyOn(repo,'reserveTurn').mockImplementationOnce(async(...args)=>{
   originalAtReservation();await originalGate;
   return realReserve(...args);
  });
  const original=originalService.message(owner,b,input);
  try{
   await originalWaiting;
   // An authenticated 404 can race with a still-live original; it is not proof the POST cannot arrive.
   await expect(retryService.messageReceipt(owner,b,input.client_message_id)).rejects.toMatchObject({code:'NOT_FOUND'});
   const retried=await retryService.message(owner,b,input);
   await nativeWaiting;
   const reserved=(await repo.turn(flow.id,input.client_message_id))!;
   const frozen=repo.payload(reserved);
   expect(reserved.dispatch_attempts).toBe(1);
   releaseOriginal();
   const late=await original;await originalService.idle();
   expect(late.turn.client_message_id).toBe(retried.turn.client_message_id);
   expect(late.flow_id).toBe(retried.flow_id);
   releaseNative();await retryService.idle();
   const turns=await repo.turns(flow.id);
   expect(turns).toHaveLength(1);
   expect(turns[0]!.id).toBe(reserved.id);
   expect(turns[0]!.run_id).toBe('run_'+'b'.repeat(32));
   expect(turns[0]!.dispatch_attempts).toBe(1);
   expect(turns[0]!.payload_enc).toEqual(reserved.payload_enc);
   expect(repo.payload(turns[0]!)).toEqual(frozen);
   expect(frozen.owner_text).toBe(input.text);
   expect(native.start).toHaveBeenCalledTimes(1);
   expect(native.start.mock.calls[0]!.slice(1)).toEqual([flow.session_id,frozen.text,frozen.instructions,'first-loop-'+reserved.id]);
  }finally{
   releaseOriginal();releaseNative();
   await original;await Promise.all([originalService.idle(),retryService.idle()]);
   reservation.mockRestore();
  }
 });
});
