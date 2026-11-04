import {hermesConfig} from '../src/activation/hermes-files';
import {composeSkills, SkillsWriter} from '../src/skills/skills-writer';
import {HermesConfigWriter} from '../src/assistant-config/hermes-config-writer';
import {gunzipSync} from 'node:zlib';
import {computeAppliedVersion, withMetadataValues} from '../src/compute/metadata';
import {INSTANCE, VM_IP} from './support/hermes-fakes';
import {mcp, setup, USER} from './support/orqa-fakes';
import {addonFor, tarNames} from './support/stock-addon';
import {baselineDesired, comparable, desiredOf, realBundle, realSetup} from './support/stock-desired';

const OTHER = '22222222-2222-4222-8222-222222222222';
const profilesOf = (value: string) => {
  const tar = gunzipSync(Buffer.from(value, 'base64'));
  return tar.toString('utf8');
};

describe('igualdad byte a byte para quien no está habilitado', () => {
  const baseline = baselineDesired();

  it.each([
    ['con el complemento de otro usuario (STOCK_ENABLED=true)', true],
    ['sin complemento (STOCK_ENABLED=false)', false],
  ])('%s, cada llave es igual a origin/main', async (_name, withAddon) => {
    const harness = realSetup({}, withAddon ? {addon: addonFor(OTHER)} : {});
    const desired = await desiredOf(harness.make(), harness.row);
    expect(Object.keys(desired).sort()).toEqual(Object.keys(baseline).sort());
    for (const [key, value] of Object.entries(desired)) {
      const equal = comparable(key, Buffer.from(value as string, 'utf8')).equals(comparable(key, baseline[key]!));
      expect({key, equal}).toEqual({key, equal: true});
    }
  });

  it('en este mismo proceso, con y sin complemento dan los mismos bytes, gzip incluido', async () => {
    const plain = realSetup();
    const withAddon = realSetup({}, {addon: addonFor(OTHER)});
    const before = await desiredOf(plain.make(), plain.row);
    const after = await desiredOf(withAddon.make(), withAddon.row);
    expect(Object.keys(after)).toEqual(Object.keys(before));
    for (const [key, value] of Object.entries(after)) {
      expect({key, equal: Buffer.from(value as string).equals(Buffer.from(before[key as keyof typeof before] as string))}).toEqual({key, equal: true});
    }
  });

  it('el usuario habilitado sí difiere, para que la igualdad no pase sola', async () => {
    const harness = realSetup({}, {addon: addonFor(USER)});
    const desired = await desiredOf(harness.make(), harness.row);
    expect(Buffer.from(desired['hermes-soul']!, 'utf8').equals(baseline['hermes-soul']!)).toBe(false);
  });

  it('con esa igualdad applyMetadata no escribe', async () => {
    const harness = realSetup({}, {addon: addonFor(OTHER)});
    const desired = await desiredOf(harness.make(), harness.row);
    const view = harness.instances.view!;
    view.items = withMetadataValues(view.items, desired);
    const applied = computeAppliedVersion(view.items);
    harness.instances.guestAttribute = async (_name: string, key: string) => key === 'hermes/applied-version' ? applied : key === 'hermes/watcher-version' ? '11' : null;
    expect(await harness.make().onReady(USER, INSTANCE)).toBe('synced');
    expect(harness.instances.sets).toHaveLength(0);
    expect(harness.events.at(-1)?.detail).toContain('metadata_written=false');
  });
});

