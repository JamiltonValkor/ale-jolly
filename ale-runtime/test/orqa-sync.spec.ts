import {cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configuration} from '../src/config';
import {gunzipSync} from 'node:zlib';
import {BRAIN_MCP_URL, hermesConfig, initialHermesMetadata, jobTextHash, loadAgentBundle, type AgentBundle} from '../src/activation/hermes-files';
import {hermesProfiles, profileConfig} from '../src/activation/profiles';
import {ReadinessStateReader} from '../src/lifecycle/readiness-state-reader';
import {readySyncCallback} from '../src/orqa/orqa-sync';
import {AssistantRepository, type AssistantEvent, type AssistantRow} from '../src/persistence/assistant-repository';
import {SkillsWriter} from '../src/skills/skills-writer';
import {FakeInstances, INSTANCE, NO_MODEL, VM_IP, API_SERVER_KEY} from './support/hermes-fakes';
import {BRAIN_IMAGE, BUNDLE, mcp, setup, USER} from './support/orqa-fakes';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';

const BUNDLE_13 = loadAgentBundle('distribution/saleads-sales-agent/1.3.0', 'saleads-sales-agent@1.3.0');

describe('hermes-files con ORQA (OSB-009)', () => {
  it('hermes-config registra el MCP del cerebro solo con ORQA encendido; las skills del bundle son de solo lectura (D4)', () => {
    const on = hermesConfig({mcp, timezone: 'America/New_York'});
    expect(on).toContain('mcp_servers:\n  saleads:\n');
    expect(on).toContain(`  saleads-brain:\n    url: "${BRAIN_MCP_URL}"\n    tools:\n      exclude: ["web_*"]\ntimezone: "America/New_York"\n`);
    expect(on).toContain('skills:\n  write_approval: true\ncron:\n  wrap_response: false\ndisplay:\n  file_mutation_verifier: false\n');
    expect(on).toMatch(/\ntools:\n {2}tool_search:\n {4}enabled: "off"\nkanban:\n {2}max_in_progress: 2\n {2}auto_decompose: false\n {2}review_dispatch: false\n {2}auto_subscribe_on_create: true\n$/);
    expect(on).not.toContain('include:');
    const off = hermesConfig({mcp: {...mcp, brainMcpUrl: null}});
    expect(off).not.toMatch(/saleads-brain|tool_search|kanban/);
    expect(off).toContain('write_approval: true');
  });

  it('la metadata inicial lleva la imagen del cerebro solo si está configurada', () => {
    const base = {apiServerKey: 'k', bundle: BUNDLE, mcp, mcpTokens: '{}'};
    expect(initialHermesMetadata({...base, brainImage: BRAIN_IMAGE})['hermes-brain-image']).toBe(BRAIN_IMAGE);
    expect(initialHermesMetadata(base)).not.toHaveProperty('hermes-brain-image');
  });

  it('el bundle 1.2.0 trae 7 trabajos saleads:*; 1.1.0 ninguno; un jobs.json inválido detiene el arranque', () => {
    expect(BUNDLE.jobs.map(job => job.name)).toHaveLength(7);
    expect(BUNDLE.jobs.every(job => job.name.startsWith('saleads:'))).toBe(true);
    expect(loadAgentBundle('distribution/saleads-sales-agent/1.1.0', 'v').jobs).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), 'bundle-'));
    mkdirSync(join(dir, 'skills', 'a'), {recursive: true});
    writeFileSync(join(dir, 'SOUL.md'), '# x\n');
    writeFileSync(join(dir, 'skills', 'a', 'SKILL.md'), '---\nname: a\n---\n');
    writeFileSync(join(dir, 'jobs.json'), JSON.stringify({schema: 'saleads-jobs/1', jobs: [{name: 'saleads:x', schedule: '0 9 * * *', prompt: 'p', skills: ['missing']}]}));
    expect(() => loadAgentBundle(dir, 'v')).toThrow('BUNDLE_INVALID_JOBS');
    writeFileSync(join(dir, 'jobs.json'), JSON.stringify({schema: 'saleads-jobs/1', jobs: [{name: 'other', schedule: '0 9 * * *', prompt: 'p', skills: []}]}));
    expect(() => loadAgentBundle(dir, 'v')).toThrow('BUNDLE_INVALID_JOBS');
  });
});

