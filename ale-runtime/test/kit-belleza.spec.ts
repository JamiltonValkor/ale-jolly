import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join, relative} from 'node:path';

import {ApprovalsRepository} from '../src/approvals/approvals-repository';
import {ApprovalsService} from '../src/approvals/approvals.service';
import {loadAgentBundle} from '../src/activation/hermes-files';
import {BrainHubRepository} from '../src/brain-hub/repository';
import {BrainHubService} from '../src/brain-hub/service';
import {InstallSkillExecutor, SkillsApprovalCatalog, UninstallSkillExecutor} from '../src/skills/skills-catalog';
import {SkillsWriter} from '../src/skills/skills-writer';
import {FakeInstances, INSTANCE} from './support/hermes-fakes';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';

/**
 * AAB-023 (MAN-009): el kit visual de belleza es un ítem del catálogo (V12), se instala y se retira con las
 * aprobaciones de siempre y solo toca `saleads-collective/saleads-kit-belleza/**` en la VM.
 */
const KIT_ROOT = 'distribution/kits/saleads-kit-belleza/1.0.0';
const KIT = join(KIT_ROOT, 'skills/saleads-kit-belleza');
const ITEM = 'saleads-kit-belleza';
const BUSINESS = '00000000-0000-4000-8000-000000000002';
const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : [path];
});
const kitTree = () => Object.fromEntries(files(KIT).map(path => [relative(KIT, path), readFileSync(path, 'utf8')]).sort(([a], [b]) => a!.localeCompare(b!)));

describe('kit visual de belleza (AAB-023)', () => {
  it('V12 publica exactamente el árbol del kit, byte a byte', () => {
    const sql = readFileSync('migrations/V12__catalog_kit_belleza.sql', 'utf8');
    const json = /\$kit\$\n([\s\S]*)\$kit\$::jsonb/.exec(sql)?.[1];
    expect(JSON.parse(json ?? 'null')).toEqual(kitTree());
    expect(Object.keys(kitTree()).sort()).toEqual(['SKILL.md', 'references/como-se-mide.md', 'references/prohibidos.md',
      'references/referencias.md', 'references/reglas.md']);
    // Flyway reemplaza `${…}`: el contenido no debe tenerlo.
    expect(sql).not.toContain('${');
    expect(sql).toContain("'industry_playbook',\n    'belleza_y_cuidado_personal',");
  });

  it('trae su propio validate.py (igual al del bundle) y el SKILL.md se llama como su carpeta', () => {
    expect(readFileSync(join(KIT_ROOT, 'validate.py'), 'utf8')).toBe(readFileSync('distribution/saleads-sales-agent/1.5.0/validate.py', 'utf8'));
    expect(kitTree()['SKILL.md']).toMatch(/^---\nname: saleads-kit-belleza\ndescription: "[^"\n]{1,1024}"\nversion: 1\.0\.0\n/);
    expect(kitTree()['references/prohibidos.md']).toMatch(/promesas médicas/i);
    expect(kitTree()['references/reglas.md']).toMatch(/tonos de piel/);
  });

  describe('instalar y retirar con las aprobaciones de siempre', () => {
    let db: TestDatabase;
    let hub: BrainHubService;
    let instances: FakeInstances;
    let approvals: ApprovalsService;
    const bundle = loadAgentBundle('distribution/saleads-sales-agent/1.5.0', 'saleads-sales-agent@1.5.0');

    beforeAll(async () => {db = await startTestDatabase();});
    afterAll(async () => {await db.close();});
    beforeEach(async () => {
      for (const table of ['installs', 'business_industries']) await db.database.pool.query(`DELETE FROM brain_hub.${table}`);
      await db.database.pool.query('DELETE FROM assistant.approvals');
      await db.database.pool.query('DELETE FROM assistant.assistants');
      await db.database.pool.query(`INSERT INTO assistant.assistants(user_id,status,instance_name) VALUES ('u1','ready','${INSTANCE}')`);
      hub = new BrainHubService({repository: new BrainHubRepository(db.database.pool), admins: new Set(['owner'])});
      instances = new FakeInstances();
      const writer = new SkillsWriter(bundle.skills, {findActive: async userId => (userId === 'u1' ? {instance_name: INSTANCE} : null) as never},
        instances, async () => ['physical_product']);
      approvals = new ApprovalsService({
        repository: new ApprovalsRepository(db.database),
        catalog: new SkillsApprovalCatalog(hub),
        executors: [new InstallSkillExecutor(hub, writer), new UninstallSkillExecutor(hub, writer)],
      });
    });
    const skillsOnVm = () => JSON.parse(instances.sets.at(-1)!.items.find(item => item.key === 'hermes-skills')!.value) as Record<string, string>;

    it('V12 deja el ítem activo para los negocios de belleza', async () => {
      const item = await hub.activeItem(ITEM);
      expect(item).toMatchObject({id: ITEM, version: '1.0.0', kind: 'skill', source: 'industry_playbook', industry_slug: 'belleza_y_cuidado_personal'});
      expect((await hub.catalogFor('u1', BUSINESS, 'belleza_y_cuidado_personal')).available.map(i => i.id)).toContain(ITEM);
      expect((await hub.catalogFor('u1', BUSINESS, 'restaurantes')).available.map(i => i.id)).not.toContain(ITEM);
    });

    it('instalarlo solo agrega saleads-collective/saleads-kit-belleza/**; retirarlo lo quita sin tocar lo demás', async () => {
      await hub.catalogFor('u1', BUSINESS, 'belleza_y_cuidado_personal');
      const install = await approvals.propose('u1', {business_id: BUSINESS, kind: 'install_skill', item_id: ITEM});
      expect((await approvals.approve('u1', install.id, 'decision-0001')).status).toBe('executed');
      const withKit = skillsOnVm();
      const uninstall = await approvals.propose('u1', {business_id: BUSINESS, kind: 'uninstall_skill', item_id: ITEM});
      expect((await approvals.approve('u1', uninstall.id, 'decision-0002')).status).toBe('executed');
      const without = skillsOnVm();
      const added = Object.keys(withKit).filter(path => !(path in without));
      expect(added.sort()).toEqual(Object.keys(kitTree()).map(file => `saleads-collective/${ITEM}/${file}`).sort());
      for (const [path, content] of Object.entries(without)) expect(withKit[path]).toBe(content);
      for (const file of Object.keys(kitTree())) expect(withKit[`saleads-collective/${ITEM}/${file}`]).toBe(kitTree()[file]);
    });
  });
});
