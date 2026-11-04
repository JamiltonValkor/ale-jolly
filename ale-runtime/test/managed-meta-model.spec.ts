import {hermesConfig} from '../src/activation/hermes-files';
import {isManagedMetaUser, managedMetaConfigLines, META_AUXILIARY_TASKS, META_MODEL_ID, META_PROVIDER_ID, MIN_META_WATCHER_VERSION} from '../src/ai/meta-model';
import {findProvider, providersResponse} from '../src/ai/providers';
import {hermesEnv} from '../src/ai/ai-outcome';
import {HermesConfigWriter} from '../src/assistant-config/hermes-config-writer';
import {FakeInstances, INSTANCE} from './support/hermes-fakes';
import type {AssistantRow} from '../src/persistence/assistant-repository';

describe('managed Meta Assistant inference', () => {
  it('opens admission only when enabled and explicitly all-account, preserving the pilot default', () => {
    const pilot = {enabled: true, userId: 'owner-a'};
    expect(isManagedMetaUser(pilot, 'owner-a')).toBe(true);
    expect(isManagedMetaUser(pilot, 'owner-b')).toBe(false);
    for (const owner of ['owner-a', 'owner-b']) {
      expect(isManagedMetaUser({...pilot, allUsers: true}, owner)).toBe(true);
      expect(isManagedMetaUser({...pilot, enabled: false, allUsers: true}, owner)).toBe(false);
    }
    for (const anonymous of [undefined, '', ' ']) expect(isManagedMetaUser({...pilot, allUsers: true}, anonymous)).toBe(false);
    expect(isManagedMetaUser(undefined, 'owner-a')).toBe(false);
  });

  it('announces managed Meta without asking the browser for a key', () => {
    expect(providersResponse(true)).toEqual([{id: 'meta-ai', label: 'Meta Model API', needs_key: false}]);
  });

  it('writes only the Meta key and its bounded timeout into managed inference env', () => {
    const provider = findProvider(META_PROVIDER_ID)!;
    expect(provider.envVar).toBe('MODEL_API_KEY');
    const env = hermesEnv(provider, 'synthetic-meta-key', META_MODEL_ID);
    expect(env).toBe('MODEL_API_KEY=synthetic-meta-key\nHERMES_API_TIMEOUT=300\n');
    expect(env).not.toMatch(/OPENAI|OPENROUTER|BRAIN_LLM/);
  });

  it('pins all configured auxiliary tasks and delegated workers to the chosen Meta model', () => {
    const config = hermesConfig({
      mcp: {mcpUrl: 'https://app.example/mcp', clientId: 'example-assistant', scope: 'openid saleads:read'},
      model: {provider: META_PROVIDER_ID, model: META_MODEL_ID},
    });
    expect(config).toContain('model: { provider: "meta-ai", default: "muse-spark-1.3-contributor", base_url: "https://api.meta.ai/v1", api_key: "", api_mode: "codex_responses" }');
    expect(config).toContain('fallback_providers: []');
    for (const task of META_AUXILIARY_TASKS) {
      expect(config).toContain(`  ${task}:\n    provider: "meta-ai"\n    model: "muse-spark-1.3-contributor"\n    base_url: ""\n    api_key: ""\n    fallback_chain: []`);
    }
    expect(config).toContain('delegation:\n  provider: "meta-ai"\n  model: "muse-spark-1.3-contributor"\n  base_url: ""\n  fallback_providers: []');
    expect(config).toContain('    auth: oauth');
  });

  it('does not rewrite the configuration of the existing legacy deployment', () => {
    expect(managedMetaConfigLines('openrouter')).toEqual([]);
    expect(managedMetaConfigLines('openai-api')).toEqual([]);
  });

  it('does not let a stale legacy row or a scheduled sync restore another provider', () => {
    const writer = new HermesConfigWriter(
      {mcpUrl: 'https://app.example/mcp', clientId: 'example-assistant', scope: 'openid'},
      new FakeInstances(), {provider: META_PROVIDER_ID, model: META_MODEL_ID, userId: 'example-owner'},
    );
    const config = writer.build({user_id: 'example-owner', ai_provider: 'openrouter', ai_model: 'legacy-model', timezone: 'UTC'},
      {provider: 'openai-api', model: 'another-legacy-model'});
    expect(config).toContain('provider: "meta-ai"');
    expect(config).toContain('https://api.meta.ai/v1');
    expect(config).not.toContain('legacy-model');
    expect(writer.build({user_id: 'another-owner', ai_provider: 'openrouter', ai_model: 'legacy-model', timezone: 'UTC'}))
      .toContain('provider: "openrouter"');
  });

  it('pins another admitted account and enforces the same watcher capability before writing its own VM', async () => {
    const instances = new FakeInstances();
    const baseUrl = 'https://app.example.invalid/meta-inference/v1';
    const writer = new HermesConfigWriter(
      {mcpUrl: 'https://app.example/mcp', clientId: 'example-assistant', scope: 'openid'},
      instances, {provider: META_PROVIDER_ID, model: META_MODEL_ID, userId: 'pilot-owner', allUsers: true, baseUrl},
    );
    const row = {user_id: 'unrelated-owner', ai_provider: 'openrouter', ai_model: 'legacy-model', timezone: 'UTC',
      instance_name: INSTANCE} as AssistantRow;
    expect(writer.build(row)).toContain('default: "muse-spark-1.3-contributor"');
    expect(writer.build(row)).toContain('base_url: "' + baseUrl + '"');
    expect(writer.build({...row, timezone: 'Europe/Paris'})).not.toContain('https://api.meta.ai');
    for (const task of META_AUXILIARY_TASKS) expect(writer.build(row)).toContain(`  ${task}:\n    provider: "meta-ai"\n    model: "muse-spark-1.3-contributor"\n    base_url: "${baseUrl}"`);
    expect(await writer.apply(row)).toBe('deferred');
    expect(instances.sets).toEqual([]);
    const guest = instances.guestAttribute.bind(instances);
    instances.guestAttribute = async (name, key) => key === 'hermes/watcher-version' ? String(MIN_META_WATCHER_VERSION) : guest(name, key);
    expect(await writer.apply(row)).toBe('applied');
    expect(instances.sets[0]?.name).toBe(INSTANCE);
    expect(instances.item('hermes-config')).toContain('default: "muse-spark-1.3-contributor"');
  });
});