describe('OrqaSync: config → ack → /health → jobs (OSB-009)', () => {
  it('gives a second admitted account the managed extensions and scoped Brain profiles without generic jobs', async () => {
    const bundle = loadAgentBundle('distribution/saleads-sales-agent/1.5.12', 'saleads-sales-agent@1.5.12');
    const other = 'unrelated-managed-owner';
    const ctx = setup({managedMeta: {enabled: true, userId: 'pilot-owner', allUsers: true}}, bundle);
    ctx.row.user_id = other;
    ctx.row.api_server_key_enc = ctx.cipher.seal('assistants.api_server_key_enc', other, API_SERVER_KEY);
    ctx.row.ai_provider = 'meta-ai'; ctx.row.ai_model = 'muse-spark-1.3-contributor';
    const guest = ctx.instances.guestAttribute.bind(ctx.instances);
    ctx.instances.guestAttribute = async (name, key) => key === 'hermes/watcher-version' ? '10' : guest(name, key);
    expect(await ctx.make().onReady(other, INSTANCE)).toBe('synced');
    expect(ctx.instances.item('hermes-brain-image')).toBe(BRAIN_IMAGE);
    expect(ctx.instances.item('hermes-extensions')).toBeTruthy();
    expect(ctx.instances.item('hermes-profiles')).toBe(hermesProfiles(bundle, [], {metaSearch: true, scopedMemory: true}));
    const profiles = gunzipSync(Buffer.from(ctx.instances.item('hermes-profiles')!, 'base64')).toString('utf8');
    expect(profiles).toContain('profiles/curador/profile-config.yaml');
    expect(profiles).toContain('saleads_memory');
    expect(profiles).toContain('saleads_research');
    expect(ctx.hermes.created).toEqual([]);
    expect(ctx.events.every(event => event.userId === other)).toBe(true);
  });

  it('escribe la metadata que difiere, espera el ack y la salud, y crea los 7 trabajos con deliver all', async () => {
    const {instances, hermes, make, events} = setup();
    await make().onReady(USER, INSTANCE);
    expect(instances.sets).toHaveLength(1);
    expect(instances.item('hermes-brain-image')).toBe(BRAIN_IMAGE);
    expect(instances.item('hermes-bundle-version')).toBe('saleads-sales-agent@1.2.0');
    expect(instances.item('hermes-soul')).toBe(BUNDLE.soul);
    expect(instances.item('hermes-config')).toContain('saleads-brain');
    expect(Object.keys(JSON.parse(instances.item('hermes-skills')!))).toContain('saleads-collective/skill.beauty.process/SKILL.md');
    expect(instances.item('hermes-mcp-tokens')).toBe('{"tokens.json":{"access_token":"mcp-SECRET"}}');
    expect(hermes.created.map(call => call.job.name)).toEqual(BUNDLE.jobs.map(job => job.name));
    expect(hermes.created.every(call => call.job.deliver === 'all' && call.target.ip === VM_IP && call.target.apiServerKey === API_SERVER_KEY)).toBe(true);
    expect(events.at(-1)).toMatchObject({kind: 'orqa.synced', detail: 'bundle=saleads-sales-agent@1.2.0 metadata_written=true jobs_created=7'});
    expect(JSON.stringify(events)).not.toContain(API_SERVER_KEY);
  });

  it('dos ejecuciones seguidas no duplican trabajos, incluidos los que el dueño pausó', async () => {
    const {hermes, make} = setup();
    await make().onReady(USER, INSTANCE);
    hermes.jobs[0]!.enabled = false;
    const second = make();
    await second.onReady(USER, INSTANCE);
    await second.onReady(USER, INSTANCE);
    expect(hermes.created).toHaveLength(7);
    expect(hermes.listCalls).toBe(2);
    expect(hermes.jobs).toHaveLength(7);
  });

  it('una VM recreada con el mismo nombre (borrar y reactivar) se vuelve a sincronizar', async () => {
    const {hermes, make} = setup();
    const sync = make();
    await sync.onReady(USER, INSTANCE, new Date('2027-10-20T09:00:00Z'));
    await sync.onReady(USER, INSTANCE, new Date('2027-10-20T09:00:00Z'));
    expect(hermes.listCalls).toBe(1);
    hermes.jobs.length = 0; // la VM nueva arranca sin trabajos
    await sync.onReady(USER, INSTANCE, new Date('2027-10-20T16:14:00Z'));
    expect(hermes.listCalls).toBe(2);
    expect(hermes.created).toHaveLength(14);
  });

  it('ningún trabajo se crea antes del ack', async () => {
    const {instances, hermes, make, events} = setup();
    instances.ackAfterPolls = null;
    await make().onReady(USER, INSTANCE);
    expect(hermes.listCalls).toBe(0);
    expect(hermes.created).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({kind: 'orqa.sync_failed', detail: 'reason=ack_timeout'});
  });

  it('ningún trabajo se crea si Hermes no responde sano', async () => {
    const {hermes, make, events} = setup();
    hermes.healthDefault = NO_MODEL;
    await make().onReady(USER, INSTANCE);
    expect(hermes.created).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({kind: 'orqa.sync_failed', detail: 'reason=health_timeout'});
  });

  it('tras un fallo no reintenta antes del plazo; un trabajo rechazado no expone el prompt', async () => {
    const {hermes, make, events} = setup();
    hermes.failCreate = {kind: 'rejected', status: 400};
    const sync = make();
    await sync.onReady(USER, INSTANCE);
    expect(events.at(-1)?.detail).toBe('reason=job_create name=saleads:proactive-digest status=400');
    hermes.failCreate = null;
    await sync.onReady(USER, INSTANCE);
    expect(hermes.created).toHaveLength(0);
  });

  it('con la metadata al día no escribe ni espera el ack', async () => {
    const {instances, make} = setup();
    await make().onReady(USER, INSTANCE);
    const sets = instances.sets.length;
    await make().onReady(USER, INSTANCE);
    expect(instances.sets).toHaveLength(sets);
  });

  it('sin imagen del cerebro ORQA queda apagado: no toca la VM', async () => {
    const {instances, hermes, make} = setup({brainImage: null});
    await make().onReady(USER, INSTANCE);
    expect(instances.sets).toHaveLength(0);
    expect(instances.getCalls).toBe(0);
    expect(hermes.listCalls).toBe(0);
  });
});

describe('readiness → onReady (OSB-009)', () => {
  it('GET /me con la fila ready dispara onReady sin esperar; una fila activando no', async () => {
    const {row, instances, hermes, cipher} = setup();
    const calls: Array<[string, string | null]> = [];
    let current = {...row, ai_configured: true, private_ip: VM_IP, updated_at: new Date(0), activation_started_at: new Date(0), ready_since: new Date(0)} as AssistantRow;
    const reader = new ReadinessStateReader({healthTimeoutMs: 100, budgetMs: 500, cacheTtlMs: 0, graceMs: 0}, {
      repository: {findActive: async () => current, appendEvent: async () => undefined} as never,
      readiness: {apply: async () => false} as never,
      instances, hermes, cipher,
      onReady: (userId, instanceName) => {calls.push([userId, instanceName]); throw new Error('ignored');},
    });
    expect((await reader.read(USER)).status).toBe('ready');
    expect(calls).toEqual([[USER, INSTANCE]]);
    current = {...current, status: 'activating', step: 'installing_agent'} as AssistantRow;
    await reader.read(USER);
    expect(calls).toHaveLength(1);
  });
});

