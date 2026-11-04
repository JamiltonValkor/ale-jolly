import {randomBytes} from 'node:crypto';
import {NotificationRepository} from '../src/notifications/repository';
import {NotificationCollector} from '../src/notifications/collector';
import {NotificationProjection} from '../src/notifications/projection';
import {FieldCipher} from '../src/security/field-cipher';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';

const binding = {owner_id: 'fixture-owner', business_id: '11111111-1111-4111-8111-111111111111', session_id: 'session-fixture', job_id: 'job-fixture', response_locale: 'pt', locale_revision: 2};
const result = {job_id: binding.job_id, execution_id: 'execution-fixture', source_version: '1', response_locale: 'pt', locale_revision: 2, text: 'A pesquisa terminou; confira as fontes na proposta.', terminal_state: 'completed' as const, limitations: [], finished_at: '2026-11-03T12:00:00Z'};
describe('native notification ledger and browser projection', () => {
  let pg: TestDatabase, repo: NotificationRepository, collector: NotificationCollector;
  beforeAll(async () => {pg = await startTestDatabase(); repo = new NotificationRepository(pg.database, new FieldCipher(randomBytes(32))); collector = new NotificationCollector(repo); await repo.bindJob(binding);});
  afterAll(async () => pg.close());

  it('captures a terminal result once, separately from actual delivery', async () => {
    const saved = await collector.collect(binding.owner_id, result);
    expect(saved.kind).toBe('saved');
    expect((await collector.collect(binding.owner_id, result)).kind).toBe('replayed');
    expect(await repo.conversation(binding.owner_id, binding.business_id, binding.session_id)).toEqual([]);
    expect(await repo.conversation('other', binding.business_id, binding.session_id)).toEqual([]);
  });

  it('does not assign unknown jobs, stale language or non-visible native output to a business', async () => {
    for (const patch of [{job_id: 'unknown-job'}, {response_locale: 'es'}, {locale_revision: 1}, {text: '[SILENT]'}, {text: '{"internal":"task-result"}'}, {text: '[kanban] Task completed'}]) {
      expect((await collector.collect(binding.owner_id, {...result, ...patch})).kind).toBe('pending');
    }
    expect((await collector.collect('other', result)).kind).toBe('pending');
  });

  it('projects the same notice once on confirmed failure or no home, including after restart', async () => {
    const first = await collector.collect(binding.owner_id, result);
    if (first.kind === 'pending') throw new Error('missing fixture');
    await repo.deliverInSaleads(binding.owner_id, first.notification_id, 'no_home');
    await repo.deliverInSaleads(binding.owner_id, first.notification_id, 'no_home');
    const restarted = new NotificationCollector(repo);
    expect((await restarted.collect(binding.owner_id, result)).kind).toBe('replayed');
    const events = await repo.conversation(binding.owner_id, binding.business_id, binding.session_id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({text: result.text, role: 'assistant', source: 'scheduled', message_id: first.notification_id});
    expect(await repo.conversation(binding.owner_id, binding.business_id, 'other-session')).toEqual([]);
    expect(await repo.conversation(binding.owner_id, binding.business_id, binding.session_id, events[0]!.cursor)).toEqual([]);
    expect(JSON.stringify(events)).not.toContain('job_id');
    expect(JSON.stringify(events)).not.toContain('locale_revision');
  });

  it('rejects source mutation and retains uncertain acknowledgement without blind retransmission', async () => {
    expect((await collector.collect(binding.owner_id, {...result, text: 'Changed output with same native identity'})).kind).toBe('pending');
    const notice = await collector.collect(binding.owner_id, {...result, execution_id: 'execution-home'});
    if (notice.kind === 'pending') throw new Error('missing fixture');
    await repo.recordHomeReceipt(binding.owner_id, notice.notification_id, {attempt_id: 'attempt-home', destination_version: 'telegram-v1', state: 'unknown', evidence_ref: 'native:execution-home', reconcile_by: '2026-11-02T12:02:00Z'});
    expect((await repo.receipts(binding.owner_id, notice.notification_id))[0]!.state).toBe('unknown');
    expect(await repo.conversation(binding.owner_id, binding.business_id, binding.session_id)).toHaveLength(1);
    await repo.recordHomeReceipt(binding.owner_id, notice.notification_id, {attempt_id: 'attempt-home', destination_version: 'telegram-v1', state: 'delivered', evidence_ref: 'native:execution-home', reconcile_by: null});
    await expect(repo.deliverInSaleads(binding.owner_id, notice.notification_id, 'no_home')).rejects.toThrow('home_delivery_confirmed');
  });
  it('recovers an expired uncertain delivery after restart even when its VM object is gone or cloud refresh fails',async()=>{
    const notice=await collector.collect(binding.owner_id,{...result,execution_id:'execution-lost-object'});
    if(notice.kind==='pending')throw new Error('missing fixture');
    await repo.recordHomeReceipt(binding.owner_id,notice.notification_id,{attempt_id:'attempt-lost',destination_version:'home-v1',
      state:'unknown',evidence_ref:'native:execution-lost-object',reconcile_by:'2026-11-01T00:00:00Z'});
    const storage={signedPutUrl:async()=> 'https://storage.googleapis.com/fixture/object',download:async()=>null,upload:async()=>{}};
    const instances={getInstance:async()=>({fingerprint:'f',items:[]}),setMetadata:async()=>{}};
    const row={user_id:binding.owner_id,instance_name:'fixture-vm'};
    const projection=new NotificationProjection(repo,storage,instances as never);
    expect((await projection.messages(row as never,binding.business_id,binding.session_id)).map(n=>n.message_id)).toContain(notice.notification_id);
    const unavailable=new NotificationProjection(repo,{...storage,signedPutUrl:async()=>{throw new Error('cloud unavailable');}},instances as never);
    expect((await unavailable.messages(row as never,binding.business_id,binding.session_id)).map(n=>n.message_id)).toContain(notice.notification_id);
  });
  it('retains ordinary owner-facing Markdown citations',async()=>{
    expect((await collector.collect(binding.owner_id,{...result,execution_id:'execution-citation',text:'[Relatório](https://example.org/report): pesquisa concluída.'})).kind).toBe('saved');
  });
});
