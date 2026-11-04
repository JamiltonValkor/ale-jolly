import {createHash} from 'node:crypto';
import {z} from 'zod';
import {TrustedContextV1, ResponseLocaleV1} from '../contracts/continuous-loop';
import {ComputeError} from '../compute/compute-client';
import type {InstanceApi} from '../compute/instance-client';
import {withMetadataValues} from '../compute/metadata';
import type {AssistantRow} from '../persistence/assistant-repository';
import {serviceUnavailable} from '../domain/errors';
import type {JobBinding} from './repository';

const Job = z.object({job_id:z.string().min(1).max(200),business_id:z.uuid(),session_id:z.string().min(1).max(200),
  response_locale:ResponseLocaleV1,locale_revision:z.number().int().positive()}).strict();
export const TrustedContextRegistryV1 = z.object({schema_version:z.literal('trusted-context-registry/1'),
  owner_id:z.string().min(1).max(200),contexts:z.array(TrustedContextV1).max(50),jobs:z.array(Job).max(500),
  operator_canary_client_message_ids:z.array(z.uuid()).max(1000).optional()}).strict();

/** Only server-verified identity and preference data. Never source prose or browser-chosen cloud targets. */
export class TrustedContextPublisher {
  constructor(private readonly instances:InstanceApi,private readonly options:{timeoutMs?:number;pollMs?:number;now?:()=>number;sleep?:(ms:number)=>Promise<void>}={}) {}
  async publish(row:AssistantRow,context:TrustedContextV1):Promise<void> {
    TrustedContextV1.parse(context);
    if(row.user_id!==context.owner_id||!row.instance_name)throw serviceUnavailable();
    const hash=await this.merge(row.instance_name,context.owner_id,context.response_locale,context.locale_revision,context);
    await this.acknowledged(row.instance_name,hash);
  }
  async synchronizeLanguage(row:AssistantRow,preference:{response_locale:string;locale_revision:number}):Promise<void> {
    if(!row.instance_name)throw serviceUnavailable();ResponseLocaleV1.parse(preference.response_locale);
    const hash=await this.merge(row.instance_name,row.user_id,preference.response_locale,preference.locale_revision);
    await this.acknowledged(row.instance_name,hash);
  }
  async bindJobs(row:AssistantRow,bindings:ReadonlyArray<JobBinding>):Promise<void> {
    if(!bindings.length)return;if(!row.instance_name)throw serviceUnavailable();
    for(let attempt=0;attempt<3;attempt++){
      const view=await this.instances.getInstance(row.instance_name);if(!view)throw serviceUnavailable();
      const encoded=view.items.find(item=>item.key==='hermes-continuous-contexts')?.value;if(!encoded)throw serviceUnavailable();
      const registry=TrustedContextRegistryV1.parse(JSON.parse(encoded));if(registry.owner_id!==row.user_id)throw serviceUnavailable();
      const jobs=new Map(registry.jobs.map(job=>[job.job_id,job]));
      for(const binding of bindings){
        if(binding.owner_id!==row.user_id)throw serviceUnavailable();
        const matches=registry.contexts.filter(context=>context.business_id===binding.business_id&&context.session_id===binding.session_id);
        if(matches.length!==1||matches[0]!.response_locale!==binding.response_locale||matches[0]!.locale_revision!==binding.locale_revision)throw serviceUnavailable();
        const existing=jobs.get(binding.job_id);
        if(existing&&(existing.business_id!==binding.business_id||existing.session_id!==binding.session_id))throw serviceUnavailable();
        jobs.set(binding.job_id,Job.parse({job_id:binding.job_id,business_id:binding.business_id,session_id:binding.session_id,
          response_locale:binding.response_locale,locale_revision:binding.locale_revision}));
      }
      const value=JSON.stringify(TrustedContextRegistryV1.parse({...registry,jobs:[...jobs.values()].sort((a,b)=>a.job_id.localeCompare(b.job_id))}));
      if(Buffer.byteLength(value)>128*1024)throw serviceUnavailable();
      try{if(value!==encoded)await this.instances.setMetadata(row.instance_name,view.fingerprint,withMetadataValues(view.items,{'hermes-continuous-contexts':value}));
        await this.acknowledged(row.instance_name,createHash('sha256').update(value).digest('hex'));return;}
      catch(error){if(!(error instanceof ComputeError)||error.status!==412)throw error;}
    }
    throw serviceUnavailable();
  }
  private async merge(instance:string,owner:string,locale:string,revision:number,context?:TrustedContextV1):Promise<string> {
    for(let attempt=0;attempt<3;attempt++){
      const view=await this.instances.getInstance(instance);if(!view)throw serviceUnavailable();
      const previous=view.items.find(item=>item.key==='hermes-continuous-contexts')?.value;
      const registry=previous?TrustedContextRegistryV1.parse(JSON.parse(previous)):
        TrustedContextRegistryV1.parse({schema_version:'trusted-context-registry/1',owner_id:owner,contexts:[],jobs:[]});
      if(registry.owner_id!==owner||registry.contexts.some(c=>c.owner_id!==owner||c.locale_revision>revision))throw serviceUnavailable();
      const contexts=context?[...registry.contexts.filter(c=>c.business_id!==context.business_id),context]:registry.contexts;
      const updated={...registry,contexts:contexts
        .map(c=>({...c,response_locale:locale,locale_revision:revision})).sort((a,b)=>a.business_id.localeCompare(b.business_id)),
      jobs:registry.jobs.map(job=>({...job,response_locale:locale,locale_revision:revision}))};
      const encoded=JSON.stringify(TrustedContextRegistryV1.parse(updated));
      if(Buffer.byteLength(encoded)>128*1024)throw serviceUnavailable();
      const hash=createHash('sha256').update(encoded).digest('hex');
      if(encoded===previous)return hash;
      try{await this.instances.setMetadata(instance,view.fingerprint,withMetadataValues(view.items,{'hermes-continuous-contexts':encoded}));return hash;}
      catch(error){if(!(error instanceof ComputeError)||error.status!==412)throw error;}
    }
    throw serviceUnavailable();
  }
  private async acknowledged(instance:string,hash:string):Promise<void> {
    const now=this.options.now??Date.now;const sleep=this.options.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
    const deadline=now()+(this.options.timeoutMs??25000);
    for(;;){if(await this.instances.guestAttribute(instance,'hermes/continuous-context-hash')===hash)return;
      if(now()>=deadline)throw serviceUnavailable();await sleep(Math.min(this.options.pollMs??500,Math.max(0,deadline-now())));}
  }
}
