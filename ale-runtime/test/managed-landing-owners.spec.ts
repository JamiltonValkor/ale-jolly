import {createHash} from 'node:crypto';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {loadAgentBundle} from '../src/activation/hermes-files';
import {TrustedContextV1} from '../src/contracts/continuous-loop';
import {continuousConversationContext} from '../src/first-loop/continuous-context';
import {TrustedContextPublisher} from '../src/notifications/trusted-contexts';
import type {InstanceApi} from '../src/compute/instance-client';
import type {AssistantRow} from '../src/persistence/assistant-repository';

const dir = 'distribution/saleads-sales-agent/1.5.13';
const fixtures = [
  {owner: 'synthetic-owner-alpha', business: '11111111-1111-4111-8111-111111111111', session: 'alpha-design', locale: 'en', destination: 'whatsapp'},
  {owner: 'synthetic-owner-beta', business: '22222222-2222-4222-8222-222222222222', session: 'beta-design', locale: 'pt-BR', destination: 'existing_website'},
];

describe('managed landing instructions across unrelated owners', () => {
  it('uses each real trusted owner/business/locale and refuses a foreign profile binding', async () => {
    const items = new Map<string, Array<{key: string; value: string}>>();
    const api: InstanceApi = {
      getInstance: async name => ({status: 'RUNNING', privateIp: '10.0.0.1', fingerprint: 'fixture', items: items.get(name) ?? []}),
      setMetadata: async (name, _fingerprint, value) => {items.set(name, value);},
      guestAttribute: async (name, key) => {
        if (key !== 'hermes/continuous-context-hash') return null;
        const value = items.get(name)?.find(item => item.key === 'hermes-continuous-contexts')?.value;
        return value ? createHash('sha256').update(value).digest('hex') : null;
      },
    };
    const publisher = new TrustedContextPublisher(api);
    const contexts = fixtures.map(fixture => TrustedContextV1.parse({schema_version: 'trusted-context/1', owner_id: fixture.owner,
      business_id: fixture.business, session_id: fixture.session, actor_role: 'disenador_landings', native_task_id: 'task-' + fixture.session,
      native_run_id: 'run-' + fixture.session, response_locale: fixture.locale, locale_revision: 1,
      capabilities: ['saleads-mcp'], mandate_id: null, pending_context: false}));
    for (const [index, fixture] of fixtures.entries()) {
      const row = {user_id: fixture.owner, instance_name: 'vm-' + fixture.owner} as AssistantRow;
      await publisher.publish(row, contexts[index]!);
      const saved = JSON.parse(items.get(row.instance_name!)!.find(item => item.key === 'hermes-continuous-contexts')!.value);
      expect(saved.owner_id).toBe(fixture.owner);
      expect(saved.contexts).toEqual([contexts[index]]);
      const rootContext = continuousConversationContext({...contexts[index]!, actor_role: 'ale'});
      expect(rootContext).toContain(fixture.business);
      expect(rootContext).toContain('response_locale=' + fixture.locale);
      expect(rootContext).not.toContain(fixtures[1 - index]!.business);
      await expect(publisher.publish(row, contexts[1 - index]!)).rejects.toMatchObject({code: 'SERVICE_UNAVAILABLE'});
    }
  });

  it('keeps direct destinations eligible and ships no account-specific pilot facts or restrictions', () => {
    const bundle = loadAgentBundle(dir, 'saleads-sales-agent@1.5.13');
    const skill = (JSON.parse(bundle.skills) as Record<string, string>)['saleads-landing-pilot/SKILL.md']!;
    for (const fixture of fixtures) {
      // These two fixtures deliberately need no new landing. The instruction
      // contract preserves that choice; only Ale makes the actual strategy decision.
      expect(['whatsapp', 'existing_website']).toContain(fixture.destination);
      expect(skill).toContain('compare a direct destination/reuse with a new page');
      expect(skill).toContain('only when the strategy justifies it');
      expect(skill).toContain('existing pages');
      expect(bundle.soul + skill).not.toContain(fixture.owner);
      expect(bundle.soul + skill).not.toContain(fixture.business);
    }
    const files: string[] = [];
    const visit = (path: string) => {for (const name of readdirSync(path)) {const file = join(path, name); if (statSync(file).isDirectory()) visit(file); else files.push(file);}};
    visit(dir + '/profiles/disenador_landings');
    visit(dir + '/skills/saleads-landing-pilot');
    visit('vm/extensions/landing-pilot');
    const text = [bundle.soul, ...files.map(path => readFileSync(path, 'utf8'))].join('\n');
    expect(/localhost|127\.0\.0\.1|\bCTO\b|Masquebella|Sonrisa Clara|currently published version\s*6|owner explicitly waived|current pilot grant/i.test(text)).toBe(false);
    expect(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text)).toBe(false);
    expect(/(?:https:\/\/[^\s"']+\?[^\s"']*(?:signature|token)=)|BEGIN (?:RSA |EC )?PRIVATE KEY/i.test(text)).toBe(false);
  });
});
