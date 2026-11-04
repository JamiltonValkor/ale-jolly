import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {loadAgentBundle} from '../src/activation/hermes-files';
import {profileFiles} from '../src/activation/profiles';

const root=join(__dirname,'../distribution/saleads-sales-agent/1.5.12');
const base=join(root,'../1.5.11');
describe('managed continuous instruction release',()=>{
  it('records immutable file provenance and a configured-user language policy',()=>{
    const manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8')) as {
      schema:string;bundle:string;base_bundle:string;instruction_language:string;response_locale:{source:string;global_default:null};
      files:Array<{path:string;sha256:string;base_sha256:string|null}>;
    };
    expect(manifest.schema).toBe('saleads-bundle-language/2');
    expect(manifest.bundle).toBe('saleads-sales-agent@1.5.12');expect(manifest.base_bundle).toBe('saleads-sales-agent@1.5.11');
    expect(manifest.instruction_language).toBe('en');expect(manifest.response_locale).toMatchObject({source:'configured_saleads_user_preference',global_default:null});
    for(const entry of manifest.files){
      expect(createHash('sha256').update(readFileSync(join(root,entry.path))).digest('hex')).toBe(entry.sha256);
      if(entry.base_sha256!==null)expect(createHash('sha256').update(readFileSync(join(base,entry.path))).digest('hex')).toBe(entry.base_sha256);
    }
  });
  it('preserves job schedules and only adds the curator when scoped managed memory is selected',()=>{
    const previous=loadAgentBundle(base,'saleads-sales-agent@1.5.11');
    const bundle=loadAgentBundle(root,'saleads-sales-agent@1.5.12');
    const routing=(jobs:typeof bundle.jobs)=>jobs.map(({name,schedule,skills})=>({name,schedule,skills}));
    expect(routing(bundle.jobs)).toEqual(routing(previous.jobs));
    expect(profileFiles(bundle,[])['profiles/curador/SOUL.md']).toBeUndefined();
    const managed=profileFiles(bundle,[],{metaSearch:true,scopedMemory:true});
    expect(managed['profiles/curador/SOUL.md']).toBe(bundle.profiles.curador);
    const curator=managed['profiles/curador/profile-config.yaml']!;
    expect(curator).toContain('include: []');expect(curator).toContain('cli: ["todo", "saleads_memory"]');
    expect(curator).not.toContain('terminal');expect(curator).not.toContain('session_search');
  });
});