describe('BRAIN_IMAGE (OSB-009)', () => {
  const base = {
    DATABASE_URL: 'postgresql://assistant:pw@127.0.0.1:5432/assistant_db',
    KEYCLOAK_ISSUER: 'https://keycloak-dev.saleads.ai/realms/sale-ads',
    KEYCLOAK_JWKS_URL: 'http://keycloak.keycloak.svc.cluster.local:8080/realms/sale-ads/protocol/openid-connect/certs',
    POSTHOG_API_KEY: 'phc_test',
    FIELD_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
  };

  it('vacío por defecto (ORQA apagado), acepta solo una imagen de saleads-brain fijada por digest y usa el bundle 1.3.0 (MLB-003)', () => {
    expect(configuration(base)).toMatchObject({BRAIN_IMAGE: '', ASSISTANT_BUNDLE_VERSION: 'saleads-sales-agent@1.3.0'});
    expect(configuration({...base, BRAIN_IMAGE}).BRAIN_IMAGE).toBe(BRAIN_IMAGE);
    expect(() => configuration({...base, BRAIN_IMAGE: BRAIN_IMAGE.replace(/@sha256:.*/, ':latest')})).toThrow('CONFIGURATION_INVALID');
    expect(() => configuration({...base, BRAIN_IMAGE: BRAIN_IMAGE.replace('saleads-brain/', 'campaign-service/')})).toThrow('CONFIGURATION_INVALID');
  });
});

describe('bundle 1.3.0 por tipo de negocio (MLB-003)', () => {
  const skillsOnVm = (instances: FakeInstances) => Object.keys(JSON.parse(instances.item('hermes-skills')!) as Record<string, string>);
  const typeSkills = (instances: FakeInstances) => [...new Set(skillsOnVm(instances).filter(path => path.startsWith('types/')).map(path => path.split('/')[2]))].sort();

  it('sin tipos confirmados: el bundle base y las funciones, sin skills de tipo', async () => {
    const {instances, make} = setup({}, BUNDLE_13);
    await make().onReady(USER, INSTANCE);
    expect(typeSkills(instances)).toEqual([]);
    expect(skillsOnVm(instances)).toEqual(expect.arrayContaining(['saleads-loop-orchestration/SKILL.md', 'functions/saleads-market-research/SKILL.md']));
  });

  it('un negocio infoproducto recibe su skill y no la de producto físico; con dos tipos recibe las dos', async () => {
    const one = setup({}, BUNDLE_13);
    one.types.push('infoproduct');
    await one.make().onReady(USER, INSTANCE);
    expect(typeSkills(one.instances)).toEqual(['saleads-type-infoproduct']);
    const two = setup({}, BUNDLE_13);
    two.types.push('infoproduct', 'physical_product');
    await two.make().onReady(USER, INSTANCE);
    expect(typeSkills(two.instances)).toEqual(['saleads-type-infoproduct', 'saleads-type-physical-product']);
  });

  it('cambiar el tipo resincroniza sin reiniciar el pod y no duplica saleads:loop-tick', async () => {
    const {instances, hermes, make, types} = setup({}, BUNDLE_13);
    const orqa = make();
    await orqa.onReady(USER, INSTANCE);
    await orqa.onReady(USER, INSTANCE);
    expect(typeSkills(instances)).toEqual([]);
    types.push('service');
    await orqa.resync(USER);
    expect(typeSkills(instances)).toEqual(['saleads-type-service']);
    expect(hermes.created.filter(call => call.job.name === 'saleads:loop-tick')).toHaveLength(1);
    expect(hermes.jobs.filter(job => job.name === 'saleads:loop-tick')).toHaveLength(1);
  });

  it('un resync antes de la readiness siembra el cerebro una vez y la readiness no lo repite (E2E 4-nov)', async () => {
    const run = async (wired: boolean) => {
      const {make, types} = setup({}, BUNDLE_13);
      const orqa = make(), seeded = jest.fn(async () => undefined);
      const onReady = readySyncCallback(orqa, async () => seeded(), true);
      if (wired) orqa.useReadyCallback(onReady);
      types.push('physical_product');
      await orqa.resync(USER);                 // el perfil del negocio cambió durante la activación
      await new Promise(setImmediate);
      await onReady(USER, INSTANCE, null);     // luego la readiness: misma clave, `done` ya marcado
      return seeded.mock.calls.length;
    };
    expect(await run(false)).toBe(0);          // el fallo: nadie sembraba el cerebro
    expect(await run(true)).toBe(1);
  });

  it('conserva todos los trabajos de 1.2.0 y las skills que cargan, y agrega saleads:loop-tick', () => {
    expect(BUNDLE_13.jobs.map(job => job.name)).toEqual([...BUNDLE.jobs.map(job => job.name), 'saleads:loop-tick']);
    const files = Object.keys(JSON.parse(BUNDLE_13.skills) as Record<string, string>);
    for (const job of BUNDLE.jobs) for (const skill of job.skills) expect(files).toContain(`${skill}/SKILL.md`);
  });

  it('instalar o desinstalar una skill del catálogo conserva las skills del tipo', async () => {
    const instances = new FakeInstances();
    const writer = new SkillsWriter(BUNDLE_13.skills, {findActive: async () => ({instance_name: INSTANCE}) as never}, instances, async () => ['infoproduct']);
    expect(await writer.apply(USER, [{item_id: 'skill.beauty.process', files: {'SKILL.md': '---\nname: beauty\n---\n'}}])).toBe('applied');
    expect(typeSkills(instances)).toEqual(['saleads-type-infoproduct']);
    expect(skillsOnVm(instances)).toContain('saleads-collective/skill.beauty.process/SKILL.md');
    expect(await writer.apply(USER, [])).toBe('applied');
    expect(typeSkills(instances)).toEqual(['saleads-type-infoproduct']);
    expect(skillsOnVm(instances).some(path => path.startsWith('saleads-collective/'))).toBe(false);
  });

  it('ningún valor de metadata supera 240.000 bytes, ni con los tres tipos', () => {
    const writer = new SkillsWriter(BUNDLE_13.skills, {findActive: async () => null}, new FakeInstances(), async () => []);
    const all = writer.compose([], ['physical_product', 'service', 'infoproduct']);
    expect(Buffer.byteLength(all, 'utf8')).toBeLessThanOrEqual(240_000);
    const metadata = initialHermesMetadata({apiServerKey: 'k', bundle: BUNDLE_13, mcp, mcpTokens: '{}'});
    for (const value of Object.values(metadata)) expect(Buffer.byteLength(value ?? '', 'utf8')).toBeLessThanOrEqual(240_000);
    expect(Object.keys(JSON.parse(metadata['hermes-skills']!) as Record<string, string>).some(path => path.startsWith('types/'))).toBe(false);
  });
});

