import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {metaRuntimeExtensions} from '../src/activation/vm-extensions';
import {configuration} from '../src/config';
import {BRAIN_IMAGE} from './support/orqa-fakes';
import {addonFor, ADDON_DIR, ROLE, STOCK_BRAIN, tarFiles, tarNames, watcherHelper} from './support/stock-addon';
import {desiredOf, realSetup, USER} from './support/stock-desired';
import {loadStockAddon} from '../src/stock/addon';

const CONTRACTS = join(__dirname, '..', 'contracts', 'continuous-loop', 'v1');
const overlay = (name: string) => readFileSync(join(ADDON_DIR, 'rol', name), 'utf8');
const canonical = (name: string) => readFileSync(join(CONTRACTS, name), 'utf8');

describe('sobrecapa del rol stock', () => {
  it.each(['knowledge-candidate', 'specialist-experience', 'trusted-context', 'context-pack'])('%s es el contrato de siempre más stock', name => {
    const file = `${name}.schema.json`;
    const added = overlay(file).replace(/^\s*"stock",?\n/gm, '').replace(/"disenador_landings",(\n\s*\])/g, '"disenador_landings"$1');
    expect(added).toBe(canonical(file));
    expect(overlay(file)).toContain('"stock"');
  });

  it('el catálogo real del watcher acepta stock, y sin la sobrecapa lo rechaza', () => {
    const catalog = Buffer.from(overlay('role-catalog.json'));
    const roles = watcherHelper('managed-roles', catalog);
    expect(roles.status).toBe(0);
    expect(roles.stdout.toString().split(' ')).toEqual(expect.arrayContaining(['stock', 'disenador_landings', 'curador', 'ale']));
    const secret = Buffer.from('a'.repeat(64));
    expect(watcherHelper('memory-token', secret, 'stock', roles.stdout.toString()).status).toBe(0);
    const base = watcherHelper('managed-roles', Buffer.from(canonical('role-catalog.json'))).stdout.toString();
    expect(base.split(' ')).not.toContain('stock');
    expect(watcherHelper('memory-token', secret, 'stock', base).status).not.toBe(0);
  });
});

