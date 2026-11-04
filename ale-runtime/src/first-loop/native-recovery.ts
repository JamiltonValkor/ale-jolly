import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {FirstLoopRepository,NativeDispatchGuard,RecoveryFlow,TurnRow} from './repository';
import type {AssistantRow} from '../persistence/assistant-repository';
import type {FieldCipher} from '../security/field-cipher';

const HASH=/^[a-f0-9]{64}$/;
const ID=z.string().min(1).max(200);
const Instant=z.iso.datetime({offset:true});
const NativeStatus=z.enum(['queued','running','waiting_for_approval','stopping','completed','failed','cancelled','interrupted']);
const TERMINAL=new Set(['completed','failed','cancelled','interrupted']);
export const NATIVE_REPLAY_HORIZON_MS=23*60*60*1000;

/** Closed whitelist emitted by the native run_receipts copier. Source authenticity
 * is established by the caller's fixed, owner-bound signed VM storage object;
 * this module never accepts a browser/model supplied receipt or starts a run. */
export const NativeRunReceiptV1=z.object({
 schema_version:z.literal('native-run-receipt/1'),owner_id:ID,business_id:z.uuid(),session_id:ID,
 turn_id:z.uuid(),idempotency_key:ID,run_id:z.string().regex(/^run_[a-f0-9]{32}$/),
 request_text_sha256:z.string().regex(HASH),native_scope_sha256:z.string().regex(HASH),native_request_fingerprint:z.string().regex(HASH),
 accepted_at:Instant,native_created_at:Instant,native_updated_at:Instant,status_observed_at:Instant,
 native_status:NativeStatus,terminal_proven:z.boolean(),native_record_present:z.boolean(),
 proof_gap:z.enum(['native_turn_identity_conflict','native_terminal_identity_conflict','native_terminal_proof_unavailable']).nullable(),
}).strict();
export type NativeRunReceiptV1=z.infer<typeof NativeRunReceiptV1>;
export interface NativeReplayCapability {supported:boolean;durable:boolean;retention_seconds:number}
export interface NativeReplayIdentity {scope_sha256:string;capability:NativeReplayCapability}
export type NativeDispatchDecision =
 |{kind:'dispatch';idempotency_key:string;text:string;instructions:string;scope_sha256:string}
 |{kind:'read_only';reason:string;run_id:string|null;retry_after:string|null};
export type NativeReceiptDecision={kind:'recovered'|'replayed';run_id:string;status:TurnRow['status']}|{kind:'pending';reason:string};
const sha=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
const stamp=(value:Date|string|null|undefined):number|null=>{if(!value)return null;const n=new Date(value).getTime();return Number.isFinite(n)?n:null;};

/** Exact ordinary API namespace in Hermes a28a5d03 api_server_runs.py. Room
 * grants use a different recipe and are deliberately not supported here. */
export function nativeApiScopeSha256(apiKey:string,profile='default'):string{
 if(!apiKey||!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile))throw new Error('native_scope_identity_invalid');
 return sha(profile+'\0'+apiKey);
}
export function nativeTurnTextSha256(text:string):string{return sha(text);}
/** Exact body used by HttpFirstLoopRuns, canonicalized like the pinned Hermes
 * json.dumps(sort_keys=True,separators=(',',':'),ensure_ascii=False). The ordinary
 * API adapter sends no gateway-session header and no room-dispatch fields. */
export function nativeRequestFingerprint(session:string,text:string,instructions:string):string{
 return sha(JSON.stringify({body:{input:text,instructions,session_id:session},gateway_session_key:''}));
}

/** Only the private owner projection calls this consumer. It reads a specific
 * existing flow per receipt; it never creates flows or scans other owners. */
export function nativeReceiptConsumer(repository:FirstLoopRepository,recovery:NativeTurnRecovery,cipher:FieldCipher){
 return async(row:AssistantRow,receipts:ReadonlyArray<NativeRunReceiptV1>):Promise<void>=>{
  if(!row.api_server_key_enc)return;
  const scope=nativeApiScopeSha256(cipher.open('assistants.api_server_key_enc',row.user_id,Buffer.from(row.api_server_key_enc)));
  for(const receipt of receipts){
   if(receipt.owner_id!==row.user_id)continue;
   const flow=await repository.flow(row.user_id,receipt.business_id);
   if(flow&&flow.session_id===receipt.session_id)await recovery.observe(flow,receipt,scope);
  }
 };
}

/** Recovery policy and persistence only: no HTTP POST, no model, no new key,
 * payload rewrite, credential renewal, auth lease or process-death guess. */
