import {createHash} from 'node:crypto';
import {TrustedContextPublisher} from '../src/notifications/trusted-contexts';
import {ComputeError} from '../src/compute/compute-client';
import type {InstanceApi} from '../src/compute/instance-client';
import type {AssistantRow} from '../src/persistence/assistant-repository';
import type {TrustedContextV1} from '../src/contracts/continuous-loop';
import {RestInstanceClient} from '../src/compute/instance-client';
import {RestInstanceMetadata} from '../src/renewal/instance-metadata';

const owner='fixture-owner', business='11111111-1111-4111-8111-111111111111';
const context:TrustedContextV1={schema_version:'trusted-context/1',owner_id:owner,business_id:business,session_id:'session-fixture',actor_role:'ale',
  native_task_id:null,native_run_id:null,response_locale:'en',locale_revision:1,capabilities:['saleads:read'],mandate_id:null,pending_context:false};
const row={user_id:owner,instance_name:'fixture-vm'} as AssistantRow;

describe('server-owned native context publication',()=>{
  let items:Array<{key:string;value:string}>,ack:string|null,conflict:boolean;
  let api:InstanceApi;
  beforeEach(()=>{
    items=[{key:'startup-script',value:'preserved-startup'},{key:'hermes-env',value:'preserved-private-env'}];ack=null;conflict=false;
    api={getInstance:jest.fn(async()=>({status:'RUNNING' as const,privateIp:'10.0.0.1',fingerprint:'fp',items})),
      setMetadata:jest.fn(async(_name,_fingerprint,next)=>{if(conflict){conflict=false;throw new ComputeError(412,'conditionNotMet');}
        items=next;ack=createHash('sha256').update(next.find(i=>i.key==='hermes-continuous-contexts')!.value).digest('hex');}),
      guestAttribute:jest.fn(async(_instance,key)=>{if(key!=='hermes/continuous-context-hash')throw new ComputeError(0,'invalid_guest_key');return ack;})};
  });
  it('preserves metadata and publishes independent business/session bindings without a first-business fallback',async()=>{
    const publisher=new TrustedContextPublisher(api);
    await publisher.publish(row,context);
    await publisher.publish(row,{...context,business_id:'22222222-2222-4222-8222-222222222222',session_id:'session-other'});
    const saved=JSON.parse(items.find(i=>i.key==='hermes-continuous-contexts')!.value);
    expect(saved.contexts.map((c:TrustedContextV1)=>c.session_id)).toEqual(['session-fixture','session-other']);
    expect(items.find(i=>i.key==='hermes-env')!.value).toBe('preserved-private-env');
    await expect(publisher.publish({...row,user_id:'other'},context)).rejects.toMatchObject({code:'SERVICE_UNAVAILABLE'});
  });
  it('refreshes every registered business and cron after a configured user language change',async()=>{
    const publisher=new TrustedContextPublisher(api);await publisher.publish(row,context);
    const registry=JSON.parse(items.find(i=>i.key==='hermes-continuous-contexts')!.value);
    registry.jobs=[{job_id:'job-fixture',business_id:business,session_id:context.session_id,response_locale:'en',locale_revision:1}];
    items=items.map(i=>i.key==='hermes-continuous-contexts'?{...i,value:JSON.stringify(registry)}:i);
    await publisher.synchronizeLanguage(row,{response_locale:'pt-BR',locale_revision:2});
    const updated=JSON.parse(items.find(i=>i.key==='hermes-continuous-contexts')!.value);
    expect(updated.contexts[0].response_locale).toBe('pt-BR');expect(updated.jobs[0].response_locale).toBe('pt-BR');
    expect(updated.jobs[0].locale_revision).toBe(2);
    await expect(publisher.publish(row,context)).rejects.toMatchObject({code:'SERVICE_UNAVAILABLE'});
  });
  it('re-reads a fingerprint conflict and never admits inference on an unacknowledged context',async()=>{
    conflict=true;await new TrustedContextPublisher(api).publish(row,context);expect(api.setMetadata).toHaveBeenCalledTimes(2);
    let clock=0;api.guestAttribute=async()=>null;
    await expect(new TrustedContextPublisher(api,{timeoutMs:10,pollMs:5,now:()=>clock,sleep:async ms=>{clock+=ms;}})
      .publish(row,context)).rejects.toMatchObject({code:'SERVICE_UNAVAILABLE'});
  });
  it('waits for the namespaced guest ACK through the actual Compute transport',async()=>{
    const instance='sa-assistant-'+ '1'.repeat(32);let polls=0,clock=0;
    const transport=new RestInstanceMetadata({project:'fixture-project',apiBase:'https://compute.example.test/v1'},
      {token:async()=>'fixture-token'},async(input,init)=>{
        const url=new URL(input);
        if(url.pathname.endsWith('/getGuestAttributes')){
          expect(url.searchParams.get('variableKey')).toBe('hermes/continuous-context-hash');
          if(++polls===1)return Response.json({error:{}},{status:404});
          return Response.json({variableValue:ack});
        }
        if(url.pathname.endsWith('/setMetadata')){
          const body=JSON.parse(String(init?.body));items=body.items;
          ack=createHash('sha256').update(items.find(i=>i.key==='hermes-continuous-contexts')!.value).digest('hex');
          return Response.json({name:'fixture-operation'});
        }
        return Response.json({status:'RUNNING',metadata:{fingerprint:'fp',items}});
      },{operationTimeoutMs:0});
    await expect(new TrustedContextPublisher(new RestInstanceClient(transport,'us-central1-a'),
      {timeoutMs:10,pollMs:1,now:()=>clock,sleep:async ms=>{clock+=ms;}})
      .publish({...row,instance_name:instance},context)).resolves.toBeUndefined();
    expect(polls).toBe(2);
  });
});