describe('metadata por usuario', () => {
  it('el habilitado recibe Brain y catálogo nuevos; el mismo conjunto de archivos pasa el validador real', async () => {
    const harness = realSetup({}, {addon: addonFor(USER)});
    const desired = await desiredOf(harness.make(), harness.row);
    expect(desired['hermes-brain-image']).toBe(STOCK_BRAIN);
    const value = desired['hermes-extensions']!;
    expect(tarNames(value).sort()).toEqual(tarNames(metaRuntimeExtensions()).sort());
    expect(tarFiles(value)['plugins/saleads-continuity/role-catalog.json']).toBe(overlay('role-catalog.json'));
    expect(tarFiles(value)['plugins/saleads-memory/contracts/specialist-experience.schema.json']).toBe(overlay('specialist-experience.schema.json'));
    const result = watcherHelper('extensions', value);
    expect(result.stderr.toString()).toBe('');
    expect(result.status).toBe(0);
  });

  it('el resto del paquete no cambia: solo cuatro archivos difieren', () => {
    const value = tarFiles(addonFor(USER).extensions(metaRuntimeExtensions()));
    const base = tarFiles(metaRuntimeExtensions());
    const changed = Object.keys(base).filter(name => base[name] !== value[name]);
    expect(changed.sort()).toEqual([
      'plugins/saleads-continuity/role-catalog.json', 'plugins/saleads-memory/contracts/knowledge-candidate.schema.json',
      'plugins/saleads-memory/contracts/specialist-experience.schema.json', 'plugins/saleads-memory/memory.py',
    ]);
  });

  it('F-R6a: memory.py de Stock es el de la base más el filtro de inferencias sin confirmar, y nada más', () => {
    const value = tarFiles(addonFor(USER).extensions(metaRuntimeExtensions()))['plugins/saleads-memory/memory.py']!;
    const base = tarFiles(metaRuntimeExtensions())['plugins/saleads-memory/memory.py']!;
    const filter = value.slice(value.indexOf('def _without_unconfirmed_inferences'), value.indexOf('def _receipt'));
    expect(filter).toContain("entry.get('epistemic') == 'inferred' and entry.get('validation_state') == 'proposed'");
    const call = "return _without_unconfirmed_inferences(_pack(context, self.client.request(context, '/continuous/context', payload, timeout=timeout)))";
    expect(value.replace(filter, '').replace(call, "return _pack(context, self.client.request(context, '/continuous/context', payload, timeout=timeout))")).toBe(base);
  });

  it('quien no está habilitado sigue con metaRuntimeExtensions y BRAIN_IMAGE exactos', async () => {
    const harness = realSetup({}, {addon: addonFor('otro')});
    const desired = await desiredOf(harness.make(), harness.row);
    expect(desired['hermes-brain-image']).toBe(BRAIN_IMAGE);
    expect(desired['hermes-extensions']).toBe(metaRuntimeExtensions());
  });

  it('sin STOCK_BRAIN_IMAGE no arranca con usuarios; sin usuarios, sí', () => {
    const settings = {enabled: true, userIds: new Set(['a'])};
    expect(() => loadStockAddon(settings, ADDON_DIR, 'saleads-sales-agent@1.5.13', {...ROLE, brainImage: ''})).toThrow('STOCK_BRAIN_IMAGE');
    expect(loadStockAddon({enabled: true, userIds: new Set()}, ADDON_DIR, 'saleads-sales-agent@1.5.13', {...ROLE, brainImage: ''})).toBeDefined();
  });

  it('STOCK_BRAIN_IMAGE exige digest fijo, como el watcher', () => {
    const parse = (image: string) => {
      const env = Object.fromEntries(readFileSync('.env.example', 'utf8').split('\n').filter(line => /^[A-Z_]+=/.test(line)).map(line => line.split(/=(.*)/s).slice(0, 2)));
      return configuration({...env, STOCK_BRAIN_IMAGE: image} as never);
    };
    expect(() => parse('us-central1-docker.pkg.dev/x/y/z:latest')).toThrow('CONFIGURATION_INVALID');
  });
});

describe('lo de terceros no pasa directo a memoria', () => {
  const soul = readFileSync(join(ADDON_DIR, 'profiles/stock/SOUL.md'), 'utf8');

  it('Stock no escribe: lee con recall, y su resultado final no lleva citas de terceros', () => {
    expect(soul).toContain('No escribes memoria');
    expect(soul).toContain('`saleads_memory_recall`');
    expect(soul).toMatch(/nunca citas de terceros/);
    expect(soul).toMatch(/nunca debe pasar a memoria/);
  });

  it('el perfil no tiene herramienta de escritura: sin brain, sin memoria nativa y sin revisión de fondo', async () => {
    const harness = realSetup({}, {addon: addonFor(USER)});
    const desired = await desiredOf(harness.make(), harness.row);
    const config = tarFiles(desired['hermes-profiles']!)['profiles/stock/profile-config.yaml']!;
    expect(config).toContain('saleads-brain:\n    tools:\n      include: []');
    expect(config).toContain('memory_enabled: false');
    expect(config).toContain('user_profile_enabled: false');
    expect(config).toContain('background_review:\n    enabled: false');
    expect(config).not.toMatch(/saleads_share_learning|brain_record/);
  });

  it('en la VM, memoria da a Stock solo recall: curación y metas exigen otro rol', () => {
    const plugin = readFileSync(join(__dirname, '..', 'vm', 'extensions', 'saleads-memory', '__init__.py'), 'utf8');
    expect(plugin).toContain("('saleads_memory_recall', plugin.recall, False)");
    expect(plugin).toContain("('saleads_curation_batch', plugin.batch, True)");
    expect(plugin).toContain("('saleads_commit_candidates', plugin.commit, True)");
    expect(plugin).toContain("plugin.role == 'ale'");
  });
});
