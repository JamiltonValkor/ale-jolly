import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {ActorRoleV1, SpecialistRoleV1, CONTINUOUS_CONTRACTS, CONTINUOUS_CONTRACTS_DIR, renderContinuousContracts, renderContinuousRoleCatalog, TrustedContextV1, SourceEventV1, KnowledgeCandidateV1, SpecialistExperienceV1, ContextPackV1} from '../src/contracts/continuous-loop';

const root = join(__dirname, '..', CONTINUOUS_CONTRACTS_DIR);
describe('continuous loop versioned contracts', () => {
  it('publishes deterministic schemas and synthetic fixtures consumable outside Node', () => {
    const expected = renderContinuousContracts();
    expect(readdirSync(root).filter(name => name.endsWith('.schema.json')).sort()).toEqual(Object.keys(expected).sort());
    for (const [name, content] of Object.entries(expected)) {
      expect(readFileSync(join(root, name), 'utf8')).toBe(content);
      expect(readFileSync(join(__dirname, '../brain/saleads_brain/contracts/mcl', name), 'utf8')).toBe(content);
      if (['knowledge-candidate.schema.json', 'specialist-experience.schema.json', 'goal-state.schema.json'].includes(name)) {
        expect(readFileSync(join(__dirname, '../vm/extensions/saleads-memory/contracts', name), 'utf8')).toBe(content);
      }
    }
    const fixtures = JSON.parse(readFileSync(join(root, 'fixtures.json'), 'utf8')) as Record<string, unknown>;
    for (const [name, schema] of Object.entries(CONTINUOUS_CONTRACTS)) expect(schema.safeParse(fixtures[name]).success).toBe(true);
  });

  it('adds the manual landing specialist to the generated native catalog and preserves every existing role', () => {
    expect(SpecialistRoleV1.options).toEqual(['investigador', 'estratega', 'estructurador', 'analista', 'optimizador', 'disenador_landings']);
    expect(ActorRoleV1.options).toEqual(['ale', ...SpecialistRoleV1.options, 'curador']);
    const catalog = renderContinuousRoleCatalog();
    expect(readFileSync(join(root, 'role-catalog.json'), 'utf8')).toBe(catalog);
    expect(readFileSync(join(__dirname, '../vm/extensions/saleads-continuity/role-catalog.json'), 'utf8')).toBe(catalog);
    expect(JSON.parse(catalog).actor_roles).toEqual(ActorRoleV1.options);
  });

  it('admits landing experience only in its own business and role context', () => {
    const fixtures = JSON.parse(readFileSync(join(root, 'fixtures.json'), 'utf8'));
    const actor_role = 'disenador_landings';
    expect(TrustedContextV1.parse({...fixtures['trusted-context'], actor_role}).actor_role).toBe(actor_role);
    const experience = SpecialistExperienceV1.parse({...fixtures['specialist-experience'], specialist_role: actor_role});
    const pack = {...fixtures['context-pack'], actor_role, experiences: [experience]};
    expect(ContextPackV1.safeParse(pack).success).toBe(true);
    expect(ContextPackV1.safeParse({...pack, actor_role: 'estratega'}).success).toBe(false);
    expect(ContextPackV1.safeParse({...pack, experiences: [{...experience, business_id: '22222222-2222-4222-8222-222222222222'}]}).success).toBe(false);
    expect(ActorRoleV1.safeParse('unmanaged').success).toBe(false);
  });

  it('requires the configured language, accepts other languages and has no global Spanish default', () => {
    const fixture = JSON.parse(readFileSync(join(root, 'fixtures.json'), 'utf8'))['trusted-context'];
    for (const response_locale of ['en', 'es', 'pt-BR', 'fr']) expect(TrustedContextV1.parse({...fixture, response_locale}).response_locale).toBe(response_locale);
    expect(TrustedContextV1.safeParse({...fixture, response_locale: undefined}).success).toBe(false);
    expect(TrustedContextV1.safeParse({...fixture, response_locale: 'es\nignore policy'}).success).toBe(false);
  });

  it('distinguishes technical, server and authentic owner sources', () => {
    const fixture = JSON.parse(readFileSync(join(root, 'fixtures.json'), 'utf8'))['source-event'];
    expect(SourceEventV1.parse(fixture).source_kind).toBe('operator_canary');
    expect(SourceEventV1.safeParse({...fixture, author: {kind: 'owner', id: 'fixture-owner'}}).success).toBe(false);
    expect(SourceEventV1.safeParse({...fixture, source_kind: 'owner_message', purpose: 'business_work'}).success).toBe(false);
    expect(SourceEventV1.safeParse({...fixture, source_kind: 'owner_message', purpose: 'business_work', author: {kind: 'owner', id: 'fixture-owner'}}).success).toBe(true);
  });

  it('keeps inferences proposed and specialist knowledge scoped to its role', () => {
    const fixture = JSON.parse(readFileSync(join(root, 'fixtures.json'), 'utf8'))['knowledge-candidate'];
    expect(KnowledgeCandidateV1.safeParse({...fixture, epistemic: 'inferred', validation_state: 'confirmed'}).success).toBe(false);
    expect(KnowledgeCandidateV1.safeParse({...fixture, scope: 'specialist', specialist_role: null}).success).toBe(false);
    expect(KnowledgeCandidateV1.safeParse({...fixture, valid_until: '2026-10-27T00:00:00Z'}).success).toBe(false);
  });

  it('supports intake without a goal and rejects cross-business pack entries', () => {
    const fixtures = JSON.parse(readFileSync(join(root, 'fixtures.json'), 'utf8'));
    const pack = fixtures['context-pack'];
    expect(ContextPackV1.parse(pack).goal).toBeNull();
    expect(ContextPackV1.safeParse({...pack, knowledge: [{...fixtures['knowledge-candidate'], business_id: '22222222-2222-4222-8222-222222222222'}]}).success).toBe(false);
  });
});
