import {randomBytes,randomUUID} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {FirstLoopService} from '../src/first-loop/service';
import {FirstLoopRepository,type FlowRow,type TurnRow} from '../src/first-loop/repository';
import {NativeTurnRecovery,nativeApiScopeSha256,nativeReceiptConsumer,nativeTurnTextSha256,nativeRequestFingerprint,type NativeRunReceiptV1} from '../src/first-loop/native-recovery';
import {LanguagePreferences} from '../src/locale/preferences';
import {NotificationProjection} from '../src/notifications/projection';
import {NotificationRepository} from '../src/notifications/repository';
import type {AssistantRow} from '../src/persistence/assistant-repository';
import {FieldCipher} from '../src/security/field-cipher';
import {startTestDatabase,type TestDatabase} from './support/pglite-db';

const OWNER='service-recovery-fixture',KEY='synthetic-state-native-key',RUN='run_'+'a'.repeat(32);
describe('continuous state dispatcher and private run projection integration',()=>{
 let pg:TestDatabase,repository:FirstLoopRepository,cipher:FieldCipher,languages:LanguagePreferences,notices:NotificationRepository;
 beforeAll(async()=>{pg=await startTestDatabase();cipher=new FieldCipher(randomBytes(32));repository=new FirstLoopRepository(pg.database,cipher);languages=new LanguagePreferences(pg.database);notices=new NotificationRepository(pg.database,cipher);
  await languages.synchronize(OWNER,{language_code:'en',source_updated_at:'2026-10-27T10:00:00Z'});
 });
 afterAll(async()=>pg.close());
 function fixture(){
  const business=randomUUID();let clock=new Date(),feed:Buffer|null=null;
  const events:string[]=[];
  const row={user_id:OWNER,status:'ready',ai_configured:true,private_ip:'10.0.0.1',instance_name:'fixture-vm',api_server_key_enc:cipher.seal('assistants.api_server_key_enc',OWNER,KEY)} as AssistantRow;
  const storage={signedPutUrl:jest.fn(async()=> 'https://storage.googleapis.com/fixture/object'),upload:async()=>{},download:jest.fn(async(object:string)=>object.startsWith('continuous-uploads/')?feed:null)};
  const instances={getInstance:jest.fn(async()=>({fingerprint:'f',items:[]})),setMetadata:jest.fn(async()=>{})};
  const recovery=new NativeTurnRecovery(repository,()=>clock);
  const projection=new NotificationProjection(notices,storage,instances as never,()=>clock,nativeReceiptConsumer(repository,recovery,cipher));
  const runs={capabilities:jest.fn(async()=>{events.push('capabilities-GET');return {supported:true,durable:true,retention_seconds:86400};}),
   start:jest.fn(async(..._args:unknown[])=>{events.push('run-POST');return {run_id:RUN,status:'queued'};}),status:jest.fn(async()=> 'running')};
  const hermes={ensureSession:jest.fn(async()=>{events.push('session-POST');return {kind:'ok' as const};}),messages:jest.fn(async()=>({kind:'ok' as const,messages:[]})),openStream:jest.fn(async()=>{throw new Error('streaming is not used by native run recovery');})};
  const service=new FirstLoopService({enabled:true,userId:OWNER,continuousLearning:true},{repository,languages,cipher,assistants:{findActive:async()=>row},hermes,runs,instances:instances as never,storage,
   ownedBusinesses:async()=>new Set([business]),bootstrap:async()=>({business:{name:'Synthetic documented business'}}),now:()=>clock,
   refreshNativeReceipts:async()=>{events.push('private-feed-GET');await projection.refreshNativeReceipts(row);},
   notifications:(r,b,s)=>projection.messages(r,b,s),
  });
  return {business,row,events,runs,hermes,service,projection,instances,storage,recovery,
   advance:(milliseconds:number)=>{clock=new Date(clock.getTime()+milliseconds);},clock:()=>clock,
   setFeed:(receipts:unknown[],notifications:unknown[]=[],owner=OWNER)=>{feed=gzipSync(JSON.stringify({schema_version:'native-notifications/1',owner_id:owner,observed_at:clock.toISOString(),notifications,run_receipts:receipts}));},
   setLegacyFeed:()=>{feed=gzipSync(JSON.stringify({schema_version:'native-notifications/1',owner_id:OWNER,observed_at:clock.toISOString(),notifications:[]}));},
  };
 }
 async function current(test:ReturnType<typeof fixture>):Promise<{flow:FlowRow;turn:TurnRow}>{const flow=(await repository.flow(OWNER,test.business))!;const turn=(await repository.turns(flow.id)).at(-1)!;return {flow,turn};}
 function proof(flow:FlowRow,turn:TurnRow,at:Date,patch:Partial<NativeRunReceiptV1>={}):NativeRunReceiptV1{return {
  schema_version:'native-run-receipt/1',owner_id:OWNER,business_id:flow.business_id,session_id:flow.session_id,turn_id:turn.id,idempotency_key:'first-loop-'+turn.id,run_id:RUN,
  request_text_sha256:nativeTurnTextSha256(repository.payload(turn).text),native_scope_sha256:nativeApiScopeSha256(KEY),native_request_fingerprint:nativeRequestFingerprint(flow.session_id,repository.payload(turn).text,repository.payload(turn).instructions),
  accepted_at:at.toISOString(),native_created_at:at.toISOString(),native_updated_at:at.toISOString(),status_observed_at:at.toISOString(),native_status:'completed',terminal_proven:true,native_record_present:false,proof_gap:null,...patch,
 };}
 it('opens without an owner command and automatically retries >4 lost ACKs using the exact same frozen request/key',async()=>{
  const test=fixture();let failures=6;
  test.runs.start.mockImplementation(async(..._args:unknown[])=>{test.events.push('run-POST');if(failures-->0)throw new Error('controlled lost acknowledgement');return {run_id:RUN,status:'queued'};});
  await test.service.state(OWNER,test.business);await test.service.idle();
  for(let n=0;n<6;n++){test.advance(310000);await test.service.state(OWNER,test.business);await test.service.idle();}
  const {turn}=await current(test);
  expect(turn.dispatch_attempts).toBe(7);expect(turn.run_id).toBe(RUN);expect(test.runs.start).toHaveBeenCalledTimes(7);
  expect(new Set(test.runs.start.mock.calls.map(args=>JSON.stringify(args)))).toHaveProperty('size',1);
  expect(test.events.indexOf('private-feed-GET')).toBeLessThan(test.events.indexOf('capabilities-GET'));
  expect(test.events.indexOf('capabilities-GET')).toBeLessThan(test.events.indexOf('run-POST'));
 });
 it('consumes positive private admission/terminal proof before any retry POST and exposes recovered state automatically',async()=>{
  const test=fixture();test.runs.start.mockRejectedValue(new Error('controlled lost acknowledgement'));
  await test.service.state(OWNER,test.business);await test.service.idle();
  const {flow,turn}=await current(test);test.advance(310000);test.setFeed([proof(flow,turn,test.clock())]);
  const state=await test.service.state(OWNER,test.business);await test.service.idle();
  expect(test.runs.start).toHaveBeenCalledTimes(1);expect(state.latest_turn).toMatchObject({run_id:RUN,status:'completed'});
  expect((await repository.recoveryTurn(flow,turn.id))!.native_fingerprint).toBe(proof(flow,turn,test.clock()).native_request_fingerprint);
 });
 it('recovers an expired turn through read-only receipt lookup without model or VM metadata POST',async()=>{
  const test=fixture();test.runs.start.mockRejectedValue(new Error('controlled lost acknowledgement'));
  await test.service.state(OWNER,test.business);await test.service.idle();const {flow,turn}=await current(test);
  test.advance(25*60*60*1000);test.setFeed([proof(flow,turn,test.clock())]);const before=test.instances.setMetadata.mock.calls.length;
  const receipt=await test.service.messageReceipt(OWNER,test.business,turn.client_message_id);
  expect(receipt.turn).toMatchObject({run_id:RUN,status:'completed'});expect(test.runs.start).toHaveBeenCalledTimes(1);
  expect(test.instances.setMetadata.mock.calls.length).toBe(before);
 });
 it('beyond the replay horizon state polling performs no session/run POST and never fails the unknown turn from age',async()=>{
  const test=fixture();test.runs.start.mockRejectedValue(new Error('controlled lost acknowledgement'));
  await test.service.state(OWNER,test.business);await test.service.idle();const {flow,turn}=await current(test);
  test.advance(25*60*60*1000);await test.service.state(OWNER,test.business);await test.service.idle();
  expect(test.runs.start).toHaveBeenCalledTimes(1);expect(test.hermes.ensureSession).toHaveBeenCalledTimes(1);
  expect((await repository.recoveryTurn(flow,turn.id))!.status).toBe('unknown');
 });
 it('does not dispatch without real durable capability, then starts the same reserved orientation when capability becomes available',async()=>{
  const test=fixture();test.runs.capabilities.mockImplementationOnce(async()=>{throw new Error('controlled unavailable capabilities');});
  await test.service.state(OWNER,test.business);await test.service.idle();const first=await current(test);
  expect(test.runs.start).not.toHaveBeenCalled();expect(first.turn.dispatch_attempts).toBe(0);
  await test.service.state(OWNER,test.business);await test.service.idle();const second=await current(test);
  expect(second.turn.id).toBe(first.turn.id);expect(test.runs.start).toHaveBeenCalledTimes(1);
 });
 it('accepts legacy projection envelopes and ignores malformed/cross-owner receipt entries without contaminating the turn',async()=>{
  const test=fixture();test.runs.start.mockRejectedValue(new Error('controlled lost acknowledgement'));
  await test.service.state(OWNER,test.business);await test.service.idle();const {flow,turn}=await current(test);
  test.setLegacyFeed();await expect(test.projection.refreshNativeReceipts(test.row)).resolves.toBeUndefined();
  test.setFeed([{schema_version:'unsupported'},proof(flow,turn,test.clock(),{owner_id:'other-owner'}),proof(flow,turn,test.clock(),{business_id:randomUUID()})]);
  await test.projection.refreshNativeReceipts(test.row);
  expect((await repository.recoveryTurn(flow,turn.id))!.run_id).toBeNull();
  test.setFeed([proof(flow,turn,test.clock())],[],'other-owner');
  await expect(test.projection.refreshNativeReceipts(test.row)).rejects.toThrow('invalid_native_projection');
  expect((await repository.recoveryTurn(flow,turn.id))!.run_id).toBeNull();
 });
 it('keeps ordinary no-home delivery working when an unrelated native receipt is invalid',async()=>{
  const test=fixture();await test.service.state(OWNER,test.business);await test.service.idle();const {flow}=await current(test);
  const job='job-'+randomUUID();await notices.bindJob({owner_id:OWNER,business_id:test.business,session_id:flow.session_id,job_id:job,response_locale:'en',locale_revision:1});
  test.setFeed([{invalid:'receipt'}],[{job_id:job,execution_id:'fixture-execution',source_version:'1',response_locale:'en',locale_revision:1,text:'The documented research is ready.',terminal_state:'completed',limitations:[],finished_at:test.clock().toISOString(),delivery:{state:'no_home',evidence_ref:'fixture',reconcile_by:null}}]);
  const messages=await test.projection.messages(test.row,test.business,flow.session_id);
  expect(messages).toHaveLength(1);expect(messages[0]?.text).toBe('The documented research is ready.');
  expect(test.storage.download.mock.calls.every(args=>args[0].startsWith('continuous-uploads/'+OWNER+'/')||args[0].startsWith('first-loop-uploads/'+OWNER+'/'))).toBe(true);
 });
 it('preserves no-home notifications but refuses to retry from an oversized recovery feed',async()=>{
  const test=fixture();test.runs.start.mockRejectedValue(new Error('controlled lost acknowledgement'));
  await test.service.state(OWNER,test.business);await test.service.idle();const {flow}=await current(test);
  const job='job-'+randomUUID();await notices.bindJob({owner_id:OWNER,business_id:test.business,session_id:flow.session_id,job_id:job,response_locale:'en',locale_revision:1});
  test.advance(310000);
  test.setFeed(Array.from({length:2001},()=>({invalid:'oversized fixture'})),[{job_id:job,execution_id:'bounded-feed-execution',source_version:'1',response_locale:'en',locale_revision:1,text:'The bounded research result is ready.',terminal_state:'completed',limitations:[],finished_at:test.clock().toISOString(),delivery:{state:'no_home',evidence_ref:'fixture',reconcile_by:null}}]);
  await expect(test.projection.refreshNativeReceipts(test.row)).rejects.toThrow('incomplete_native_run_receipts');
  const state=await test.service.state(OWNER,test.business);await test.service.idle();
  expect(test.runs.start).toHaveBeenCalledTimes(1);
  expect(state.messages.some(message=>message.text==='The bounded research result is ready.')).toBe(true);
 });
});
