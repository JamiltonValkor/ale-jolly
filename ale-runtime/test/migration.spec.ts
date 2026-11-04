import {execFileSync} from 'node:child_process';
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * Aplica las migraciones Flyway sobre un Postgres vacío (PGlite en un proceso
 * aparte, sin Docker). No sustituye la validación con Flyway real en Cloud Build
 * (migrations/README.md).
 */
const dir = join(__dirname, '..', 'migrations');
const V1 = readFileSync(join(dir, 'V1__assistant_schema.sql'), 'utf8');
const V2 = readFileSync(join(dir, 'V2__assistant_timezone.sql'), 'utf8');
const V4 = readFileSync(join(dir, 'V4__assistant_approvals.sql'), 'utf8');
const V5 = readFileSync(join(dir, 'V5__brain_hub.sql'), 'utf8');
const V6 = readFileSync(join(dir, 'V6__business_profiles.sql'), 'utf8');
const V7 = readFileSync(join(dir, 'V7__spend_approvals.sql'), 'utf8');
const V9 = readFileSync(join(dir, 'V9__agent_activation_and_budget.sql'), 'utf8');
const V12 = readFileSync(join(dir, 'V12__catalog_kit_belleza.sql'), 'utf8');

interface Step {op: 'exec' | 'query'; sql: string}
interface Result {ok: boolean; rows?: Array<Record<string, unknown>>; error?: string}

function run(steps: Step[]): Result[] {
  const output = execFileSync(process.execPath, [join(__dirname, 'support', 'pglite-runner.mjs')], {
    input: JSON.stringify(steps), encoding: 'utf8', timeout: 60_000, cwd: join(__dirname, '..'),
  });
  return JSON.parse(output) as Result[];
}
const exec = (sql: string): Step => ({op: 'exec', sql});
const query = (sql: string): Step => ({op: 'query', sql});
const columnsOf = (table: string) => query(
  `SELECT column_name FROM information_schema.columns WHERE table_schema='assistant' AND table_name='${table}' ORDER BY ordinal_position`);
const names = (result: Result | undefined) => result?.rows?.map(row => row.column_name);