export class NativeTurnRecovery {
 constructor(private readonly repository:FirstLoopRepository,private readonly now:()=>Date=()=>new Date()){}
 private guard(flow:RecoveryFlow,turn:TurnRow,scope:string):NativeDispatchGuard{
  const payload=this.repository.payload(turn);
  return {flow,scopeHash:scope,textHash:sha(payload.text),bodyHash:sha(JSON.stringify([flow.session_id,payload.text,payload.instructions])),payloadEnc:Buffer.from(turn.payload_enc)};
 }
 private reason(turn:TurnRow,guard:NativeDispatchGuard,now:Date):string|null{
  if(turn.native_scope_hash&&turn.native_scope_hash!==guard.scopeHash)return 'native_scope_changed';
  if(turn.native_text_sha256&&turn.native_text_sha256!==guard.textHash||turn.native_body_sha256&&turn.native_body_sha256!==guard.bodyHash)return 'frozen_payload_changed';
  if(turn.status==='completed'||turn.status==='failed')return 'terminal_known';
  if(turn.run_id)return 'native_run_known';
  const attempts=turn.dispatch_attempts??0;
  const anchor=stamp(turn.first_dispatch_at)??(attempts>0?stamp(turn.created_at):now.getTime());
  if(anchor===null)return 'first_dispatch_time_unproven';
  if(now.getTime()<anchor)return 'clock_before_first_dispatch';
  if(now.getTime()-anchor>=NATIVE_REPLAY_HORIZON_MS)return 'native_replay_horizon_elapsed';
  if(attempts>0&&!turn.native_scope_hash)return 'legacy_native_scope_unproven';
  if((stamp(turn.retry_after)??0)>now.getTime())return 'native_retry_backoff';
  return null;
 }
 async reserve(flow:RecoveryFlow,turnId:string,identity:NativeReplayIdentity):Promise<NativeDispatchDecision>{
  const turn=await this.repository.recoveryTurn(flow,turnId);
  const readonly=(reason:string):NativeDispatchDecision=>({kind:'read_only',reason,run_id:turn?.run_id??null,retry_after:turn?.retry_after?new Date(turn.retry_after).toISOString():null});
  if(!turn)return readonly('turn_not_found');
  if(!HASH.test(identity.scope_sha256)||identity.capability.supported!==true||identity.capability.durable!==true
    ||!Number.isFinite(identity.capability.retention_seconds)||identity.capability.retention_seconds<86400)return readonly('native_idempotency_unverified');
  const guard=this.guard(flow,turn,identity.scope_sha256),now=this.now();
  const reason=this.reason(turn,guard,now);if(reason)return readonly(reason);
  if(!await this.repository.reserveDispatch(turn.id,now,guard))return readonly('dispatch_reservation_changed');
  const payload=this.repository.payload(turn);
  return {kind:'dispatch',idempotency_key:'first-loop-'+turn.id,text:payload.text,instructions:payload.instructions,scope_sha256:guard.scopeHash};
 }
 async observe(flow:RecoveryFlow,raw:unknown,currentScopeSha256:string):Promise<NativeReceiptDecision>{
  const parsed=NativeRunReceiptV1.safeParse(raw);if(!parsed.success)return {kind:'pending',reason:'invalid_native_receipt'};
  const receipt=parsed.data;
  if(receipt.owner_id!==flow.user_id||receipt.business_id!==flow.business_id||receipt.session_id!==flow.session_id)return {kind:'pending',reason:'native_receipt_binding_mismatch'};
  if(receipt.idempotency_key!=='first-loop-'+receipt.turn_id)return {kind:'pending',reason:'native_turn_key_mismatch'};
  const turn=await this.repository.recoveryTurn(flow,receipt.turn_id);
  if(!turn)return {kind:'pending',reason:'turn_not_found'};
  if((turn.dispatch_attempts??0)<1)return {kind:'pending',reason:'backend_dispatch_unproven'};
  const expectedScope=turn.native_scope_hash??currentScopeSha256;
  if(!HASH.test(expectedScope)||receipt.native_scope_sha256!==expectedScope)return {kind:'pending',reason:'native_receipt_scope_mismatch'};
  const guard=this.guard(flow,turn,expectedScope);
  if(receipt.request_text_sha256!==guard.textHash||turn.native_text_sha256&&turn.native_text_sha256!==guard.textHash
    ||turn.native_body_sha256&&turn.native_body_sha256!==guard.bodyHash)return {kind:'pending',reason:'frozen_payload_changed'};
  if(turn.run_id&&turn.run_id!==receipt.run_id)return {kind:'pending',reason:'native_run_identity_conflict'};
  if(turn.native_fingerprint&&turn.native_fingerprint!==receipt.native_request_fingerprint)return {kind:'pending',reason:'native_fingerprint_conflict'};
  const payload=this.repository.payload(turn);
  if(receipt.native_request_fingerprint!==nativeRequestFingerprint(flow.session_id,payload.text,payload.instructions))return {kind:'pending',reason:'native_request_fingerprint_mismatch'};
  if(receipt.proof_gap!==null&&receipt.proof_gap!=='native_terminal_proof_unavailable')return {kind:'pending',reason:receipt.proof_gap};
  const terminal=TERMINAL.has(receipt.native_status);
  if(terminal!==receipt.terminal_proven)return {kind:'pending',reason:'native_terminal_proof_mismatch'};
  if(receipt.terminal_proven&&receipt.proof_gap!==null)return {kind:'pending',reason:'native_terminal_proof_mismatch'};
  if(turn.native_terminal_status&&terminal&&turn.native_terminal_status!==receipt.native_status)return {kind:'pending',reason:'native_terminal_identity_conflict'};
  // Positive admission still pins its original run/fingerprint after pruning.
  // Missing terminal proof is UNKNOWN, not permission to POST again or a failed run.
  const status:TurnRow['status']=terminal?(receipt.native_status==='completed'?'completed':'failed'):
    !receipt.native_record_present||receipt.proof_gap==='native_terminal_proof_unavailable'?'unknown':'running';
  if(['completed','failed'].includes(turn.status)&&terminal&&turn.status!==status)return {kind:'pending',reason:'native_terminal_identity_conflict'};
  const same=turn.run_id===receipt.run_id&&turn.native_fingerprint===receipt.native_request_fingerprint
    &&(turn.status===status||['completed','failed'].includes(turn.status));
  const saved=await this.repository.recordNativeReceipt(turn.id,{...guard,runId:receipt.run_id,fingerprint:receipt.native_request_fingerprint,
    status,observedAt:new Date(receipt.native_updated_at),terminalStatus:terminal?receipt.native_status:null});
  if(!saved)return {kind:'pending',reason:'native_receipt_write_conflict'};
  const current=await this.repository.recoveryTurn(flow,turn.id);
  return {kind:same?'replayed':'recovered',run_id:receipt.run_id,status:current?.status??status};
 }
}
