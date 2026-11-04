import {createHash} from 'node:crypto';
import {z} from 'zod';
import {NotificationV1, ResponseLocaleV1} from '../contracts/continuous-loop';
import type {NotificationRepository} from './repository';

export const NativeResultV1 = z.object({
  job_id:z.string().min(1).max(200),execution_id:z.string().min(1).max(200),source_version:z.string().min(1).max(200),
  response_locale:ResponseLocaleV1,locale_revision:z.number().int().positive(),
  text:z.string().trim().min(1).max(16000),terminal_state:z.enum(['completed','partial']),
  limitations:z.array(z.string().min(1).max(500)).max(10),finished_at:z.iso.datetime({offset:true}),
}).strict();
type Collected = {kind:'saved'|'replayed';notification_id:string} | {kind:'pending';reason:string};

/** No model or transport is invoked here. Its input is the corroborated native projection. */
export class NotificationCollector {
  constructor(private readonly repository:NotificationRepository) {}
  async collect(owner:string,input:unknown):Promise<Collected> {
    const parsed=NativeResultV1.safeParse(input);
    if (!parsed.success) return {kind:'pending',reason:'invalid_projection'};
    const result=parsed.data;
    const binding=await this.repository.binding(owner,result.job_id);
    if (!binding) return {kind:'pending',reason:'unknown_job_binding'};
    if (binding.response_locale!==result.response_locale || binding.locale_revision!==result.locale_revision) return {kind:'pending',reason:'stale_locale'};
    let structured=false;
    if(result.text.startsWith('{')||result.text.startsWith('[')){try{const parsed:unknown=JSON.parse(result.text);structured=typeof parsed==='object'&&parsed!==null;}catch{/* A Markdown citation is ordinary visible text. */}}
    if (structured || /^(?:\[?SILENT\]?|\[kanban\]|```json(?:\s|$)|<(?:think|analysis)>)/i.test(result.text) || /Bearer\s+[A-Za-z0-9._-]{20,}|LLM_[A-Za-z0-9_]{12,}|-----BEGIN .*PRIVATE KEY/.test(result.text)) return {kind:'pending',reason:'not_visible_output'};
    if (result.terminal_state==='partial'&&!result.limitations.length) return {kind:'pending',reason:'unexplained_partial'};
    const notification_id=createHash('sha256').update(JSON.stringify([owner,binding.business_id,result.job_id,result.execution_id,result.source_version])).digest('hex');
    const notice=NotificationV1.parse({schema_version:'notification/1',notification_id,owner_id:owner,business_id:binding.business_id,
      session_id:binding.session_id,source_id:result.job_id,execution_id:result.execution_id,source_version:result.source_version,
      source_kind:'cron_result',text:result.text,response_locale:result.response_locale,terminal_state:result.terminal_state,
      limitations:result.limitations,created_at:result.finished_at});
    const saved=await this.repository.save(notice);
    return saved==='mutation'?{kind:'pending',reason:'source_mutation'}:{kind:saved,notification_id};
  }
}
