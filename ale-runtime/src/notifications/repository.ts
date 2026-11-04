import {createHash} from 'node:crypto';
import {ConversationEventV1, DeliveryReceiptV1, NotificationV1, ResponseLocaleV1} from '../contracts/continuous-loop';
import type {Database} from '../persistence/database';
import type {FieldCipher} from '../security/field-cipher';

export interface JobBinding {
  owner_id: string; business_id: string; session_id: string; job_id: string;
  response_locale: string; locale_revision: number;
}
interface NoticeRow {
  id: string; cursor: string; owner_id: string; business_id: string; session_id: string;
  payload_enc: Buffer; payload_hash: string; home_state: string | null;
  reconcile_by: Date | null; saleads_delivered_at: Date | null;
}
export interface HomeReceipt {
  attempt_id: string; destination_version: string;
  state: 'accepted' | 'delivered' | 'failed' | 'unknown';
  evidence_ref: string | null; reconcile_by: string | null;
}
export class NotificationRepository {
  constructor(private readonly db: Database, private readonly cipher: FieldCipher) {}
  private async rows<T>(sql: string, values: unknown[]): Promise<T[]> {
    return (await this.db.pool.query(sql, values)).rows as T[];
  }
  async bindJob(binding: JobBinding): Promise<void> {
    ResponseLocaleV1.parse(binding.response_locale);
    if (!Number.isSafeInteger(binding.locale_revision) || binding.locale_revision < 1) throw new Error('invalid_locale_revision');
    const rows = await this.rows(`INSERT INTO assistant.scheduled_job_bindings(owner_id,job_id,business_id,session_id,response_locale,locale_revision)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(owner_id,job_id) DO UPDATE SET
      response_locale=EXCLUDED.response_locale,locale_revision=EXCLUDED.locale_revision,updated_at=now()
      WHERE scheduled_job_bindings.business_id=EXCLUDED.business_id AND scheduled_job_bindings.session_id=EXCLUDED.session_id
      AND (scheduled_job_bindings.locale_revision<EXCLUDED.locale_revision OR
        (scheduled_job_bindings.locale_revision=EXCLUDED.locale_revision AND scheduled_job_bindings.response_locale=EXCLUDED.response_locale)) RETURNING job_id`,
    [binding.owner_id,binding.job_id,binding.business_id,binding.session_id,binding.response_locale,binding.locale_revision]);
    if (!rows.length) throw new Error('job_binding_conflict');
  }
  async binding(owner: string, job: string): Promise<JobBinding | null> {
    return (await this.rows<JobBinding>('SELECT * FROM assistant.scheduled_job_bindings WHERE owner_id=$1 AND job_id=$2', [owner,job]))[0] ?? null;
  }
  async updateLocale(owner:string,locale:string,revision:number):Promise<void> {
    ResponseLocaleV1.parse(locale);
    await this.rows('UPDATE assistant.scheduled_job_bindings SET response_locale=$2,locale_revision=$3,updated_at=now() WHERE owner_id=$1 AND locale_revision<=$3',[owner,locale,revision]);
  }
  async save(notice: NotificationV1): Promise<'saved' | 'replayed' | 'mutation'> {
    const text = JSON.stringify(NotificationV1.parse(notice));
    const hash = createHash('sha256').update(text).digest('hex');
    const inserted = await this.rows(`INSERT INTO assistant.notifications(id,owner_id,business_id,session_id,source_id,execution_id,source_version,payload_enc,payload_hash,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id`,
    [notice.notification_id,notice.owner_id,notice.business_id,notice.session_id,notice.source_id,notice.execution_id,notice.source_version,
      this.cipher.seal('notifications.payload',notice.owner_id,text),hash,notice.created_at]);
    if (inserted.length) return 'saved';
    const row = await this.notice(notice.owner_id,notice.notification_id);
    return row?.payload_hash === hash ? 'replayed' : 'mutation';
  }
  private async notice(owner: string, id: string): Promise<NoticeRow | null> {
    return (await this.rows<NoticeRow>('SELECT * FROM assistant.notifications WHERE owner_id=$1 AND id=$2', [owner,id]))[0] ?? null;
  }
  async receipts(owner: string, id: string): Promise<DeliveryReceiptV1[]> {
    const rows = await this.rows<{payload_enc: Buffer}>('SELECT payload_enc FROM assistant.notification_receipts WHERE owner_id=$1 AND notification_id=$2 ORDER BY updated_at', [owner,id]);
    return rows.map(row => DeliveryReceiptV1.parse(JSON.parse(this.cipher.open('notifications.receipt',owner,Buffer.from(row.payload_enc)))));
  }
  async recordHomeReceipt(owner: string, id: string, receipt: HomeReceipt): Promise<void> {
    const row = await this.notice(owner,id);
    if (!row) throw new Error('notification_not_found');
    const payload = DeliveryReceiptV1.parse({schema_version:'delivery-receipt/1',receipt_id:receipt.attempt_id,
      notification_id:id,owner_id:owner,business_id:row.business_id,destination:'home',...receipt,
      fallback:false,updated_at:new Date().toISOString()});
    await this.rows(`WITH updated AS (UPDATE assistant.notifications SET home_state=$3,reconcile_by=$4
      WHERE owner_id=$1 AND id=$2 AND (home_state IS DISTINCT FROM 'delivered' OR $3='delivered') RETURNING id)
      INSERT INTO assistant.notification_receipts(owner_id,notification_id,attempt_id,destination,state,payload_enc)
      SELECT $1,$2,$5,'home',$3,$6 FROM updated ON CONFLICT(owner_id,notification_id,attempt_id)
      DO UPDATE SET state=EXCLUDED.state,payload_enc=EXCLUDED.payload_enc,updated_at=now()
      WHERE notification_receipts.state<>'delivered'`,
    [owner,id,receipt.state,receipt.reconcile_by,receipt.attempt_id,this.cipher.seal('notifications.receipt',owner,JSON.stringify(payload))]);
  }
  async deliverInSaleads(owner: string, id: string, reason: 'no_home' | 'failed' | 'ack_timeout'): Promise<void> {
    const row = await this.notice(owner,id);
    if (!row) throw new Error('notification_not_found');
    if (row.home_state === 'delivered') throw new Error('home_delivery_confirmed');
    if (['accepted','unknown'].includes(row.home_state ?? '') && (reason !== 'ack_timeout' || !row.reconcile_by || row.reconcile_by.getTime()>Date.now())) throw new Error('home_delivery_pending');
    const payload = DeliveryReceiptV1.parse({schema_version:'delivery-receipt/1',receipt_id:'saleads:'+id,notification_id:id,
      owner_id:owner,business_id:row.business_id,destination:'saleads',destination_version:'1',attempt_id:'saleads:'+id,
      state:'delivered',fallback:true,evidence_ref:reason,reconcile_by:null,updated_at:new Date().toISOString()});
    await this.rows(`WITH updated AS (UPDATE assistant.notifications SET saleads_delivered_at=COALESCE(saleads_delivered_at,now())
      WHERE owner_id=$1 AND id=$2 AND home_state IS DISTINCT FROM 'delivered'
      AND (home_state IS NULL OR home_state='failed' OR ($3='ack_timeout' AND reconcile_by<=now())) RETURNING id)
      INSERT INTO assistant.notification_receipts(owner_id,notification_id,attempt_id,destination,state,payload_enc)
      SELECT $1,$2,$4,'saleads','delivered',$5 FROM updated ON CONFLICT DO NOTHING`,
    [owner,id,reason,'saleads:'+id,this.cipher.seal('notifications.receipt',owner,JSON.stringify(payload))]);
  }
  async reconcileDueFallbacks(owner:string):Promise<void> {
    const pending=await this.rows<{id:string}>(`SELECT id FROM assistant.notifications WHERE owner_id=$1
      AND saleads_delivered_at IS NULL AND home_state IN ('accepted','unknown') AND reconcile_by<=now()
      ORDER BY reconcile_by LIMIT 100`,[owner]);
    for(const row of pending){
      try{await this.deliverInSaleads(owner,row.id,'ack_timeout');}
      catch(error){if(!(error instanceof Error)||error.message!=='home_delivery_confirmed')throw error;}
    }
  }
  async conversation(owner: string, business: string, session: string, after?: string): Promise<ConversationEventV1[]> {
    if (after!==undefined&&!/^\d{1,19}$/.test(after)) throw new Error('invalid_cursor');
    const rows = await this.rows<NoticeRow>(`SELECT * FROM assistant.notifications
      WHERE owner_id=$1 AND business_id=$2 AND session_id=$3 AND cursor>$4::bigint AND saleads_delivered_at IS NOT NULL
      ORDER BY cursor ${after===undefined?'DESC':'ASC'} LIMIT 100`, [owner,business,session,after??'0']);
    if(after===undefined)rows.reverse();
    return rows.map(row => {
      const value = NotificationV1.parse(JSON.parse(this.cipher.open('notifications.payload',owner,Buffer.from(row.payload_enc))));
      return ConversationEventV1.parse({schema_version:'conversation-event/1',event_id:row.id,cursor:String(row.cursor),business_id:business,
        session_id:session,message_id:row.id,role:'assistant',text:value.text,created_at:value.created_at,source:'scheduled',dedupe_key:row.id});
    });
  }
}
