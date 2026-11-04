import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {FirstLoopService} from '../src/first-loop/service';
import {FirstLoopRepository} from '../src/first-loop/repository';
import {ownerMessage} from '../src/first-loop/owner-envelope';
import {LanguagePreferences} from '../src/locale/preferences';
import type {AssistantRow} from '../src/persistence/assistant-repository';
import {FieldCipher} from '../src/security/field-cipher';
import {startTestDatabase,type TestDatabase} from './support/pglite-db';

const OWNER='guided-first-use-fixture',KEY='synthetic-native-key';
// Existing V2 identity is a migration fixture. The new V3 identity is not
// recomputed here: its stable behavior is observed through persisted turns.
function priorOrientationId(flow:string):string{
 const h=createHash('sha256').update(JSON.stringify('guided-first-use-v2:'+flow)).digest('hex');
 return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
describe('guided first-use V3 admission',()=>{
 let pg:TestDatabase,repository:FirstLoopRepository,cipher:FieldCipher,languages:LanguagePreferences;
 beforeAll(async()=>{
  pg=await startTestDatabase();cipher=new FieldCipher(randomBytes(32));repository=new FirstLoopRepository(pg.database,cipher);languages=new LanguagePreferences(pg.database);
  await languages.synchronize(OWNER,{language_code:'es',source_updated_at:'2026-10-27T10:00:00Z'});
 });
 afterAll(async()=>pg.close());
 function fixture(){
  const business=randomUUID(),nativeRun='run_'+randomUUID().replaceAll('-','');
  const row={user_id:OWNER,status:'ready',ai_configured:true,private_ip:'10.0.0.1',instance_name:'synthetic-vm',api_server_key_enc:cipher.seal('assistants.api_server_key_enc',OWNER,KEY)} as AssistantRow;
  let history:Array<{id:number;role:string;content:string}>=[];
  const runs={start:jest.fn(async(..._args:unknown[])=>({run_id:nativeRun,status:'queued'})),status:jest.fn(async()=> 'completed'),capabilities:jest.fn(async()=>({supported:true,durable:true,retention_seconds:86400}))};
  const deps={repository,languages,cipher,assistants:{findActive:async()=>row},runs,
   hermes:{ensureSession:jest.fn(async()=>({kind:'ok' as const})),messages:jest.fn(async()=>({kind:'ok' as const,messages:history})),openStream:jest.fn(async()=>{throw new Error('no streaming in admission fixture');})},
   instances:{getInstance:async()=>({fingerprint:'f',items:[]}),setMetadata:async()=>{}},
   storage:{signedPutUrl:async()=> 'https://storage.googleapis.com/synthetic/object',download:async()=>null,upload:async()=>{}},
   ownedBusinesses:async()=>new Set([business]),bootstrap:async()=>({business:{name:'Synthetic documented business',offering:'Registered kit'}}),
  };
  const service=()=>new FirstLoopService({enabled:true,userId:OWNER,continuousLearning:true},{...deps,instances:deps.instances as never});
  return {business,runs,service,history:(value:typeof history)=>{history=value;}};
 }
 it('upgrades V2 once without an owner command, preserves the later owner mandate/history and requires immediate bounded discovery',async()=>{
  const test=fixture(),flow=await repository.ensureFlow(OWNER,test.business,'es');
  const v2=await repository.reserveTurn(flow,priorOrientationId(flow.id),'message','a'.repeat(64),{text:'FIRST_USE_ORIENTATION prior V2 service request',instructions:'Previous policy'},null);
  await repository.setRun(v2.id,'run_'+'2'.repeat(32),'completed');
  const client=randomUUID(),quote='Keep my confirmed objective and limits; do not create campaigns.';
  const owner=await repository.reserveTurn(flow,client,'message','b'.repeat(64),{text:ownerMessage(client,quote),instructions:'Existing trusted policy',owner_text:quote},null);
  await repository.setRun(owner.id,'run_'+'4'.repeat(32),'completed');
  const original=await repository.turns(flow.id);
  test.history([{id:1,role:'user',content:repository.payload(v2).text},{id:2,role:'assistant',content:'Your previous proposal is retained.'},{id:3,role:'user',content:ownerMessage(client,quote)}]);
  const guided=test.service(),state=await guided.state(OWNER,test.business);await guided.idle();
  expect(state.flow_id).toBe(flow.id);expect(state.response_locale).toBe('es');expect(test.runs.start).toHaveBeenCalledTimes(1);
  const turns=await repository.turns(flow.id),added=turns.find(turn=>!original.some(old=>old.id===turn.id))!;
  expect(turns).toHaveLength(original.length+1);expect(added.client_message_id).not.toBe(v2.client_message_id);
  const payload=repository.payload(added);expect(payload.owner_text).toBeUndefined();
  expect(payload.text).toContain('guided-first-use/3');expect(payload.text).toContain('Before your final owner-facing response');
  expect(payload.text).toContain('start or reuse ONE bounded legitimate read-only investigador task in this turn');
  expect(payload.text).toContain('current GoalState');expect(payload.text).toContain('latest authentic owner mandate and limits');
  expect(payload.text).toContain('Do not reopen a completed/cancelled goal');
  expect(payload.text).toContain('do not block independent useful read-only market research');
  expect(payload.text).toContain('--chat-id '+flow.session_id);expect(payload.text).toContain('--delivery-mode notify+wake');
  expect(payload.text).toContain('Persist the actual returned native task IDs');
  expect(payload.text).toContain('No commercial permission');expect(payload.text).toContain('Synthetic documented business');
  expect(state.messages.map(message=>message.text)).toEqual(['Your previous proposal is retained.',quote]);
  for(const old of original){const retained=(await repository.turn(flow.id,old.client_message_id))!;expect(repository.payload(retained)).toEqual(repository.payload(old));expect(retained.run_id).toBe(old.run_id);}
  await guided.state(OWNER,test.business);await guided.idle();
  const restarted=test.service();await restarted.state(OWNER,test.business);await restarted.idle();
  expect(test.runs.start).toHaveBeenCalledTimes(1);expect(await repository.turns(flow.id)).toHaveLength(original.length+1);
 });
 it('concurrent initial opens reserve only one V3 server turn and never fabricate an owner statement',async()=>{
  const test=fixture(),guided=test.service();
  const states=await Promise.all([guided.state(OWNER,test.business),guided.state(OWNER,test.business)]);await guided.idle();
  expect(new Set(states.map(state=>state.flow_id)).size).toBe(1);expect(test.runs.start).toHaveBeenCalledTimes(1);
  const turns=await repository.turns(states[0]!.flow_id);expect(turns).toHaveLength(1);
  expect(repository.payload(turns[0]!).owner_text).toBeUndefined();
  expect(repository.payload(turns[0]!).text).toContain('grounded assistant_proposed read-only discovery goal');
 });
});
