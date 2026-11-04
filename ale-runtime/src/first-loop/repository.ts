import {randomUUID} from 'node:crypto';
import type {Database} from '../persistence/database';
import type {FieldCipher} from '../security/field-cipher';
import type {FirstLoopBrief} from './contracts';

export interface FlowRow {id:string;user_id:string;business_id:string;session_id:string;response_locale:string;brief_revision:number;brief_enc:Buffer|null;missing_fields:string[]}
export interface TurnRow {id:string;flow_id:string;user_id:string;business_id:string;client_message_id:string;kind:'message'|'kickoff'|'feedback';request_hash:string;payload_enc:Buffer;work_id:string|null;run_id:string|null;status:'accepted'|'running'|'completed'|'failed'|'unknown';created_at?:Date;dispatch_attempts?:number;retry_after?:Date|null;first_dispatch_at?:Date|null;native_scope_hash?:string|null;native_text_sha256?:string|null;native_body_sha256?:string|null;native_fingerprint?:string|null;native_observed_at?:Date|null;native_terminal_status?:string|null}
export interface WorkRow {id:string;user_id:string;business_id:string;flow_id:string;brief_revision:number;brief_enc:Buffer;revision:number;response_locale:string;feedback_count:number;projection_enc:Buffer|null;projection_generation:string|null;observed_at:Date|null}
export interface TurnPayload {text:string;instructions:string;owner_text?:string}
export type RecoveryFlow=Pick<FlowRow,'id'|'user_id'|'business_id'|'session_id'>;
export interface NativeDispatchGuard {flow:RecoveryFlow;scopeHash:string;textHash:string;bodyHash:string;payloadEnc:Buffer}
export interface NativeReceiptGuard extends NativeDispatchGuard {runId:string;fingerprint:string;status:TurnRow['status'];observedAt:Date;terminalStatus:string|null}

