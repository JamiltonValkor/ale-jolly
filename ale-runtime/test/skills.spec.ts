import {ApprovalsRepository} from '../src/approvals/approvals-repository';
import {ApprovalsService} from '../src/approvals/approvals.service';
import {BrainHubRepository} from '../src/brain-hub/repository';
import {BrainHubService} from '../src/brain-hub/service';
import {InstallSkillExecutor, SkillsApprovalCatalog, UninstallSkillExecutor} from '../src/skills/skills-catalog';
import {MAX_SKILLS_METADATA_BYTES, SkillsTooLargeError, SkillsWriter} from '../src/skills/skills-writer';
import {FakeInstances, INSTANCE} from './support/hermes-fakes';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';

const BUSINESS = '00000000-0000-4000-8000-000000000002';
const BUNDLE = JSON.stringify({'saleads-business-brain/SKILL.md': '# brain'});
const LESSON = 'Para novias funciona mejor mostrar el proceso completo del maquillaje que solo el resultado final.';

describe('catálogo de habilidades e instalación con aprobación (OSB-016)', () => {
  let db: TestDatabase;
  let hub: BrainHubService;
  let instances: FakeInstances;
  let approvals: ApprovalsService;
  let writer: SkillsWriter;

  beforeAll(async () => {db = await startTestDatabase();});
  afterAll(async () => {await db.close();});
  beforeEach(async () => {
    for (const table of ['lessons', 'catalog_items', 'installs', 'sharing_preferences', 'business_industries']) await db.database.pool.query(`DELETE FROM brain_hub.${table}`);
    await db.database.pool.query('DELETE FROM assistant.approvals');
    await db.database.pool.query('DELETE FROM assistant.assistants');
    await db.database.pool.query(`INSERT INTO assistant.assistants(user_id,status,instance_name) VALUES ('u1','ready','${INSTANCE}')`);
    hub = new BrainHubService({repository: new BrainHubRepository(db.database.pool), admins: new Set(['owner'])});
    instances = new FakeInstances();
    writer = new SkillsWriter(BUNDLE, {findActive: async userId => (userId === 'u1' ? {instance_name: INSTANCE} : null) as never}, instances, async () => []);
    approvals = new ApprovalsService({
      repository: new ApprovalsRepository(db.database),
      catalog: new SkillsApprovalCatalog(hub),
      executors: [new InstallSkillExecutor(hub, writer), new UninstallSkillExecutor(hub, writer)],
    });
  });

  async function publish(itemId = 'skill.beauty.process', text = LESSON): Promise<void> {
    const {lesson_id} = await hub.shareLesson('u9', {business_id: BUSINESS, industry_slug: 'belleza_y_cuidado_personal', text, provenance: 'owner_decided'});
    await hub.validate('owner', lesson_id!);
    await hub.publish('owner', lesson_id!, {item_id: itemId, name: 'Muestra el proceso', summary: 'Contenido de proceso.'});
  }
  const skillsOnVm = () => JSON.parse(instances.sets.at(-1)!.items.find(item => item.key === 'hermes-skills')!.value) as Record<string, string>;

  it('propone una vez, el dueño aprueba y la skill llega a la VM sin tocar las demás', async () => {
    await publish();
    let view = await hub.catalogFor('u1', BUSINESS, 'belleza_y_cuidado_personal');
    expect(view.available.map(item => item.id)).toEqual(['skill.beauty.process']);
    const approval = await approvals.propose('u1', {business_id: BUSINESS, kind: 'install_skill', item_id: 'skill.beauty.process'});
    view = await hub.catalogFor('u1', BUSINESS);
    expect(view.industry_slug).toBe('belleza_y_cuidado_personal');
    expect(view.available).toEqual([]);
    const done = await approvals.approve('u1', approval.id, 'decision-0001');
    expect(done.status).toBe('executed');
    expect(Object.keys(skillsOnVm()).sort()).toEqual(['saleads-business-brain/SKILL.md', 'saleads-collective/skill.beauty.process/SKILL.md']);
    expect((await hub.catalogFor('u1', BUSINESS)).installed.map(item => item.id)).toEqual(['skill.beauty.process']);
  });

  it('un ítem rechazado no vuelve a aparecer', async () => {
    await publish();
    const approval = await approvals.propose('u1', {business_id: BUSINESS, kind: 'install_skill', item_id: 'skill.beauty.process'});
    await approvals.reject('u1', approval.id, 'decision-0001');
    expect((await hub.catalogFor('u1', BUSINESS, 'belleza_y_cuidado_personal')).available).toEqual([]);
  });

  it('si el ítem cambió de versión, la aprobación queda STALE y no instala', async () => {
    await publish();
    const approval = await approvals.propose('u1', {business_id: BUSINESS, kind: 'install_skill', item_id: 'skill.beauty.process'});
    await publish('skill.beauty.process', 'Para novias funciona publicar testimonios aprobados por el dueño, nunca inventados ni editados.');
    await expect(approvals.approve('u1', approval.id, 'decision-0001')).rejects.toMatchObject({code: 'APPROVAL_STALE'});
    expect(instances.sets).toEqual([]);
  });

  it('un ítem retirado se ofrece para desinstalar; desinstalar lo quita de la VM', async () => {
    await publish();
    const install = await approvals.propose('u1', {business_id: BUSINESS, kind: 'install_skill', item_id: 'skill.beauty.process'});
    await approvals.approve('u1', install.id, 'decision-0001');
    await hub.retire('owner', 'skill.beauty.process');
    const view = await hub.catalogFor('u1', BUSINESS);
    expect(view.retired_installed.map(item => item.id)).toEqual(['skill.beauty.process']);
    const uninstall = await approvals.propose('u1', {business_id: BUSINESS, kind: 'uninstall_skill', item_id: 'skill.beauty.process'});
    expect((await approvals.approve('u1', uninstall.id, 'decision-0002')).status).toBe('executed');
    expect(Object.keys(skillsOnVm())).toEqual(['saleads-business-brain/SKILL.md']);
  });

  it('superar el tamaño máximo da error, nunca un truncado', () => {
    const big = [{item_id: 'skill.big', files: {'SKILL.md': 'x'.repeat(MAX_SKILLS_METADATA_BYTES)}}];
    expect(() => writer.compose(big, [])).toThrow(SkillsTooLargeError);
  });

  it('rutas inseguras de archivos del catálogo se ignoran', () => {
    const value = JSON.parse(writer.compose([{item_id: 'skill.x', files: {'../../etc/passwd': 'bad', 'SKILL.md': 'ok'}}], [])) as Record<string, string>;
    expect(Object.keys(value).sort()).toEqual(['saleads-business-brain/SKILL.md', 'saleads-collective/skill.x/SKILL.md']);
  });

  it('install_mcp todavía no tiene ítems: proponerlo responde 404', async () => {
    await expect(approvals.propose('u1', {business_id: BUSINESS, kind: 'install_mcp', item_id: 'mcp.calendar'})).rejects.toMatchObject({code: 'NOT_FOUND'});
  });
});
