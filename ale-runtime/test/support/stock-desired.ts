import {gunzipSync} from 'node:zlib';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {loadAgentBundle, withCliConfig, type AgentBundle} from '../../src/activation/hermes-files';
import type {HermesMetadata} from '../../src/compute/metadata';
import {OrqaSync, type OrqaSyncDeps, type OrqaSyncOptions} from '../../src/orqa/orqa-sync';
import type {AssistantRow} from '../../src/persistence/assistant-repository';
import {SkillsWriter} from '../../src/skills/skills-writer';
import {setup, USER} from './orqa-fakes';

/** Bundle que usa dev, con la configuración del CLI, como en `main.ts`. */
export function realBundle(): AgentBundle {
  return withCliConfig(loadAgentBundle('distribution/saleads-sales-agent/1.5.13', 'saleads-sales-agent@1.5.13'),
    {url: 'https://dev.saleads.ai/mcp', clientId: 'mcp-saleads-assistant-dev', webUrl: 'https://dev.saleads.ai'});
}

export const META_OPTIONS: Partial<OrqaSyncOptions> = {managedMeta: {enabled: true, userId: '', allUsers: true}, updateJobs: true, explicitReads: true};

/** Arnés con el bundle real y una VM con watcher 11, sobre un usuario gestionado por Meta. */
export function realSetup(options: Partial<OrqaSyncOptions> = {}, deps: Partial<OrqaSyncDeps> = {}) {
  const bundle = realBundle();
  const harness = setup({...META_OPTIONS, ...options}, bundle);
  const instances = harness.instances;
  const original = instances.guestAttribute.bind(instances);
  instances.guestAttribute = async (name: string, key: string) => key === 'hermes/watcher-version' ? '11' : original(name, key);
  harness.row.ai_provider = 'meta';
  harness.row.ai_model = 'muse-spark-1.3-contributor';
  const make = () => {
    const sync = harness.make();
    const internal = sync as unknown as {deps: OrqaSyncDeps};
    internal.deps = {...internal.deps, skills: new SkillsWriter(bundle.skills, harness.repository, instances, async () => harness.types, bundle.skillsEncoding), ...deps};
    return sync;
  };
  return {...harness, bundle, make};
}

export const desiredOf = (sync: OrqaSync, row: AssistantRow): Promise<HermesMetadata> =>
  (sync as unknown as {desired(value: AssistantRow): Promise<HermesMetadata>}).desired(row);

/** Bytes de `desired` calculados con el código de `origin/main`, antes de Stock. */
export function baselineDesired(): Record<string, Buffer> {
  const path = join(__dirname, '..', 'fixtures', 'stock-igualdad', 'desired-main.json.gz');
  const value = JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) as Record<string, string>;
  return Object.fromEntries(Object.entries(value).map(([key, text]) => [key, Buffer.from(text, 'utf8')]));
}

/** gzip depende de la zlib de cada Node: entre máquinas solo se comparan los bytes del tar. */
export function comparable(key: string, value: Buffer): Buffer {
  return ['hermes-skills', 'hermes-profiles', 'hermes-extensions'].includes(key) ? gunzipSync(Buffer.from(value.toString('utf8'), 'base64')) : value;
}

export {USER};