describe('migraciones Flyway', () => {
  it('las migraciones tienen el nombre que Flyway espera (V3 = brain_snapshots, OSB-010)', () => {
    expect(readdirSync(dir).filter(name => name.endsWith('.sql')).sort()).toEqual([
      'V10__brain_snapshots_v3_facts.sql', 'V11__brain_knowledge_sync.sql', 'V12__catalog_kit_belleza.sql', 'V13__first_loop.sql', 'V14__user_language_preferences.sql', 'V15__continuous_notifications.sql', 'V16__managed_job_intents.sql', 'V17__native_turn_recovery.sql', 'V18__robot_devices.sql', 'V19__stock_inventory.sql', 'V1__assistant_schema.sql', 'V2__assistant_timezone.sql', 'V3__brain_snapshots.sql', 'V4__assistant_approvals.sql', 'V5__brain_hub.sql',
      'V6__business_profiles.sql', 'V7__spend_approvals.sql', 'V8__brain_snapshots_v2_feedback.sql', 'V9__agent_activation_and_budget.sql',
    ]);
  });

  it('V12 (AAB-023) publica el kit de belleza como una sola versión activa del catálogo', () => {
    const results = run([
      exec(V1), exec(V5), exec(V12),
      query(`SELECT id, version, kind, source, industry_slug, status, jsonb_typeof(files) AS files FROM brain_hub.catalog_items`),
    ]);
    expect(results.map(result => result.ok)).toEqual([true, true, true, true]);
    expect(results[3]?.rows).toEqual([{id: 'saleads-kit-belleza', version: '1.0.0', kind: 'skill', source: 'industry_playbook',
      industry_slug: 'belleza_y_cuidado_personal', status: 'active', files: 'object'}]);
  });

  it('V9 (AAB-012) suma el encendido del agente sin invalidar aprobaciones viejas y una sola fila vigente de presupuesto', () => {
    const approval = (id: string, kind: string) => exec(
      `INSERT INTO assistant.approvals(id,user_id,business_id,kind,item_id,item_version,item_name,status,expires_at)
       VALUES ('${id}','u1','00000000-0000-4000-8000-000000000002','${kind}','item.a','1','Item','pending',now())`);
    const budget = (id: string, revision: number, superseded: boolean, extra = '') => exec(
      `INSERT INTO assistant.agent_monthly_budgets(id,business_id,user_id,amount_minor,currency,period_start,revision,set_by,superseded_at)
       VALUES ('${id}','00000000-0000-4000-8000-000000000002','u1',500000,'COP','2027-10-01',${revision},${extra || "'owner'"},${superseded ? 'now()' : 'NULL'})`);
    const results = run([
      exec(V1), exec(V2), exec(V4), exec(V7),
      approval('00000000-0000-4000-8000-000000000001', 'pause_campaign'),
      exec(V9),
      approval('00000000-0000-4000-8000-000000000002', 'activate_agent_publication'),
      budget('00000000-0000-4000-8000-000000000011', 1, true),
      budget('00000000-0000-4000-8000-000000000012', 2, false),
      budget('00000000-0000-4000-8000-000000000013', 3, false),
      budget('00000000-0000-4000-8000-000000000014', 4, true, "'agent'"),
      query(`SELECT count(*)::int AS n FROM assistant.approvals WHERE kind='pause_campaign'`),
    ]);
    expect(results.map(result => result.ok)).toEqual([true, true, true, true, true, true, true, true, true, false, false, true]);
    expect(results[11]?.rows).toEqual([{n: 1}]);
  });

  it('V6 (MLB-002) guarda un tipo por negocio del dueño, solo con tipos y orígenes conocidos', () => {
    const insert = (business: string, type: string, source = 'owner') => exec(
      `INSERT INTO assistant.business_profiles(user_id,business_id,business_type,source) VALUES ('u1','${business}','${type}','${source}')`);
    const results = run([
      exec(V1), exec(V5), exec(V6),
      insert('00000000-0000-4000-8000-000000000001', 'physical_product'),
      insert('00000000-0000-4000-8000-000000000002', 'infoproduct', 'bi'),
      insert('00000000-0000-4000-8000-000000000001', 'service'),
      insert('00000000-0000-4000-8000-000000000003', 'retail'),
      insert('00000000-0000-4000-8000-000000000004', 'service', 'agent'),
    ]);
    expect(results.map(result => result.ok)).toEqual([true, true, true, true, true, false, false, false]);
  });

  it('V6 (MLB-017) reactiva el compartir de todos los que lo habían apagado', () => {
    const results = run([
      exec(V1), exec(V5),
      exec("INSERT INTO brain_hub.sharing_preferences(user_id, opted_out_at, notice_ack_at) VALUES ('u1', now(), now()), ('u2', now(), NULL), ('u3', NULL, now())"),
      exec(V6),
      query('SELECT count(*)::int AS off FROM brain_hub.sharing_preferences WHERE opted_out_at IS NOT NULL'),
      query('SELECT count(*)::int AS acked FROM brain_hub.sharing_preferences WHERE notice_ack_at IS NOT NULL'),
    ]);
    expect(results.map(result => result.ok)).toEqual([true, true, true, true, true, true]);
    expect(results[4]?.rows).toEqual([{off: 0}]);
    expect(results[5]?.rows).toEqual([{acked: 2}]);
  });

  it('V4 (OSB-013) crea approvals con estados, tipos y una sola propuesta pendiente por ítem', () => {
    const insert = (id: string, status = 'pending', kind = 'install_skill') => exec(
      `INSERT INTO assistant.approvals(id,user_id,business_id,kind,item_id,item_version,item_name,status,expires_at)
       VALUES ('${id}','u1','00000000-0000-4000-8000-000000000002','${kind}','skill.a','1.0.0','Skill A','${status}',now())`);
    const results = run([
      exec(V1), exec(V2), exec(V4),
      insert('00000000-0000-4000-8000-000000000001'),
      insert('00000000-0000-4000-8000-000000000002'),
      insert('00000000-0000-4000-8000-000000000003', 'rejected'),
      insert('00000000-0000-4000-8000-000000000004', 'launched'),
      insert('00000000-0000-4000-8000-000000000005', 'pending', 'spend_money'),
    ]);
    expect(results.map(result => result.ok)).toEqual([true, true, true, true, false, true, false, false]);
  });

  it('V2 (OCB-016) agrega assistants.timezone nullable y acotada, sin tocar las filas existentes', () => {
    const results = run([
      exec(V1),
      exec("INSERT INTO assistant.assistants(user_id,status,step) VALUES ('u1','activating','preparing_access')"),
      exec(V2),
      query("SELECT timezone FROM assistant.assistants WHERE user_id='u1'"),
      exec("UPDATE assistant.assistants SET timezone='America/Bogota' WHERE user_id='u1'"),
      exec(`UPDATE assistant.assistants SET timezone='${'x'.repeat(65)}' WHERE user_id='u1'`),
      exec("UPDATE assistant.assistants SET timezone='' WHERE user_id='u1'"),
      columnsOf('assistants'),
    ]);
    expect(results.slice(0, 3).map(result => result.ok)).toEqual([true, true, true]);
    expect(results[3]?.rows).toEqual([{timezone: null}]);
    expect(results.slice(4, 7).map(result => result.ok)).toEqual([true, false, false]);
    expect(names(results[7])?.at(-1)).toBe('timezone');
  });

  it('V5 (OSB-015) crea el schema brain_hub y rechaza lecciones de plataforma', () => {
    const lesson = (provenance: string) => exec(`INSERT INTO brain_hub.lessons(id,user_id,business_id,industry_slug,text,provenance)
      VALUES (gen_random_uuid(),'u1','00000000-0000-4000-8000-000000000002','belleza_y_cuidado_personal','${'x'.repeat(30)}','${provenance}')`);
    const results = run([exec(V1), exec(V2), exec(V4), exec(V5), lesson('owner_said'), lesson('platform'),
      query("SELECT table_name FROM information_schema.tables WHERE table_schema='brain_hub' ORDER BY table_name")]);
    expect(results.slice(0, 6).map(result => result.ok)).toEqual([true, true, true, true, true, false]);
    expect(results[6]?.rows?.map(row => row.table_name)).toEqual(['business_industries', 'catalog_items', 'installs', 'lessons', 'sharing_preferences']);
  });

  it('V1 aplica limpia sobre una base vacía con las tablas de architecture.md', () => {
    const [applied, assistants, credentials, flows, events] = run([
      exec(V1), columnsOf('assistants'), columnsOf('assistant_credentials'), columnsOf('oauth_flows'), columnsOf('assistant_events'),
    ]);
    expect(applied).toEqual({ok: true});
    expect(names(assistants)).toEqual([
      'user_id', 'status', 'step', 'instance_name', 'zone', 'private_ip', 'api_server_key_enc', 'bundle_version',
      'ai_provider', 'ai_model', 'ai_configured', 'session_id', 'activation_started_at', 'ready_since', 'attempts',
      'created_at', 'updated_at', 'deleted_at',
    ]);
    expect(names(credentials)).toEqual(['user_id', 'refresh_token_enc', 'access_expires_at', 'obtained_at']);
    expect(names(flows)).toEqual(['state_hash', 'user_id', 'verifier_enc', 'expires_at']);
    expect(names(events)).toEqual(['id', 'user_id', 'kind', 'phase', 'cause_code', 'detail_safe', 'at']);
  });

  it('aplica los CHECK de estado, paso, nombre de VM, cause_code y state_hash', () => {
    const results = run([
      exec(V1),
      exec("INSERT INTO assistant.assistants(user_id,status,step) VALUES ('u1','activating','preparing_access')"),
      exec("INSERT INTO assistant.assistant_events(user_id,kind,phase,cause_code) VALUES ('u1','activation','create_vm','vm_create_failed')"),
      exec("INSERT INTO assistant.assistants(user_id,status) VALUES ('u2','none')"),
      exec("INSERT INTO assistant.assistants(user_id,status,step) VALUES ('u3','ready','booting')"),
      exec("INSERT INTO assistant.assistants(user_id,status,instance_name) VALUES ('u4','ready','other-vm')"),
      exec("INSERT INTO assistant.assistant_events(user_id,kind,cause_code) VALUES ('u1','activation','stack trace here')"),
      exec("INSERT INTO assistant.oauth_flows(state_hash,user_id,verifier_enc,expires_at) VALUES ('raw-state','u1','\\x01',now())"),
    ]);
    expect(results.map(result => result.ok)).toEqual([true, true, true, false, false, false, false, false]);
  });

  it('assistant_events es append-only', () => {
    const [, , update, remove] = run([
      exec(V1),
      exec("INSERT INTO assistant.assistant_events(user_id,kind) VALUES ('u1','activation')"),
      exec("UPDATE assistant.assistant_events SET kind='other'"),
      exec('DELETE FROM assistant.assistant_events'),
    ]);
    expect(update).toMatchObject({ok: false, error: expect.stringMatching(/append-only/)});
    expect(remove).toMatchObject({ok: false, error: expect.stringMatching(/append-only/)});
  });

  it("otorga USAGE + DML al rol 'assistant' si existe, sin abrirle el historial de Flyway", () => {
    // Como en Flyway: el schema y su tabla de historial existen antes de correr V1.
    const [setup, applied, rights] = run([
      exec('CREATE ROLE assistant; CREATE SCHEMA assistant; CREATE TABLE assistant.flyway_schema_history(installed_rank int PRIMARY KEY);'),
      exec(V1),
      query(`SELECT
        has_schema_privilege('assistant','assistant','USAGE') AS usage,
        bool_and(has_table_privilege('assistant', format('assistant.%I', t), p)) AS dml,
        has_sequence_privilege('assistant','assistant.assistant_events_id_seq','USAGE') AS seq,
        has_table_privilege('assistant','assistant.flyway_schema_history','SELECT') AS history
        FROM unnest(ARRAY['assistants','assistant_credentials','oauth_flows','assistant_events']) t
        CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p`),
    ]);
    expect(setup).toEqual({ok: true});
    expect(applied).toEqual({ok: true});
    expect(rights?.rows?.[0]).toEqual({usage: true, dml: true, seq: true, history: false});
  });
});
