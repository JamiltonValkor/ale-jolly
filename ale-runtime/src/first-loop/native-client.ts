import type {OutboundFetch} from '../outbound/http-client';
import {serviceUnavailable} from '../domain/errors';
import type {HermesTarget} from '../hermes/hermes-client';
import type {NativeReplayCapability} from './native-recovery';
export interface NativeRunClient {
 start(target:HermesTarget,session:string,text:string,instructions:string,key:string):Promise<{run_id:string;status:string}>;
 status(target:HermesTarget,run:string):Promise<string>;
 capabilities?(target:HermesTarget):Promise<NativeReplayCapability|null>;
}
const ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
export class HttpFirstLoopRuns implements NativeRunClient {
 constructor(private readonly fetcher:OutboundFetch,private readonly port=8642){}
 private async request(target:HermesTarget,path:string,body?:unknown,key?:string):Promise<Record<string,unknown>>{
  if(!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(target.ip))throw serviceUnavailable();
  const r=await this.fetcher(`http://${target.ip}:${this.port}${path}`,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${target.apiServerKey}`,'content-type':'application/json',...(key?{'Idempotency-Key':key}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  if(!r.ok){await r.arrayBuffer().catch(()=>undefined);throw serviceUnavailable();}
  return await r.json() as Record<string,unknown>;
 }
 async start(target:HermesTarget,session:string,text:string,instructions:string,key:string):Promise<{run_id:string;status:string}>{
  if(!ID.test(session)||!ID.test(key))throw serviceUnavailable();
  const b=await this.request(target,'/v1/runs',{input:text,session_id:session,instructions},key);
  if(typeof b.run_id!=='string'||!ID.test(b.run_id)||typeof b.status!=='string')throw serviceUnavailable();
  return {run_id:b.run_id,status:b.status};
 }
 async status(target:HermesTarget,run:string):Promise<string>{if(!ID.test(run))throw serviceUnavailable();const b=await this.request(target,`/v1/runs/${encodeURIComponent(run)}`);return typeof b.status==='string'?b.status:'unknown';}
 async capabilities(target:HermesTarget):Promise<NativeReplayCapability|null>{
  const body=await this.request(target,'/v1/capabilities');
  const features=body.features&&typeof body.features==='object'?body.features as Record<string,unknown>:null;
  const raw=features?.runs_idempotency;
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
  const value=raw as Record<string,unknown>;
  if(typeof value.supported!=='boolean'||typeof value.durable!=='boolean'||typeof value.retention_seconds!=='number'||!Number.isFinite(value.retention_seconds))return null;
  return {supported:value.supported,durable:value.durable,retention_seconds:value.retention_seconds};
 }
}