describe('equipo de especialistas en hermes-profiles (MLB-005b)', () => {
  const untar = (value: string): Record<string, string> => {
    const raw = gunzipSync(Buffer.from(value, 'base64'));
    const files: Record<string, string> = {};
    for (let offset = 0; offset + 512 <= raw.length;) {
      const header = raw.subarray(offset, offset + 512);
      if (header.every(byte => byte === 0)) break;
      const field = (start: number, length: number) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
      const name = [field(345, 155), field(0, 100)].filter(Boolean).join('/');
      const size = Number.parseInt(field(124, 12), 8);
      files[name] = raw.subarray(offset + 512, offset + 512 + size).toString('utf8');
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    return files;
  };
  const withWatcher = (instances: FakeInstances, version: string | null) => {
    const ack = instances.guestAttribute.bind(instances);
    instances.guestAttribute = async (name, key) => key === 'hermes/watcher-version' ? version : ack(name, key);
  };

  it('cada especialista tiene su SOUL, su capa de config y sus skills; las de tipo solo con el tipo confirmado', () => {
    const files = untar(hermesProfiles(BUNDLE_13, ['infoproduct'])!);
    expect(Object.keys(BUNDLE_13.profiles).sort()).toEqual(['analista', 'estratega', 'estructurador', 'investigador', 'optimizador']);
    expect(files['profiles/investigador/skills/saleads-market-research/SKILL.md']).toContain('name: saleads-market-research');
    expect(files['profiles/estratega/skills/saleads-type-infoproduct/SKILL.md']).toContain('name: saleads-type-infoproduct');
    expect(Object.keys(files).some(path => path.includes('saleads-type-physical-product'))).toBe(false);
    expect(Object.keys(files).some(path => path.startsWith('profiles/analista/skills/saleads-type-'))).toBe(false);
    expect(files['profiles/analista/SOUL.md']).toContain('Analista del equipo de Ale');
    expect(Object.keys(files).every(path => /^profiles\/[a-z]+\/(SOUL\.md|profile-config\.yaml|skills\/.+)$/.test(path))).toBe(true);
  });

  it('la config de un especialista lleva sus filtros (SaleADS de solo lectura, sin escrituras del cerebro) y solo el investigador ve web_*', () => {
    const analista = profileConfig('analista');
    expect(analista).toContain('include: ["saleads_get_*", "saleads_list_*", "saleads_search_locations"]');
    expect(analista).toMatch(/exclude: \[[^\]]*"brain_record_learning"[^\]]*"brain_record_feedback"[^\]]*"web_\*"\]/);
    expect(analista).toContain('cli: ["skills", "memory", "todo", "session_search"]');
    expect(profileConfig('investigador')).not.toContain('web_*');
    expect(hermesConfig({mcp})).not.toContain('brain_record_learning');
    // AAB-013: el flush de la foto y los hechos tipados son solo de Ale.
    for (const name of ['analista', 'investigador', 'estratega']) {
      expect(profileConfig(name)).toContain('"brain_snapshot_flush"');
      expect(profileConfig(name)).toContain('"brain_record_fact"');
    }
  });

  it('determinista y bajo el tope, aun con los tres tipos', () => {
    const all = hermesProfiles(BUNDLE_13, ['physical_product', 'service', 'infoproduct'])!;
    expect(hermesProfiles(BUNDLE_13, ['physical_product', 'service', 'infoproduct'])).toBe(all);
    expect(Buffer.byteLength(all)).toBeLessThanOrEqual(240_000);
    expect(hermesProfiles(BUNDLE, [])).toBeNull();
  });

  it('una VM sin watcher-version compatible no recibe hermes-profiles y su sync no falla', async () => {
    for (const version of [null, '2']) {
      const {instances, make, events} = setup({}, BUNDLE_13);
      withWatcher(instances, version);
      await make().onReady(USER, INSTANCE);
      expect(instances.item('hermes-profiles')).toBeUndefined();
      expect(events.at(-1)).toMatchObject({kind: 'orqa.synced'});
    }
  });

  it('con watcher 3 hermes-profiles entra en el ack y una segunda sync no lo reenvía', async () => {
    const {instances, make, events} = setup({}, BUNDLE_13);
    withWatcher(instances, '3');
    await make().onReady(USER, INSTANCE);
    expect(untar(instances.item('hermes-profiles')!)['profiles/optimizador/SOUL.md']).toContain('Optimizador');
    expect(events.at(-1)).toMatchObject({kind: 'orqa.synced'});
    expect(instances.sets).toHaveLength(1);
    await make().onReady(USER, INSTANCE);
    expect(instances.sets).toHaveLength(1);
  });
});

