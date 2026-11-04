import {startTestDatabase,type TestDatabase} from './support/pglite-db';
import {randomBytes,createHash} from 'node:crypto';
import {StoredWorkProjection} from '../src/first-loop/projection';
import {FirstLoopRepository} from '../src/first-loop/repository';
import {FieldCipher} from '../src/security/field-cipher';
const owner='owner-test',biz='11111111-1111-4111-8111-111111111111';
describe('first loop durable repository',()=>{
 let pg:TestDatabase,repo:FirstLoopRepository;
 beforeAll(async()=>{pg=await startTestDatabase();repo=new FirstLoopRepository(pg.database,new FieldCipher(randomBytes(32)));});
 afterAll(async()=>pg.close());
 it('reuses owner/business flow without changing classic session state',async()=>{const a=await repo.ensureFlow(owner,biz,'en');const b=await repo.ensureFlow(owner,biz,'es');expect(b.id).toBe(a.id);expect(b.response_locale).toBe('es');expect(b.session_id).not.toBe('saleads-main');});
 it('encrypts accepted request and rejects duplicate digest mismatches',async()=>{const f=await repo.ensureFlow(owner,biz,'en');const p={text:'private owner request',instructions:'trusted context'};const a=await repo.reserveTurn(f,'22222222-2222-4222-8222-222222222222','message','hash-a',p,null);expect(repo.payload(a)).toEqual(p);const b=await repo.reserveTurn(f,a.client_message_id,'message','hash-b',p,null);expect(b.request_hash).toBe('hash-a');const q=await pg.database.pool.query('SELECT payload_enc FROM assistant.first_loop_turns');expect(String(q.rows[0]?.payload_enc)).not.toContain(p.text);});
 it('persists unknown receipt when no native run id was acknowledged',async()=>{const f=(await repo.flow(owner,biz))!;const t=(await repo.turns(f.id))[0]!;await repo.setRun(t.id,null,'unknown');expect((await repo.turns(f.id))[0]!.status).toBe('unknown');});

 it('persists and reopens a valid multi-artifact projection above 32 KiB',async()=>{
  const f=(await repo.flow(owner,biz))!;
  const client='22222222-2222-4222-8222-222222222222';
  await repo.saveBrief(f,1,{goal:'Synthetic goal',offering:null,market:null,constraints:[],owner_message_ids:[client],owner_quotes:[{client_message_id:client,quote:'Synthetic goal'}]},[]);
  const work=(await repo.createWork((await repo.flow(owner,biz))!))!;
  const content='Supported artifact text. '.repeat(2000),hash=createHash('sha256').update(content).digest('hex');
  const artifacts=Array.from({length:3},(_,i)=>({id:hash,task_id:'task-'+i,stage:'research',revision:1,title:'Synthetic artifact',content_type:'text/markdown',content,sha256:hash,bytes:Buffer.byteLength(content),response_locale:'en',sources:[{title:'Source',url:'https://example.org/source'}]}));
  const projection=StoredWorkProjection.parse({observed_at:new Date().toISOString(),generation:'a'.repeat(64),tasks:[],artifacts});
  expect(Buffer.byteLength(JSON.stringify(projection),'utf8')).toBeGreaterThan(32*1024);
  await repo.saveProjection(work,projection.generation,new Date(projection.observed_at),projection);
  const stored=(await repo.work(owner,biz,work.id))!;expect(repo.projection(stored)).toEqual(projection);
 });

});
