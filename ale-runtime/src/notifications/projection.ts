import {gunzipSync} from 'node:zlib';
import {z} from 'zod';
import type {InstanceApi} from '../compute/instance-client';
import {withMetadataValues} from '../compute/metadata';
import type {AssistantRow} from '../persistence/assistant-repository';
import type {SnapshotStorage} from '../orqa/brain-snapshots';
import {NativeResultV1, NotificationCollector} from './collector';
import {NotificationRepository} from './repository';
import {NativeRunReceiptV1} from '../first-loop/native-recovery';

const Delivery = z.object({state:z.enum(['delivered','failed','unknown','no_home']),
  evidence_ref:z.string().max(2048),reconcile_by:z.iso.datetime({offset:true}).nullable(),destination_version:z.string().min(1).max(200).optional()}).strict();
const Projection = z.object({schema_version:z.literal('native-notifications/1'),owner_id:z.string(),
  observed_at:z.iso.datetime({offset:true}),notifications:z.array(NativeResultV1.extend({delivery:Delivery})).max(1000),
  run_receipts:z.unknown().optional()}).strict();
export type NativeReceiptConsumer=(row:AssistantRow,receipts:ReadonlyArray<NativeRunReceiptV1>)=>Promise<void>;

/** Pulls the VM's fixed signed object; it never sends a prompt to move an existing result. */
export class NotificationProjection {
  private readonly urls=new Map<string,number>();
  private readonly collector:NotificationCollector;
  constructor(private readonly repository:NotificationRepository,private readonly storage:SnapshotStorage,
    private readonly instances:InstanceApi,private readonly now:()=>Date=()=>new Date(),private readonly consumeNativeReceipts?:NativeReceiptConsumer) {this.collector=new NotificationCollector(repository);}
  private async publish(row:AssistantRow):Promise<void> {
    if(!row.instance_name)throw new Error('instance_unavailable');
    if((this.urls.get(row.user_id)??0)>this.now().getTime()-86400000)return;
    const url=await this.storage.signedPutUrl(`continuous-uploads/${row.user_id}/notifications.json.gz`,this.now(),604800);
    for(let attempt=0;attempt<2;attempt++){
      const view=await this.instances.getInstance(row.instance_name);if(!view)throw new Error('instance_unavailable');
      try{await this.instances.setMetadata(row.instance_name,view.fingerprint,withMetadataValues(view.items,{'hermes-continuous-url':url}));
        this.urls.set(row.user_id,this.now().getTime());return;}catch(error){if(attempt)throw error;}
    }
  }
  async messages(row:AssistantRow,business:string,session:string){
    await this.repository.reconcileDueFallbacks(row.user_id);
    try{await this.refresh(row);}catch{/* Cloud refresh is separate from already-persisted delivery. */}
    return this.repository.conversation(row.user_id,business,session);
  }
  private async refresh(row:AssistantRow):Promise<void>{
    await this.publish(row);
    await this.refreshNativeReceipts(row);
  }
  /** Fixed private owner object only. No metadata write, native POST or inference
   * is needed to recover an already-admitted run, even beyond replay retention. */
  async refreshNativeReceipts(row:AssistantRow):Promise<void>{
    const encoded=await this.storage.download(`continuous-uploads/${row.user_id}/notifications.json.gz`,2097152);
    if(encoded){
      const parsed=Projection.safeParse(JSON.parse(gunzipSync(encoded,{maxOutputLength:4*1024*1024}).toString('utf8')));
      if(!parsed.success||parsed.data.owner_id!==row.user_id||Date.parse(parsed.data.observed_at)>this.now().getTime()+60000)throw new Error('invalid_native_projection');
      const receiptSection=parsed.data.run_receipts;
      const receiptsIncomplete=receiptSection!==undefined&&(!Array.isArray(receiptSection)||receiptSection.length>2000);
      const receipts=(Array.isArray(receiptSection)&&!receiptsIncomplete?receiptSection:[]).flatMap(raw=>{
        const receipt=NativeRunReceiptV1.safeParse(raw);
        return receipt.success&&receipt.data.owner_id===row.user_id?[receipt.data]:[];
      });
      if(receipts.length)await this.consumeNativeReceipts?.(row,receipts);
      for(const entry of parsed.data.notifications){
        const {delivery,...result}=entry;
        const saved=await this.collector.collect(row.user_id,result);if(saved.kind==='pending')continue;
        if(delivery.state==='no_home'){await this.repository.deliverInSaleads(row.user_id,saved.notification_id,'no_home');continue;}
        const deadline=new Date(Date.parse(result.finished_at)+120000).toISOString();
        await this.repository.recordHomeReceipt(row.user_id,saved.notification_id,{attempt_id:'native:'+result.execution_id,
          destination_version:delivery.destination_version??'native-home/1',state:delivery.state,evidence_ref:delivery.evidence_ref,
          reconcile_by:delivery.state==='unknown'?deadline:null});
        if(delivery.state==='failed')await this.repository.deliverInSaleads(row.user_id,saved.notification_id,'failed');
        if(delivery.state==='unknown'&&Date.parse(deadline)<=this.now().getTime())await this.repository.deliverInSaleads(row.user_id,saved.notification_id,'ack_timeout');
      }
      // Preserve ordinary notifications even if recovery exceeds the pilot's
      // receipt bound. Dispatch callers must still treat this feed as unavailable.
      if(receiptsIncomplete)throw new Error('incomplete_native_run_receipts');
    }
  }
}
