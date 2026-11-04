import {randomBytes,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {FirstLoopRepository,type FlowRow,type TurnPayload,type TurnRow} from '../src/first-loop/repository';
import {NativeTurnRecovery,NATIVE_REPLAY_HORIZON_MS,nativeApiScopeSha256,nativeTurnTextSha256,nativeRequestFingerprint,type NativeRunReceiptV1} from '../src/first-loop/native-recovery';
import {FieldCipher} from '../src/security/field-cipher';
import {startTestDatabase,type TestDatabase} from './support/pglite-db';

const OWNER='recovery-fixture-owner';
const BUSINESS='11111111-1111-4111-8111-111111111111';
const OTHER='22222222-2222-4222-8222-222222222222';
const SCOPE=nativeApiScopeSha256('synthetic-api-key');
const identity={scope_sha256:SCOPE,capability:{supported:true,durable:true,retention_seconds:86400}};
const runId='run_'+'a'.repeat(32);

describe('bounded native retry and positive read-only receipt recovery',()=>{
 let pg:TestDatabase,repo:FirstLoopRepository,cipher:FieldCipher,flow:FlowRow,clock:Date,recovery:NativeTurnRecovery;
 beforeAll(async()=>{pg=await startTestDatabase();cipher=new FieldCipher(randomBytes(32));repo=new FirstLoopRepository(pg.database,cipher);flow=await repo.ensureFlow(OWNER,BUSINESS,'en');});
 afterAll(async()=>pg.close());
 beforeEach(()=>{clock=new Date();recovery=new NativeTurnRecovery(repo,()=>clock);});
 async function fresh(payload:TurnPayload={text:'Synthetic business request 😀.',instructions:'Trusted immutable server instructions.'}):Promise<TurnRow>{
  return repo.reserveTurn(flow,randomUUID(),'message','c'.repeat(64),payload,null);
 }
 const advance=(milliseconds:number)=>{clock=new Date(clock.getTime()+milliseconds);};
 function receipt(turn:TurnRow,patch:Partial<NativeRunReceiptV1>={}):NativeRunReceiptV1{
  return {schema_version:'native-run-receipt/1',owner_id:OWNER,business_id:BUSINESS,session_id:flow.session_id,
   turn_id:turn.id,idempotency_key:'first-loop-'+turn.id,run_id:runId,
   request_text_sha256:nativeTurnTextSha256(repo.payload(turn).text),native_scope_sha256:SCOPE,native_request_fingerprint:nativeRequestFingerprint(flow.session_id,repo.payload(turn).text,repo.payload(turn).instructions),
   accepted_at:clock.toISOString(),native_created_at:clock.toISOString(),native_updated_at:clock.toISOString(),status_observed_at:clock.toISOString(),
   native_status:'completed',terminal_proven:true,native_record_present:false,proof_gap:null,...patch};
 }
 it('V17 anchors genuinely old attempts to created_at without resetting time or rewriting payload/status',async()=>{
  const turn=await fresh();const created=new Date(clock.getTime()-25*60*60*1000);
  await pg.database.pool.query('UPDATE assistant.first_loop_turns SET created_at=$2,dispatch_attempts=6,status=$3 WHERE id=$1',[turn.id,created,'unknown']);
  await pg.database.pool.query(`ALTER TABLE assistant.first_loop_turns DROP COLUMN first_dispatch_at,
   DROP COLUMN native_scope_hash,DROP COLUMN native_text_sha256,DROP COLUMN native_body_sha256,
   DROP COLUMN native_fingerprint,DROP COLUMN native_observed_at,DROP COLUMN native_terminal_status`);
  const migration=readFileSync(join(__dirname,'../migrations/V17__native_turn_recovery.sql'),'utf8').replace(/^\s*--.*$/gm,'');
  for(const statement of migration.split(';').filter(sql=>sql.trim()))await pg.database.pool.query(statement);
  const migrated=(await repo.recoveryTurn(flow,turn.id))!;
  expect(new Date(migrated.first_dispatch_at!).getTime()).toBe(created.getTime());
  expect(migrated.dispatch_attempts).toBe(6);expect(migrated.status).toBe('unknown');expect(repo.payload(migrated)).toEqual(repo.payload(turn));
  expect(migrated.native_scope_hash).toBeNull();
  expect(await recovery.reserve(flow,turn.id,identity)).toMatchObject({kind:'read_only',reason:'native_replay_horizon_elapsed'});
  expect(new Date((await repo.recoveryTurn(flow,turn.id))!.first_dispatch_at!).getTime()).toBe(created.getTime());
 });
 it('can recover more than four lost acknowledgements with one frozen key/body inside the native window',async()=>{
  const turn=await fresh(),keys=new Set<string>(),bodies=new Set<string>(),first=clock.getTime();
  for(let attempt=0;attempt<8;attempt++){
   const result=await recovery.reserve(flow,turn.id,identity);expect(result.kind).toBe('dispatch');
   if(result.kind!=='dispatch')throw new Error('fixture unexpectedly blocked');
   keys.add(result.idempotency_key);bodies.add(JSON.stringify([result.text,result.instructions]));
   await repo.setRun(turn.id,null,'unknown');advance(310000);
  }
  const saved=(await repo.recoveryTurn(flow,turn.id))!;
  expect(saved.dispatch_attempts).toBe(8);expect(keys.size).toBe(1);expect(bodies.size).toBe(1);
  expect(new Date(saved.first_dispatch_at!).getTime()).toBe(first);
  expect(new Date(saved.retry_after!).getTime()-new Date(clock.getTime()-310000).getTime()).toBe(300000);
 });
 it('enforces backoff atomically across independent backend instances',async()=>{
  const turn=await fresh();
  const results=await Promise.all([recovery.reserve(flow,turn.id,identity),new NativeTurnRecovery(repo,()=>clock).reserve(flow,turn.id,identity)]);
  expect(results.filter(result=>result.kind==='dispatch')).toHaveLength(1);
  expect((await repo.recoveryTurn(flow,turn.id))!.dispatch_attempts).toBe(1);
  advance(19000);expect((await recovery.reserve(flow,turn.id,identity)).kind).toBe('read_only');
  advance(1000);expect((await recovery.reserve(flow,turn.id,identity)).kind).toBe('dispatch');
 });
 it('never proposes a POST after the conservative horizon or invents a failed process from age',async()=>{
  const turn=await fresh(),send=jest.fn();
  const dispatch=async()=>{const next=await recovery.reserve(flow,turn.id,identity);if(next.kind==='dispatch')send(next);return next;};
  await dispatch();await repo.setRun(turn.id,null,'unknown');
  advance(NATIVE_REPLAY_HORIZON_MS);
  expect(await dispatch()).toMatchObject({kind:'read_only',reason:'native_replay_horizon_elapsed'});
  advance(48*60*60*1000);await dispatch();
  expect(send).toHaveBeenCalledTimes(1);expect((await repo.recoveryTurn(flow,turn.id))!.status).toBe('unknown');
 });
 it('refuses changed credentials/profile scope and unverified native retention without altering the first namespace',async()=>{
  const turn=await fresh();await recovery.reserve(flow,turn.id,identity);advance(310000);
  const rotated={...identity,scope_sha256:nativeApiScopeSha256('rotated-synthetic-key')};
  expect(await recovery.reserve(flow,turn.id,rotated)).toMatchObject({kind:'read_only',reason:'native_scope_changed'});
  const profile={...identity,scope_sha256:nativeApiScopeSha256('synthetic-api-key','other-profile')};
  expect(await recovery.reserve(flow,turn.id,profile)).toMatchObject({kind:'read_only',reason:'native_scope_changed'});
  const another=await fresh();
  for(const capability of [{supported:false,durable:true,retention_seconds:86400},{supported:true,durable:false,retention_seconds:86400},{supported:true,durable:true,retention_seconds:3600}]){
   expect(await recovery.reserve(flow,another.id,{...identity,capability})).toMatchObject({kind:'read_only',reason:'native_idempotency_unverified'});
  }
  expect((await repo.recoveryTurn(flow,turn.id))!.native_scope_hash).toBe(SCOPE);
  expect((await repo.recoveryTurn(flow,another.id))!.dispatch_attempts).toBe(0);
 });
 it.each(['text','instructions'] as const)('rejects mutation of frozen %s before retry or receipt adoption',async(field)=>{
  const turn=await fresh();await recovery.reserve(flow,turn.id,identity);const proof=receipt(turn);
  const body={...repo.payload(turn),[field]:'Changed synthetic body.'};
  await pg.database.pool.query('UPDATE assistant.first_loop_turns SET payload_enc=$2 WHERE id=$1',[turn.id,cipher.seal('first_loop.turn',OWNER,JSON.stringify(body))]);
  advance(310000);
  expect(await recovery.reserve(flow,turn.id,identity)).toMatchObject({kind:'read_only',reason:'frozen_payload_changed'});
  expect(await recovery.observe(flow,proof,SCOPE)).toMatchObject({kind:'pending',reason:'frozen_payload_changed'});
  expect((await repo.recoveryTurn(flow,turn.id))!.run_id).toBeNull();
 });
 it('recovers an actual copied terminal receipt after expiry and preserves it across backend restart',async()=>{
  const turn=await fresh();await recovery.reserve(flow,turn.id,identity);await repo.setRun(turn.id,null,'unknown');
  const proof=receipt(turn);advance(25*60*60*1000);
  expect(await recovery.observe(flow,proof,SCOPE)).toMatchObject({kind:'recovered',run_id:runId,status:'completed'});
  expect(await new NativeTurnRecovery(repo,()=>clock).observe(flow,proof,SCOPE)).toMatchObject({kind:'replayed',status:'completed'});
  expect(await recovery.reserve(flow,turn.id,identity)).toMatchObject({kind:'read_only',reason:'terminal_known'});
 });
 it('rejects first admission when the same text/key accepted different instructions or body fields',async()=>{
  const turn=await fresh();await recovery.reserve(flow,turn.id,identity);
  const wrong=nativeRequestFingerprint(flow.session_id,repo.payload(turn).text,'Different accepted instructions.');
  expect(await recovery.observe(flow,receipt(turn,{native_request_fingerprint:wrong}),SCOPE)).toMatchObject({kind:'pending',reason:'native_request_fingerprint_mismatch'});
  expect((await repo.recoveryTurn(flow,turn.id))!.run_id).toBeNull();
 });
 it('pins positive admission but retains UNKNOWN when the native record and terminal proof are unavailable',async()=>{
  const turn=await fresh();await recovery.reserve(flow,turn.id,identity);await repo.setRun(turn.id,null,'unknown');
  advance(25*60*60*1000);
  const proof=receipt(turn,{native_status:'running',terminal_proven:false,native_record_present:false,proof_gap:'native_terminal_proof_unavailable'});
  expect(await recovery.observe(flow,proof,SCOPE)).toMatchObject({kind:'recovered',run_id:runId,status:'unknown'});
  expect((await repo.recoveryTurn(flow,turn.id))!.native_fingerprint).toBe(receipt(turn).native_request_fingerprint);
  expect(await recovery.reserve(flow,turn.id,identity)).toMatchObject({kind:'read_only',reason:'native_run_known'});
 });
 it('never replaces a known run, fingerprint or terminal fact with a conflicting receipt or stale running copy',async()=>{
  const turn=await fresh();await recovery.reserve(flow,turn.id,identity);const proof=receipt(turn);
  await recovery.observe(flow,proof,SCOPE);
  expect(await recovery.observe(flow,{...proof,run_id:'run_'+'d'.repeat(32)},SCOPE)).toMatchObject({kind:'pending',reason:'native_run_identity_conflict'});
  expect(await recovery.observe(flow,{...proof,native_request_fingerprint:'e'.repeat(64)},SCOPE)).toMatchObject({kind:'pending',reason:'native_fingerprint_conflict'});
  expect(await recovery.observe(flow,{...proof,native_status:'failed'},SCOPE)).toMatchObject({kind:'pending',reason:'native_terminal_identity_conflict'});
  advance(3600000);
  expect(await recovery.observe(flow,{...proof,native_status:'running',terminal_proven:false,native_record_present:true,native_updated_at:clock.toISOString()},SCOPE)).toMatchObject({kind:'replayed',status:'completed'});
  await repo.setRun(turn.id,'run_'+'f'.repeat(32),'running');await repo.setRun(turn.id,null,'unknown');
  const saved=(await repo.recoveryTurn(flow,turn.id))!;expect(saved.run_id).toBe(runId);expect(saved.status).toBe('completed');expect(saved.native_fingerprint).toBe(receipt(turn).native_request_fingerprint);
 });
 it('rejects wrong owner/business/session/turn key/text hash/scope and identity proof gaps',async()=>{
  const turn=await fresh();await recovery.reserve(flow,turn.id,identity);const proof=receipt(turn);
  for(const patch of [{owner_id:'other-owner'},{business_id:OTHER},{session_id:'foreign-session'},{idempotency_key:'first-loop-'+randomUUID()},
    {request_text_sha256:'0'.repeat(64)},{native_scope_sha256:'1'.repeat(64)},{proof_gap:'native_turn_identity_conflict'}]){
   expect((await recovery.observe(flow,{...proof,...patch},SCOPE)).kind).toBe('pending');
  }
  expect(await recovery.reserve({...flow,business_id:OTHER},turn.id,identity)).toMatchObject({kind:'read_only',reason:'turn_not_found'});
  expect(await recovery.observe({...flow,business_id:OTHER},{...proof,business_id:OTHER},SCOPE)).toMatchObject({kind:'pending',reason:'turn_not_found'});
  expect((await repo.recoveryTurn(flow,turn.id))!.run_id).toBeNull();
 });
 it('does not guess a legacy historical key but can adopt an authenticated compatible late receipt read-only',async()=>{
  const turn=await fresh();await pg.database.pool.query("UPDATE assistant.first_loop_turns SET dispatch_attempts=5,status='unknown',first_dispatch_at=created_at WHERE id=$1",[turn.id]);
  advance(1000);
  expect(await recovery.reserve(flow,turn.id,identity)).toMatchObject({kind:'read_only',reason:'legacy_native_scope_unproven'});
  expect(await recovery.observe(flow,receipt(turn),SCOPE)).toMatchObject({kind:'recovered',status:'completed'});
 });
 it('accepts the original pinned-scope proof read-only after a key rotation, without authorizing a new-scope replay',async()=>{
  const turn=await fresh();await recovery.reserve(flow,turn.id,identity);advance(310000);
  const rotated=nativeApiScopeSha256('rotated-synthetic-key');
  expect(await recovery.reserve(flow,turn.id,{...identity,scope_sha256:rotated})).toMatchObject({kind:'read_only',reason:'native_scope_changed'});
  expect(await recovery.observe(flow,receipt(turn),rotated)).toMatchObject({kind:'recovered',status:'completed'});
  expect((await repo.recoveryTurn(flow,turn.id))!.native_scope_hash).toBe(SCOPE);
 });
 it('a positive terminal proof outranks an out-of-order running observation without using age as evidence',async()=>{
  const turn=await fresh();await recovery.reserve(flow,turn.id,identity);const terminal=receipt(turn);
  advance(60000);
  await recovery.observe(flow,receipt(turn,{native_status:'running',terminal_proven:false,native_record_present:true}),SCOPE);
  expect(await recovery.observe(flow,terminal,SCOPE)).toMatchObject({kind:'recovered',status:'completed'});
 });
});