describe('especialistas solo con lecturas del canal del agente (MCB-012)', () => {
  /** Las 27 lecturas del catálogo del MCP (`mcp@4434428:contracts/schemas/`) más una nueva inventada. */
  const WEB_FLOW = [
    'saleads_get_strategy', 'saleads_get_plan', 'saleads_list_plans', 'saleads_get_growth_cycle', 'saleads_get_launch_status',
    'saleads_get_cycle_sales', 'saleads_get_special_plan', 'saleads_get_special_plan_copies', 'saleads_get_special_plan_status',
    'saleads_list_special_plans', 'saleads_list_special_dates', 'saleads_get_help', 'saleads_list_skill_catalog', 'saleads_list_events',
    'saleads_list_event_subscriptions', 'saleads_get_operation', 'saleads_get_account_overview',
  ];
  const includeOf = (layer: string) => JSON.parse(/ {2}saleads:\n {4}tools:\n {6}include: (\[[^\n]*\])/.exec(layer)![1]!) as string[];
  const NAMES = ['investigador', 'estratega', 'estructurador', 'analista', 'optimizador'];

  it('4 · flag apagada = la capa de hoy, byte a byte (mismo hermes-profiles, mismo ack)', () => {
    expect(profileConfig('analista')).toBe([
      'mcp_servers:', '  saleads:', '    tools:', '      include: ["saleads_get_*", "saleads_list_*", "saleads_search_locations"]',
      '  saleads-brain:', '    tools:',
      '      exclude: ["brain_record_learning", "brain_record_feedback", "brain_ingest", "brain_loops_open", "brain_loops_close", "brain_lessons_pending", "brain_lesson_mark", "brain_record_fact", "brain_snapshot_flush", "web_*"]',
      'platform_toolsets:', '  cli: ["skills", "memory", "todo", "session_search"]', '',
    ].join('\n'));
    for (const name of NAMES) expect(profileConfig(name, {explicitReads: false})).toBe(profileConfig(name));
    expect(hermesProfiles(BUNDLE_13, ['service'], {explicitReads: false})).toBe(hermesProfiles(BUNDLE_13, ['service']));
  });

  it('con la flag, cada especialista trae exactamente su lista, sin comodines ni tools del flujo web', () => {
    expect(includeOf(profileConfig('investigador', {explicitReads: true}))).toEqual(['saleads_get_business_profile', 'saleads_list_offerings']);
    expect(includeOf(profileConfig('estratega', {explicitReads: true}))).toEqual(['saleads_get_business_profile', 'saleads_get_business_bootstrap', 'saleads_list_offerings']);
    for (const name of NAMES) {
      const include = includeOf(profileConfig(name, {explicitReads: true}));
      expect(include.some(tool => /[*?[]/.test(tool))).toBe(false);
      expect(include.filter(tool => WEB_FLOW.includes(tool))).toEqual([]);
      expect(include.every(tool => /^saleads_(get|list|search)_/.test(tool))).toBe(true);
    }
  });

  it('1 · el estructurador lee la cuenta, las ofertas, Meta y las ubicaciones para armar su árbol, y no get_strategy', () => {
    const include = includeOf(profileConfig('estructurador', {explicitReads: true}));
    expect(include).toEqual(expect.arrayContaining(['saleads_get_meta_status', 'saleads_list_offerings', 'saleads_search_locations', 'saleads_list_campaigns']));
    expect(include).not.toContain('saleads_get_strategy');
  });

  it('2 · el analista conserva todo lo que hoy le da el veredicto de una campaña [Ale]: cajas, anuncios, salud y resultados', () => {
    const include = includeOf(profileConfig('analista', {explicitReads: true}));
    expect(include).toEqual(expect.arrayContaining([
      'saleads_list_campaigns', 'saleads_get_campaign_ads', 'saleads_get_box_metrics', 'saleads_get_campaign_health', 'saleads_get_results',
    ]));
    expect(includeOf(profileConfig('optimizador', {explicitReads: true}))).toEqual(expect.arrayContaining(include));
  });

  it('3 · una tool nueva del MCP (lectura o escritura) no aparece en ningún especialista', () => {
    const matches = (pattern: string, tool: string) => new RegExp(`^${pattern.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(tool);
    for (const name of NAMES) {
      const include = includeOf(profileConfig(name, {explicitReads: true}));
      for (const tool of ['saleads_get_x', 'saleads_list_x', 'saleads_agent_publish_campaign']) expect(include.some(pattern => matches(pattern, tool))).toBe(false);
    }
    // Con la flag apagada, los comodines de hoy sí dejaban pasar una lectura nueva.
    expect(includeOf(profileConfig('analista')).some(pattern => matches(pattern, 'saleads_get_x'))).toBe(true);
  });

  it('la flag llega a hermes-profiles por OrqaSync', async () => {
    const off = setup({}, BUNDLE_13);
    const on = setup({explicitReads: true}, BUNDLE_13);
    for (const ctx of [off, on]) {
      const ack = ctx.instances.guestAttribute.bind(ctx.instances);
      ctx.instances.guestAttribute = async (name, key) => key === 'hermes/watcher-version' ? '5' : ack(name, key);
      await ctx.make().onReady(USER, INSTANCE);
    }
    const layer = (ctx: typeof on) => {
      const raw = gunzipSync(Buffer.from(ctx.instances.item('hermes-profiles')!, 'base64')).toString('utf8');
      return raw.slice(raw.indexOf('mcp_servers:'), raw.indexOf('\n', raw.indexOf('include:')));
    };
    expect(layer(off)).toContain('"saleads_get_*"');
    expect(layer(on)).not.toContain('"saleads_get_*"');
    expect(layer(on)).toContain('"saleads_get_business_profile"');
  });
});

describe('búsqueda web del investigador con la suscripción (MCB-010)', () => {
  const NAMES = ['investigador', 'estratega', 'estructurador', 'analista', 'optimizador'];
  const NATIVE = 'platform_toolsets:\n  cli: ["skills", "memory", "todo", "session_search", "web"]\nweb:\n  search_backend: "openai-native"\n  keyless_fallback: false\n';

  it('con la opción, el investigador suma web con openai-native y sin el anillo gratuito; los otros cuatro no cambian', () => {
    expect(profileConfig('investigador', {nativeSearch: true}).endsWith(NATIVE)).toBe(true);
    for (const name of NAMES.filter(name => name !== 'investigador')) expect(profileConfig(name, {nativeSearch: true})).toBe(profileConfig(name));
    // Se combina con las lecturas exactas de MCB-012 sin pisarlas.
    const both = profileConfig('investigador', {nativeSearch: true, explicitReads: true});
    expect(both).toContain('include: ["saleads_get_business_profile", "saleads_list_offerings"]');
    expect(both.endsWith(NATIVE)).toBe(true);
  });

  it('5 · flag apagada = misma capa y mismo hermes-profiles', () => {
    expect(profileConfig('investigador', {nativeSearch: false})).toBe(profileConfig('investigador'));
    expect(profileConfig('investigador')).not.toMatch(/search_backend|"web"\]/);
    expect(hermesProfiles(BUNDLE_13, [], {nativeSearch: false})).toBe(hermesProfiles(BUNDLE_13, []));
  });

  it('sin tope de búsquedas (D19) y sin keys de buscador en la capa (D17): solo el backend nativo', () => {
    const layer = profileConfig('investigador', {nativeSearch: true});
    expect(layer).not.toMatch(/max|limit|quota|budget|count|per_turn|tavily|exa|firecrawl|parallel|keenable|api_key|_KEY/i);
  });

  const layerOf = async (options: Parameters<typeof setup>[0], provider: string) => {
    const ctx = setup(options, BUNDLE_13);
    (ctx.row as {ai_provider: string}).ai_provider = provider;
    const ack = ctx.instances.guestAttribute.bind(ctx.instances);
    ctx.instances.guestAttribute = async (name, key) => key === 'hermes/watcher-version' ? '6' : ack(name, key);
    await ctx.make().onReady(USER, INSTANCE);
    const raw = gunzipSync(Buffer.from(ctx.instances.item('hermes-profiles')!, 'base64')).toString('utf8');
    return {value: ctx.instances.item('hermes-profiles'), hasNative: raw.includes('search_backend: "openai-native"')};
  };

  it('por fila: solo un dueño con openai-codex recibe la búsqueda nativa; con openrouter, la capa de la flag apagada', async () => {
    const codex = await layerOf({researcherNativeSearch: true}, 'openai-codex');
    const openrouter = await layerOf({researcherNativeSearch: true}, 'openrouter');
    const off = await layerOf({}, 'openai-codex');
    expect(codex.hasNative).toBe(true);
    expect(openrouter.hasNative).toBe(false);
    expect(openrouter.value).toBe(off.value);
  });
});

/**
 * Raíz de bundles como la de la imagen (`distribution/saleads-sales-agent/*`): 1.5.9 real y un 1.5.10 sintético
 * con el loop-tick nuevo (el 1.5.10 real llega con MCB-001) y una vuelta nueva.
 */
const NEW_TICK = 'Vuelta del loop de marketing. Tu trabajo en esta vuelta es HACER AVANZAR la apuesta abierta.';
function bundles(changeShareLessons = false): {v159: AgentBundle; v1510: AgentBundle} {
  const root = join(mkdtempSync(join(tmpdir(), 'bundles-')), 'saleads-sales-agent');
  cpSync('distribution/saleads-sales-agent/1.5.9', join(root, '1.5.9'), {recursive: true});
  cpSync('distribution/saleads-sales-agent/1.5.9', join(root, '1.5.10'), {recursive: true});
  const path = join(root, '1.5.10', 'jobs.json');
  const body = JSON.parse(readFileSync(path, 'utf8')) as {schema: string; jobs: Array<{name: string; schedule: string; prompt: string; skills: string[]}>};
  const tick = body.jobs.find(job => job.name === 'saleads:loop-tick')!;
  tick.prompt = NEW_TICK;
  tick.skills = ['saleads-loop-orchestration', 'saleads-cli'];
  if (changeShareLessons) body.jobs.find(job => job.name === 'saleads:share-lessons')!.prompt = 'Comparte las lecciones del día (1.5.10).';
  body.jobs.push({name: 'saleads:nueva-vuelta', schedule: '0 7 * * *', prompt: 'Vuelta nueva de 1.5.10.', skills: ['saleads-cli']});
  writeFileSync(path, JSON.stringify(body));
  return {
    v159: loadAgentBundle(join(root, '1.5.9'), 'saleads-sales-agent@1.5.9'),
    v1510: loadAgentBundle(join(root, '1.5.10'), 'saleads-sales-agent@1.5.10'),
  };
}

describe('vueltas de SaleADS en asistentes existentes (MCB-003, D21/D24)', () => {
  const {v159, v1510} = bundles();
  const tick159 = v159.jobs.find(job => job.name === 'saleads:loop-tick')!;

  /** Una VM que ya quedó sincronizada con 1.5.9: sus 8 vueltas, creadas por el REST de SaleADS. */
  function existingVm(updateJobs: boolean, pair = {v159, v1510}) {
    const ctx = setup({updateJobs}, pair.v1510);
    for (const job of pair.v159.jobs) ctx.hermes.add({name: job.name, prompt: job.prompt, skills: [...job.skills], schedule: job.schedule});
    ctx.history.push(v159.version);
    return ctx;
  }
  const tickOf = (hermes: {jobs: Array<{name: string; id: string}>}) => hermes.jobs.find(job => job.name === 'saleads:loop-tick')!;
  const kinds = (events: AssistantEvent[], kind: string) => events.filter(event => event.kind === kind).map(event => event.detail);

  it('el catálogo del bundle reconoce el texto de cada versión anterior: el loop-tick de 1.5.9 está en el de 1.5.10', () => {
    expect(v1510.knownJobHashes['saleads:loop-tick']).toContain(jobTextHash(tick159.prompt, tick159.skills));
    expect(v1510.knownJobHashes['saleads:loop-tick']).toContain(jobTextHash(NEW_TICK, ['saleads-loop-orchestration', 'saleads-cli']));
    expect(v1510.jobNamesByVersion['saleads-sales-agent@1.5.9']).toHaveLength(8);
    expect(v1510.jobNamesByVersion['saleads-sales-agent@1.5.10']).toContain('saleads:nueva-vuelta');
    // La imagen real trae todas las versiones: el catálogo de 1.5.9 conoce las de 1.1.0 a 1.5.9.
    const real = loadAgentBundle('distribution/saleads-sales-agent/1.5.9', 'saleads-sales-agent@1.5.9');
    expect(Object.keys(real.jobNamesByVersion)).toEqual(expect.arrayContaining(['saleads-sales-agent@1.2.0', 'saleads-sales-agent@1.5.9']));
  });

  it('flag apagada: la VM existente no recibe ningún PATCH (comportamiento de hoy) y lo que falta se crea', async () => {
    const {hermes, make, events} = existingVm(false);
    await make().onReady(USER, INSTANCE);
    expect(hermes.updates).toHaveLength(0);
    expect(tickOf(hermes)).toMatchObject({prompt: tick159.prompt});
    expect(hermes.created.map(call => call.job.name)).toEqual(['saleads:nueva-vuelta']);
    expect(events.at(-1)).toMatchObject({kind: 'orqa.synced', detail: 'bundle=saleads-sales-agent@1.5.10 metadata_written=true jobs_created=1'});
  });

  it('1 y 10 · la versión nueva llega al asistente que ya existe: un PATCH al loop-tick con prompt y skills, sin horario', async () => {
    const {hermes, make, events} = existingVm(true);
    await make().onReady(USER, INSTANCE);
    expect(hermes.updates).toEqual([{id: tickOf(hermes).id, patch: {prompt: NEW_TICK, skills: ['saleads-loop-orchestration', 'saleads-cli']}}]);
    expect(tickOf(hermes)).toMatchObject({prompt: NEW_TICK, skills: ['saleads-loop-orchestration', 'saleads-cli'], schedule: tick159.schedule});
    expect(kinds(events, 'orqa.job_updated')).toEqual([expect.stringMatching(/^name=saleads:loop-tick fields=prompt,skills from=[0-9a-f]{12} to=[0-9a-f]{12}$/)]);
    expect(events.at(-1)).toMatchObject({kind: 'orqa.synced', detail: 'bundle=saleads-sales-agent@1.5.10 metadata_written=true jobs_created=1 jobs_updated=1 jobs_update_failed=0'});
  });

  it('2 · solo se tocan las vueltas de SaleADS: ni las del dueño, ni las de Ale, ni el cerebro, aunque usen el nombre', async () => {
    const {hermes, make, events} = setup({updateJobs: true}, v1510);
    hermes.add({name: 'mi-recordatorio', prompt: 'recuérdame pagar', origin: {platform: 'telegram', chatId: '123'}});
    hermes.add({name: 'saleads:mi-vuelta', prompt: 'una vuelta mía'});
    hermes.add({name: 'saleads:brain-decay', prompt: 'decay', origin: {platform: null, chatId: null}});
    for (const job of v1510.jobs.filter(job => job.name !== 'saleads:loop-tick')) hermes.add({name: job.name, prompt: job.prompt, skills: [...job.skills]});
    // Ale creó su propio loop-tick desde su sesión, con el texto viejo de SaleADS.
    hermes.add({name: 'saleads:loop-tick', prompt: tick159.prompt, skills: [...tick159.skills], origin: {platform: 'cli', chatId: null}});
    await make().onReady(USER, INSTANCE);
    expect(hermes.updates).toHaveLength(0);
    expect(hermes.created).toHaveLength(0);
    expect(kinds(events, 'orqa.job_update_skipped')).toEqual(['name=saleads:loop-tick reason=not_saleads_origin']);
  });

  it('3 · se respeta el apagado: el PATCH no lleva enabled y la vuelta pausada sigue pausada', async () => {
    const {hermes, make} = existingVm(true);
    const tick = hermes.jobs.find(job => job.name === 'saleads:loop-tick')!;
    tick.enabled = false;
    await make().onReady(USER, INSTANCE);
    expect(hermes.updates).toHaveLength(1);
    expect(hermes.updates[0]!.patch).not.toHaveProperty('enabled');
    expect(tick).toMatchObject({enabled: false, prompt: NEW_TICK});
  });

  it('4 · solo cambia el texto: cada PATCH es un subconjunto de {prompt, skills}; el horario que cambió el dueño se queda', async () => {
    const {hermes, make} = existingVm(true);
    const tick = hermes.jobs.find(job => job.name === 'saleads:loop-tick')!;
    tick.schedule = '0 */6 * * *';
    await make().onReady(USER, INSTANCE);
    for (const {patch} of hermes.updates) expect(Object.keys(patch).every(key => key === 'prompt' || key === 'skills')).toBe(true);
    expect(tick.schedule).toBe('0 */6 * * *');
  });

  it('5 · idempotente: otro pod con el mismo bundle no manda ningún PATCH', async () => {
    const {hermes, make, history} = existingVm(true);
    await make().onReady(USER, INSTANCE);
    history.push(v1510.version);
    const before = hermes.updates.length;
    await make().onReady(USER, INSTANCE);
    expect(hermes.updates).toHaveLength(before);
    expect(hermes.created).toHaveLength(1);
  });

  it('6 · un fallo se registra sin el prompt y no rompe nada: la otra vuelta se actualiza, la sync termina y no reintenta', async () => {
    const {hermes, make, events} = existingVm(true, bundles(true));
    hermes.failUpdate['saleads:loop-tick'] = {kind: 'rejected', status: 400};
    const sync = make();
    await sync.onReady(USER, INSTANCE);
    expect(kinds(events, 'orqa.job_update_failed')).toEqual(['name=saleads:loop-tick outcome=rejected status=400']);
    expect(kinds(events, 'orqa.job_updated')).toEqual([expect.stringMatching(/^name=saleads:share-lessons fields=prompt /)]);
    expect(hermes.jobs.find(job => job.name === 'saleads:share-lessons')!.prompt).toBe('Comparte las lecciones del día (1.5.10).');
    expect(JSON.stringify(events)).not.toContain(NEW_TICK);
    expect(JSON.stringify(events)).not.toContain('Comparte las lecciones');
    expect(events.at(-1)).toMatchObject({kind: 'orqa.synced', detail: expect.stringContaining('jobs_updated=1 jobs_update_failed=1')});
    expect(hermes.created.map(call => call.job.name)).toEqual(['saleads:nueva-vuelta']);
    const calls = hermes.updates.length;
    await sync.onReady(USER, INSTANCE);
    expect(hermes.updates).toHaveLength(calls);
  });

  it('7 · nombres duplicados: dos saleads:loop-tick de SaleADS → ningún PATCH', async () => {
    const {hermes, make, events} = existingVm(true);
    hermes.add({name: 'saleads:loop-tick', prompt: tick159.prompt, skills: [...tick159.skills]});
    await make().onReady(USER, INSTANCE);
    expect(hermes.updates).toHaveLength(0);
    expect(kinds(events, 'orqa.job_update_skipped')).toEqual(['name=saleads:loop-tick reason=duplicate_name']);
  });

  it('8 · lo que falta y es nuevo en el bundle se sigue creando', async () => {
    const {hermes, make} = existingVm(true);
    await make().onReady(USER, INSTANCE);
    expect(hermes.created.map(call => call.job)).toEqual([{name: 'saleads:nueva-vuelta', schedule: '0 7 * * *', prompt: 'Vuelta nueva de 1.5.10.', skills: ['saleads-cli'], deliver: 'all'}]);
  });

  it('9 · lo editado por el dueño o Ale se respeta: un loop-tick de SaleADS con otro texto no recibe PATCH', async () => {
    const {hermes, make, events} = existingVm(true);
    const tick = hermes.jobs.find(job => job.name === 'saleads:loop-tick')!;
    tick.prompt = 'Revisa solo la campaña de diciembre, me lo pidió el dueño.';
    await make().onReady(USER, INSTANCE);
    expect(hermes.updates).toHaveLength(0);
    expect(tick.prompt).toBe('Revisa solo la campaña de diciembre, me lo pidió el dueño.');
    expect(kinds(events, 'orqa.job_update_skipped')).toEqual([expect.stringMatching(/^name=saleads:loop-tick reason=edited from=[0-9a-f]{12}$/)]);
  });

  it('D24 · la vuelta que el dueño borró no se recrea; una VM nueva (sin historia) sí la recibe', async () => {
    const deleted = existingVm(true);
    deleted.hermes.jobs = deleted.hermes.jobs.filter(job => job.name !== 'saleads:monthly-review');
    await deleted.make().onReady(USER, INSTANCE);
    expect(deleted.hermes.created.map(call => call.job.name)).toEqual(['saleads:nueva-vuelta']);
    expect(kinds(deleted.events, 'orqa.job_update_skipped')).toEqual(['name=saleads:monthly-review reason=deleted']);
    const fresh = setup({updateJobs: true}, v1510);
    await fresh.make().onReady(USER, INSTANCE);
    expect(fresh.hermes.created.map(call => call.job.name)).toEqual(v1510.jobs.map(job => job.name));
  });

  it('D24 con la flag apagada: se recrea como hoy', async () => {
    const {hermes, make} = existingVm(false);
    hermes.jobs = hermes.jobs.filter(job => job.name !== 'saleads:monthly-review');
    await make().onReady(USER, INSTANCE);
    expect(hermes.created.map(call => call.job.name)).toEqual(['saleads:monthly-review', 'saleads:nueva-vuelta']);
  });
});

describe('historia de sincronizaciones de la VM (MCB-003, D24) en Postgres', () => {
  let db: TestDatabase;
  beforeAll(async () => {db = await startTestDatabase();});
  afterAll(async () => {await db.close();});

  const event = (userId: string, kind: string, detail: string, at: string) => db.database.pool.query(
    'INSERT INTO assistant.assistant_events (user_id, kind, phase, detail_safe, at) VALUES ($1, $2, $3, $4, $5)', [userId, kind, 'orqa', detail, at]);

  it('solo cuenta las orqa.synced de esta VM: desde created_at y después de la última creación de VM', async () => {
    const repository = new AssistantRepository(db.database);
    const other = '22222222-2222-4222-8222-222222222222';
    await event(USER, 'orqa.synced', 'bundle=saleads-sales-agent@1.2.0 metadata_written=true jobs_created=7', '2027-09-01T00:00:00Z');
    await event(USER, 'vm.create_requested', 'attempt=1 result=created', '2027-10-01T00:00:00Z');
    await event(USER, 'orqa.synced', 'bundle=saleads-sales-agent@1.5.8 metadata_written=true jobs_created=8', '2027-10-02T00:00:00Z');
    await event(USER, 'orqa.synced', 'bundle=saleads-sales-agent@1.5.9 metadata_written=true jobs_created=0 jobs_updated=0 jobs_update_failed=0', '2027-10-20T00:00:00Z');
    await event(USER, 'orqa.sync_failed', 'reason=ack_timeout', '2027-10-21T00:00:00Z');
    await event(other, 'orqa.synced', 'bundle=saleads-sales-agent@1.4.0 metadata_written=true jobs_created=8', '2027-10-05T00:00:00Z');
    expect(await repository.syncedBundleVersions(USER, new Date('2027-09-15T00:00:00Z')))
      .toEqual(['saleads-sales-agent@1.5.8', 'saleads-sales-agent@1.5.9']);
    // Una fila reactivada (created_at nuevo) no hereda la historia de la VM anterior.
    expect(await repository.syncedBundleVersions(USER, new Date('2027-10-25T00:00:00Z'))).toEqual([]);
    await event(USER, 'vm.create_requested', 'attempt=1 result=created', '2027-10-22T00:00:00Z');
    expect(await repository.syncedBundleVersions(USER, new Date('2027-09-15T00:00:00Z'))).toEqual([]);
  });
});
