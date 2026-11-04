import {z} from 'zod';
import {FirstLoopArtifactV1, FirstLoopTaskV1, FirstLoopWorkV1, type FirstLoopWork} from './contracts';
import type {WorkRow} from './repository';
export const StoredWorkProjection=z.object({observed_at:z.iso.datetime({offset:true}),generation:z.string().regex(/^[a-f0-9]{64}$/),tasks:z.array(FirstLoopTaskV1).max(100),artifacts:z.array(FirstLoopArtifactV1).max(100)}).strict();
export function projectWork(work:WorkRow,raw:unknown,availability:FirstLoopWork['projection']['status'],now:Date):FirstLoopWork{
 const parsed=StoredWorkProjection.safeParse(raw);const p=parsed.success?parsed.data:null;
 const freshness=!p&&availability==='fresh'?'missing':p&&now.getTime()-Date.parse(p.observed_at)>120000?'stale':availability;
 const tasks=p?.tasks??[];const artifacts=p?.artifacts??[];
 const profiles:Record<string,string>={research:'investigador',strategy:'estratega',structure:'estructurador',analysis:'analista',optimization:'optimizador'};
 const completed=(stage:string,revision:number)=>tasks.filter(t=>t.stage===stage&&t.profile===profiles[stage]&&t.revision===revision&&t.status==='completed'&&t.execution_verified&&t.run_refs.length>0&&artifacts.some(a=>a.task_id===t.id&&a.stage===stage&&a.revision===revision&&a.content.trim().length>0&&(stage!=='research'||a.sources.length>0)));
 // Feedback advances both counters, preserving the initial proposal revision.
 const proposalRevision=work.revision-work.feedback_count;
 const proposal=completed('research',proposalRevision).some(r=>completed('strategy',proposalRevision).some(s=>s.parents.includes(r.id)&&completed('structure',proposalRevision).some(t=>t.parents.includes(s.id))));
 const review=proposal&&work.feedback_count>0&&completed('analysis',work.revision).some(a=>completed('optimization',work.revision).some(o=>o.parents.includes(a.id)));
 const status=!p?'unknown':tasks.some(t=>t.status==='failed'||t.status==='blocked')?'blocked':review?'completed':work.feedback_count>0?'reviewing':proposal?'awaiting_feedback':tasks.length?'running':'waiting_for_tasks';
 return FirstLoopWorkV1.parse({schema_version:'first-loop/1',work_id:work.id,business_id:work.business_id,flow_id:work.flow_id,brief_revision:work.brief_revision,revision:work.revision,response_locale:work.response_locale,status,projection:{status:freshness,observed_at:p?.observed_at??null,cursor:p?.generation??null},tasks,artifacts,feedback_count:work.feedback_count,delivery:artifacts.length?'available':'pending'});
}