describe('usuario habilitado', () => {
  const enabled = () => {
    const harness = realSetup({}, {addon: addonFor(USER), config: new HermesConfigWriter({...mcp, saleadsExclude: addonFor(USER).saleadsExclude}, setup().instances)});
    return {harness, sync: harness.make()};
  };

  it('recibe versión efectiva, perfil, SOUL, skill raíz y el exclude de Ale', async () => {
    const {harness, sync} = enabled();
    const desired = await desiredOf(sync, harness.row);
    expect(desired['hermes-bundle-version']).toBe('saleads-sales-agent@1.5.13+stock-1.0.8');
    expect(desired['hermes-soul']).toContain('<!-- stock:start -->');
    expect(desired['hermes-config']).toContain('saleads_stock_take_photo');
    expect(tarNames(desired['hermes-skills']!)).toContain('saleads-stock-orchestration/SKILL.md');
    expect(tarNames(desired['hermes-profiles']!)).toEqual(expect.arrayContaining(['profiles/stock/SOUL.md', 'profiles/stock/profile-config.yaml']));
  });

  it('disenador_landings, curador y los 5 especialistas siguen iguales, salvo la skill del investigador', async () => {
    const {harness, sync} = enabled();
    const desired = await desiredOf(sync, harness.row);
    const names = tarNames(desired['hermes-profiles']!);
    const base = tarNames(baselineDesired()['hermes-profiles']!.toString('utf8'));
    expect(names.filter(name => !base.includes(name)).sort()).toEqual([
      'profiles/investigador/skills/saleads-offer-kit/SKILL.md',
      'profiles/stock/SOUL.md', 'profiles/stock/profile-config.yaml',
      ...['negociacion', 'inventario', 'reposicion', 'vision'].sort().map(skill => `profiles/stock/skills/stock-${skill}/SKILL.md`),
    ].sort());
    expect(base.every(name => names.includes(name))).toBe(true);
    const plain = profilesOf(desired['hermes-profiles']!), original = profilesOf(baselineDesired()['hermes-profiles']!.toString('utf8'));
    for (const soul of Object.values(realBundle().profiles)) {
      expect(plain.includes(soul)).toBe(original.includes(soul));
    }
  });

  it('offer-kit solo aparece en el tar del habilitado', async () => {
    const plain = realSetup({}, {addon: addonFor(OTHER)});
    const desired = await desiredOf(plain.make(), plain.row);
    expect(tarNames(desired['hermes-profiles']!).join()).not.toMatch(/offer-kit|profiles\/stock/);
  });

  it('el evento orqa.synced sigue con la base y la historia de trabajos la entiende', async () => {
    const {harness, sync} = enabled();
    expect(await sync.onReady(USER, INSTANCE)).toBe('synced');
    expect(harness.events.at(-1)?.detail).toContain('bundle=saleads-sales-agent@1.5.13 ');
    expect(harness.instances.view!.items.find(item => item.key === 'hermes-bundle-version')?.value).toBe('saleads-sales-agent@1.5.13+stock-1.0.8');
  });

  it('ensureJobs no recrea un trabajo que el dueño borró, porque jobNamesByVersion se lee con la versión base', async () => {
    const bundle = realBundle();
    const jobs = [{name: 'saleads:monthly-review', schedule: '0 9 1 * *', prompt: 'p', skills: []}];
    const classic = {...bundle, jobs, jobNamesByVersion: {[bundle.version]: ['saleads:monthly-review']}};
    const harness = setup({updateJobs: true, managedMeta: {enabled: false, userId: '', allUsers: false}}, classic);
    harness.history.push(bundle.version);
    const sync = harness.make();
    (sync as unknown as {deps: {addon: unknown}}).deps.addon = addonFor(USER);
    expect(await sync.onReady(USER, INSTANCE)).toBe('synced');
    expect(harness.hermes.created).toEqual([]);
    expect(harness.events.map(event => event.detail)).toContain('name=saleads:monthly-review reason=deleted');
  });

  it('readyForFirstUse sigue en verdadero con la metadata efectiva', async () => {
    const {harness, sync} = enabled();
    Object.assign(harness.row, {ai_configured: true, private_ip: VM_IP, ready_since: new Date('2027-08-24T10:00:00Z')});
    harness.instances.view!.generation = 'g1';
    expect(await sync.onReady(USER, INSTANCE, harness.row.ready_since)).toBe('synced');
    expect(await sync.readyForFirstUse(harness.row)).toBe(true);
  });

  it('habilitar en caliente reconcilia: la variante en la llave protege done', async () => {
    const users = new Set<string>();
    const addon = addonFor(USER);
    const dynamic = {...addon, enabledFor: (user: string) => users.has(user)};
    const harness = realSetup({}, {addon: dynamic});
    const sync = harness.make();
    expect(await sync.onReady(USER, INSTANCE)).toBe('synced');
    expect(await sync.onReady(USER, INSTANCE)).toBe('skipped');
    users.add(USER);
    expect(await sync.onReady(USER, INSTANCE)).toBe('synced');
    expect(harness.instances.sets.at(-1)!.items.find(item => item.key === 'hermes-bundle-version')?.value).toContain('+stock-1.0.8');
  });
});

describe('skills de catálogo', () => {
  it('instalar una skill conserva saleads-stock-orchestration; sin extra la borraría', async () => {
    const harness = realSetup();
    const addon = addonFor(USER);
    const bundle = realBundle();
    const installed = [{item_id: 'skill.nueva', files: {'SKILL.md': 'x'}}];
    const writer = new SkillsWriter(bundle.skills, harness.repository, harness.instances, async () => [], bundle.skillsEncoding, () => addon.skills);
    expect(await writer.apply(USER, installed)).toBe('applied');
    const value = harness.instances.sets.at(-1)!.items.find(item => item.key === 'hermes-skills')!.value;
    expect(tarNames(value)).toEqual(expect.arrayContaining(['saleads-stock-orchestration/SKILL.md', 'saleads-collective/skill.nueva/SKILL.md']));
    const without = new SkillsWriter(bundle.skills, harness.repository, harness.instances, async () => [], bundle.skillsEncoding);
    await without.apply(USER, installed);
    expect(tarNames(harness.instances.sets.at(-1)!.items.find(item => item.key === 'hermes-skills')!.value)).not.toContain('saleads-stock-orchestration/SKILL.md');
  });

  it('composeSkills sin extra da el mismo valor', () => {
    const bundle = realBundle();
    expect(composeSkills(bundle.skills, [], [], undefined)).toBe(composeSkills(bundle.skills, [], []));
  });
});

describe('tamaño de metadata', () => {
  /** `evidencia/t0/metadata-medida.json`: base real con todas las llaves más la URL extra del primer uso. */
  const REAL_TOTAL = 431_971 + 1_879;
  const LIMIT = 524_288, PER_VALUE = 240_000;

  it('el habilitado queda bajo los límites con margen de 10 % o más', async () => {
    const harness = realSetup({}, {addon: addonFor(USER)});
    const desired = await desiredOf(harness.make(), harness.row);
    const baseline = baselineDesired();
    const sizes = Object.entries(desired).map(([key, value]) => [key, Buffer.byteLength(value as string), baseline[key]!.length] as const);
    const growth = sizes.reduce((sum, [, size, before]) => sum + size - before, 0);
    process.stdout.write(`stock metadata: +${growth} B ${JSON.stringify(sizes)}\n`);
    expect(Math.max(...sizes.map(([, size]) => size))).toBeLessThanOrEqual(PER_VALUE);
    expect(REAL_TOTAL + growth).toBeLessThanOrEqual(LIMIT * 0.9);
  });
});

it('hermes-config conserva el constructor único: sin función de exclusión no cambia', () => {
  expect(hermesConfig({mcp, userId: USER})).toBe(hermesConfig({mcp}));
});
