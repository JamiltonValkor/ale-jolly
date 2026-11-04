import {projectWork} from '../src/first-loop/projection';
const work={id:'11111111-1111-4111-8111-111111111111',business_id:'22222222-2222-4222-8222-222222222222',flow_id:'33333333-3333-4333-8333-333333333333',brief_revision:1,revision:1,response_locale:'en',feedback_count:0} as const;
describe('native work projection',()=>{
 it('absent projection is unknown/missing, not completed',()=>{const p=projectWork(work as never,null,'missing',new Date());expect(p.status).toBe('unknown');expect(p.projection.status).toBe('missing');});
 it('does not complete a task without a native execution and real artifact',()=>{const p=projectWork(work as never,{observed_at:new Date().toISOString(),generation:'a'.repeat(64),tasks:[{id:'t1',profile:'investigador',stage:'research',revision:1,title:'Research',status:'completed',native_status:'done',parents:[],run_refs:[],execution_verified:false,updated_at:null}],artifacts:[]},'fresh',new Date());expect(p.status).toBe('running');});
 it('outdated data is stale even when content says completed',()=>{const p=projectWork(work as never,{observed_at:'2026-10-30T00:00:00Z',generation:'a'.repeat(64),tasks:[],artifacts:[]},'fresh',new Date());expect(p.projection.status).toBe('stale');expect(p.status).not.toBe('completed');});
 it('independent completed jobs are not the promised specialist dependency chain',()=>{
  const profiles=['investigador','estratega','estructurador'];const stages=['research','strategy','structure'];
  const tasks=stages.map((stage,i)=>({id:'t'+i,profile:profiles[i],stage,revision:1,title:stage,status:'completed',native_status:'done',parents:[],run_refs:['r'+i],execution_verified:true,updated_at:null}));
  const artifacts=stages.map((stage,i)=>({id:'a'.repeat(64),task_id:'t'+i,stage,revision:1,title:stage,content_type:'text/markdown',content:'Evidence',sha256:'b'.repeat(64),bytes:8,response_locale:'en',sources:[{title:'Source',url:'https://example.org/evidence'}]}));
  const raw={observed_at:new Date().toISOString(),generation:'a'.repeat(64),tasks,artifacts};
  expect(projectWork(work as never,raw,'fresh',new Date()).status).toBe('running');
  tasks[1]!.parents=['t0'] as never;tasks[2]!.parents=['t1'] as never;
  expect(projectWork(work as never,raw,'fresh',new Date()).status).toBe('awaiting_feedback');
  artifacts[0]!.sources=[];
  expect(projectWork(work as never,raw,'fresh',new Date()).status).toBe('running');
 });

 it('preserves an explicitly adopted proposal base while real feedback advances the review revision',()=>{
  const stages=['research','strategy','structure'];const profiles=['investigador','estratega','estructurador'];
  const tasks=stages.map((stage,i)=>({id:'t-'+stage,profile:profiles[i],stage,revision:2,title:stage,status:'completed',native_status:'done',parents:i?['t-'+stages[i-1]]:[],run_refs:[String(i+1)],execution_verified:true,updated_at:null}));
  const artifacts=stages.map(stage=>({id:'a'.repeat(64),task_id:'t-'+stage,stage,revision:2,title:stage,content_type:'text/markdown',content:'Supported proposal',sha256:'b'.repeat(64),bytes:18,response_locale:'en',sources:[{title:'Source',url:'https://example.org/evidence'}]}));
  const raw={observed_at:new Date().toISOString(),generation:'a'.repeat(64),tasks,artifacts};
  const registered={...work,brief_revision:2};
  // Actual marker drift is not silently normalized into readiness.
  expect(projectWork(registered as never,raw,'fresh',new Date()).status).toBe('running');
  const adopted={...registered,revision:2};
  expect(projectWork(adopted as never,raw,'fresh',new Date()).status).toBe('awaiting_feedback');
  const reviewed={...adopted,revision:3,feedback_count:1};
  tasks.push({id:'t-analysis',profile:'analista',stage:'analysis',revision:3,title:'Analysis',status:'completed',native_status:'done',parents:['t-structure'],run_refs:['4'],execution_verified:true,updated_at:null});
  tasks.push({id:'t-optimization',profile:'optimizador',stage:'optimization',revision:3,title:'Optimization',status:'completed',native_status:'done',parents:['t-analysis'],run_refs:['5'],execution_verified:true,updated_at:null});
  for(const stage of ['analysis','optimization'])artifacts.push({...artifacts[0]!,task_id:'t-'+stage,stage,revision:3});
  expect(projectWork(reviewed as never,raw,'fresh',new Date()).status).toBe('completed');
  tasks.at(-1)!.parents=[];
  expect(projectWork(reviewed as never,raw,'fresh',new Date()).status).toBe('reviewing');
  tasks.at(-1)!.parents=['t-analysis'];tasks.at(-1)!.revision=2;
  expect(projectWork(reviewed as never,raw,'fresh',new Date()).status).toBe('reviewing');
 });

});
