import {FirstLoopMessageRequestV1, FirstLoopKickoffRequestV1, FirstLoopWorkV1, firstLoopContext} from '../src/first-loop/contracts';
const id='11111111-1111-4111-8111-111111111111';
describe('first loop contracts',()=>{
 it('requires contextual idempotent messages and rejects browser identity',()=>{
  expect(FirstLoopMessageRequestV1.safeParse({flow_id:id,client_message_id:id,text:'Hello',response_locale:'en'}).success).toBe(true);
  expect(FirstLoopMessageRequestV1.safeParse({flow_id:id,client_message_id:id,text:'Hello',response_locale:'en',user_id:id}).success).toBe(false);
 });
 it('kickoff accepts only a confirmed persisted revision',()=>{
  expect(FirstLoopKickoffRequestV1.safeParse({flow_id:id,brief_revision:1}).success).toBe(true);
  expect(FirstLoopKickoffRequestV1.safeParse({flow_id:id,brief_revision:1,goal:'alternate'}).success).toBe(false);
 });
 it('context uses server-generated business/flow and fixed local paths',()=>{
  const c=firstLoopContext({businessId:id,flowId:id,sessionId:'flow-test',locale:'es',revision:2});
  expect(c).toContain('response_locale: es');expect(c).toContain('/opt/data/saleads/first-loop/flows/'+id+'/brief.json');
  expect(c).not.toContain('saleads-main');expect(c).toContain('next_brief_revision: 3');expect(c).toContain('"owner_quotes"');expect(c).toContain('"additionalProperties":false');
 });
 it('never interprets no snapshot as completed work',()=>{
  expect(FirstLoopWorkV1.safeParse({}).success).toBe(false);
 });
 it.each(['es','en'] as const)('keeps deferred budget and unavailable proof as proposal constraints in %s',locale=>{
  const c=firstLoopContext({businessId:id,flowId:id,sessionId:'flow-test',locale,revision:1});
  expect(c).toContain('Paid-media budget and supporting proof are optional for this proposal-only first work');
  expect(c).toContain('record that limitation in brief.constraints, not missing_fields');
  expect(c).toContain('missing_fields includes only genuinely necessary, unanswered information for this proposal');
  expect(c).toContain('Never require later campaign-stage budget, authorization or evidence collection to confirm this brief');
  expect(c).toContain('Do not invent proof or present hypotheses as demonstrated results');
 });
 it('requires a complete next-revision brief and semantic readback before claiming readiness',()=>{
  const c=firstLoopContext({businessId:id,flowId:id,sessionId:'flow-test',locale:'en',revision:1});
  expect(c).toContain('replace the complete JSON document with next_brief_revision');
  expect(c).toContain('any patch must update brief_revision to next_brief_revision in the same atomic edit');
  expect(c).toContain('Read back the resulting JSON once to check its exact next revision and missing_fields');
  expect(c).toContain('a successful file write alone does not mean the backend accepted it');
  expect(c).toContain('Task marker revision is exactly work_revision, never brief_revision or next_brief_revision');
 });
});