export class FirstLoopRepository {
 constructor(private readonly db:Database,private readonly cipher:FieldCipher){}
 private async rows<T>(sql:string,values:unknown[]):Promise<T[]>{return (await this.db.pool.query(sql,values)).rows as T[];}
 async ensureFlow(user:string,business:string,locale:string):Promise<FlowRow>{
  const id=randomUUID();const [row]=await this.rows<FlowRow>(`INSERT INTO assistant.first_loop_flows(id,user_id,business_id,session_id,response_locale) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,business_id) DO UPDATE SET response_locale=EXCLUDED.response_locale,updated_at=now() RETURNING *`,[id,user,business,`saleads-flow-${id}`,locale]);return row!;
 }
 async flow(user:string,business:string):Promise<FlowRow|null>{return (await this.rows<FlowRow>('SELECT * FROM assistant.first_loop_flows WHERE user_id=$1 AND business_id=$2',[user,business]))[0]??null;}
 brief(flow:FlowRow):FirstLoopBrief|null{return flow.brief_enc?JSON.parse(this.cipher.open('first_loop.brief',flow.user_id,Buffer.from(flow.brief_enc))) as FirstLoopBrief:null;}
 async saveBrief(flow:FlowRow,revision:number,brief:FirstLoopBrief,missing:string[]):Promise<void>{await this.rows(`UPDATE assistant.first_loop_flows SET brief_revision=$2,brief_enc=$3,missing_fields=$4::jsonb,updated_at=now() WHERE id=$1 AND brief_revision<$2`,[flow.id,revision,this.cipher.seal('first_loop.brief',flow.user_id,JSON.stringify(brief)),JSON.stringify(missing)]);}
 async turns(flow:string):Promise<TurnRow[]>{return this.rows<TurnRow>('SELECT * FROM assistant.first_loop_turns WHERE flow_id=$1 ORDER BY created_at DESC,id DESC LIMIT 200',[flow]).then(rows=>rows.reverse());}
 async turn(flow:string,client:string):Promise<TurnRow|null>{return (await this.rows<TurnRow>('SELECT * FROM assistant.first_loop_turns WHERE flow_id=$1 AND client_message_id=$2',[flow,client]))[0]??null;}
 payload(turn:TurnRow):TurnPayload{return JSON.parse(this.cipher.open('first_loop.turn',turn.user_id,Buffer.from(turn.payload_enc))) as TurnPayload;}
 async reserveTurn(flow:FlowRow,client:string,kind:TurnRow['kind'],hash:string,payload:TurnPayload,work:string|null):Promise<TurnRow>{
  const [row]=await this.rows<TurnRow>(`INSERT INTO assistant.first_loop_turns(id,flow_id,user_id,business_id,client_message_id,kind,request_hash,payload_enc,work_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(flow_id,client_message_id) DO UPDATE SET client_message_id=EXCLUDED.client_message_id RETURNING *`,[randomUUID(),flow.id,flow.user_id,flow.business_id,client,kind,hash,this.cipher.seal('first_loop.turn',flow.user_id,JSON.stringify(payload)),work]);return row!;
 }
 async reserveFeedback(flow:FlowRow,work:WorkRow,client:string,hash:string,payload:TurnPayload):Promise<TurnRow|null>{
  const [r]=await this.rows<TurnRow>(`WITH fresh AS (INSERT INTO assistant.first_loop_turns(id,flow_id,user_id,business_id,client_message_id,kind,request_hash,payload_enc,work_id) SELECT $1,$2,$3,$4,$5,'feedback',$6,$7,$8 FROM assistant.first_loop_works WHERE id=$8 AND revision=$9 ON CONFLICT(flow_id,client_message_id) DO NOTHING RETURNING *), advanced AS (UPDATE assistant.first_loop_works SET revision=revision+1,feedback_count=feedback_count+1,updated_at=now() WHERE id=$8 AND revision=$9 AND EXISTS(SELECT 1 FROM fresh) RETURNING id) SELECT fresh.* FROM fresh WHERE EXISTS(SELECT 1 FROM advanced)`,[randomUUID(),flow.id,flow.user_id,flow.business_id,client,hash,this.cipher.seal('first_loop.turn',flow.user_id,JSON.stringify(payload)),work.id,work.revision]);return r??null;
 }
 async reserveDispatch(id:string,now:Date,guard?:NativeDispatchGuard):Promise<boolean>{
  if(!guard)return (await this.rows<{id:string}>(`UPDATE assistant.first_loop_turns SET dispatch_attempts=dispatch_attempts+1,retry_after=$2::timestamptz + interval '20 seconds' WHERE id=$1 AND run_id IS NULL AND dispatch_attempts<4 AND (retry_after IS NULL OR retry_after<=$2) RETURNING id`,[id,now])).length===1;
  const {flow}=guard;
  return (await this.rows<{id:string}>(`UPDATE assistant.first_loop_turns t SET
    dispatch_attempts=dispatch_attempts+1,
    first_dispatch_at=COALESCE(first_dispatch_at,CASE WHEN dispatch_attempts>0 THEN created_at ELSE $2::timestamptz END),
    native_scope_hash=COALESCE(native_scope_hash,$7),native_text_sha256=COALESCE(native_text_sha256,$8),
    native_body_sha256=COALESCE(native_body_sha256,$9),
    retry_after=$2::timestamptz + LEAST(300,20*power(2,LEAST(dispatch_attempts,4))) * interval '1 second'
   WHERE t.id=$1 AND t.flow_id=$3 AND t.user_id=$4 AND t.business_id=$5
    AND EXISTS(SELECT 1 FROM assistant.first_loop_flows f WHERE f.id=t.flow_id AND f.user_id=$4 AND f.business_id=$5 AND f.session_id=$6)
    AND t.payload_enc=$10 AND t.run_id IS NULL AND t.status NOT IN ('completed','failed')
    AND (t.retry_after IS NULL OR t.retry_after<=$2)
    AND (t.native_scope_hash=$7 OR (t.native_scope_hash IS NULL AND t.dispatch_attempts=0))
    AND (t.native_text_sha256 IS NULL OR t.native_text_sha256=$8)
    AND (t.native_body_sha256 IS NULL OR t.native_body_sha256=$9)
    AND $2::timestamptz>=COALESCE(t.first_dispatch_at,CASE WHEN t.dispatch_attempts>0 THEN t.created_at ELSE $2::timestamptz END)
    AND $2::timestamptz<COALESCE(t.first_dispatch_at,CASE WHEN t.dispatch_attempts>0 THEN t.created_at ELSE $2::timestamptz END)+interval '23 hours'
   RETURNING t.id`,[id,now,flow.id,flow.user_id,flow.business_id,flow.session_id,guard.scopeHash,guard.textHash,guard.bodyHash,guard.payloadEnc])).length===1;
 }
 async recoveryTurn(flow:RecoveryFlow,id:string):Promise<TurnRow|null>{return (await this.rows<TurnRow>(`SELECT t.* FROM assistant.first_loop_turns t
   JOIN assistant.first_loop_flows f ON f.id=t.flow_id AND f.user_id=t.user_id AND f.business_id=t.business_id
   WHERE t.id=$1 AND t.flow_id=$2 AND t.user_id=$3 AND t.business_id=$4 AND f.session_id=$5`,[id,flow.id,flow.user_id,flow.business_id,flow.session_id]))[0]??null;}
 async recordNativeReceipt(id:string,guard:NativeReceiptGuard):Promise<boolean>{
  const {flow}=guard;
  return (await this.rows<{id:string}>(`UPDATE assistant.first_loop_turns t SET
   run_id=COALESCE(run_id,$11),native_scope_hash=COALESCE(native_scope_hash,$7),native_text_sha256=COALESCE(native_text_sha256,$8),
   native_body_sha256=COALESCE(native_body_sha256,$9),native_fingerprint=COALESCE(native_fingerprint,$12),
   first_dispatch_at=COALESCE(first_dispatch_at,created_at),
   status=CASE WHEN t.status IN ('completed','failed') THEN t.status
    WHEN $15::text IS NOT NULL THEN $13
    WHEN t.native_observed_at IS NOT NULL AND t.native_observed_at>$14 THEN t.status ELSE $13 END,
   native_observed_at=GREATEST(native_observed_at,$14),native_terminal_status=COALESCE(native_terminal_status,$15),updated_at=$2::timestamptz
   WHERE t.id=$1 AND t.flow_id=$3 AND t.user_id=$4 AND t.business_id=$5
    AND EXISTS(SELECT 1 FROM assistant.first_loop_flows f WHERE f.id=t.flow_id AND f.user_id=$4 AND f.business_id=$5 AND f.session_id=$6)
    AND t.payload_enc=$10 AND t.dispatch_attempts>0
    AND (t.run_id IS NULL OR t.run_id=$11) AND (t.native_scope_hash IS NULL OR t.native_scope_hash=$7)
    AND (t.native_text_sha256 IS NULL OR t.native_text_sha256=$8) AND (t.native_body_sha256 IS NULL OR t.native_body_sha256=$9)
    AND (t.native_fingerprint IS NULL OR t.native_fingerprint=$12)
    AND (t.native_terminal_status IS NULL OR $15::text IS NULL OR t.native_terminal_status=$15)
    AND (t.status NOT IN ('completed','failed') OR $13 NOT IN ('completed','failed') OR t.status=$13)
   RETURNING t.id`,[id,new Date(),flow.id,flow.user_id,flow.business_id,flow.session_id,guard.scopeHash,guard.textHash,guard.bodyHash,guard.payloadEnc,guard.runId,guard.fingerprint,guard.status,guard.observedAt,guard.terminalStatus])).length===1;
 }
 async setRun(id:string,run:string|null,status:TurnRow['status']):Promise<void>{await this.rows(`UPDATE assistant.first_loop_turns SET run_id=$2::text,status=CASE WHEN status IN ('completed','failed') THEN status ELSE $3 END,updated_at=now() WHERE id=$1 AND (run_id IS NULL OR run_id=$2::text)`,[id,run,status]);}
 async receipt(flow:FlowRow,operation:string,key:string,hash:string):Promise<boolean>{const [r]=await this.rows<{request_hash:string}>(`INSERT INTO assistant.first_loop_receipts(user_id,flow_id,operation,idempotency_key,request_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,flow_id,operation,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING request_hash`,[flow.user_id,flow.id,operation,key,hash]);return r?.request_hash===hash;}
 async createWork(flow:FlowRow):Promise<WorkRow|null>{
  const [r]=await this.rows<WorkRow>(`INSERT INTO assistant.first_loop_works(id,user_id,business_id,flow_id,brief_revision,brief_enc,response_locale) SELECT $1,user_id,business_id,id,brief_revision,brief_enc,response_locale FROM assistant.first_loop_flows WHERE id=$2 AND brief_revision=$3 AND brief_enc IS NOT NULL ON CONFLICT(flow_id,brief_revision) DO UPDATE SET brief_revision=EXCLUDED.brief_revision RETURNING *`,[randomUUID(),flow.id,flow.brief_revision]);return r??null;
 }
 async work(user:string,business:string,id:string):Promise<WorkRow|null>{return (await this.rows<WorkRow>('SELECT * FROM assistant.first_loop_works WHERE id=$1 AND user_id=$2 AND business_id=$3',[id,user,business]))[0]??null;}
 async latestWork(user:string,business:string):Promise<WorkRow|null>{return (await this.rows<WorkRow>('SELECT * FROM assistant.first_loop_works WHERE user_id=$1 AND business_id=$2 ORDER BY created_at DESC LIMIT 1',[user,business]))[0]??null;}
 async advanceFeedback(work:WorkRow):Promise<WorkRow|null>{return (await this.rows<WorkRow>('UPDATE assistant.first_loop_works SET revision=revision+1,feedback_count=feedback_count+1,updated_at=now() WHERE id=$1 AND revision=$2 RETURNING *',[work.id,work.revision]))[0]??null;}
 projection(work:WorkRow):unknown{return work.projection_enc?JSON.parse(this.cipher.open('first_loop.projection',work.user_id,Buffer.from(work.projection_enc))):null;}
 async saveProjection(work:WorkRow,generation:string,at:Date,value:unknown):Promise<void>{await this.rows(`UPDATE assistant.first_loop_works SET projection_enc=$2,projection_generation=$3,observed_at=$4,updated_at=now() WHERE id=$1 AND (observed_at IS NULL OR observed_at<=$4)`,[work.id,this.cipher.seal('first_loop.projection',work.user_id,JSON.stringify(value)),generation,at]);}
}
