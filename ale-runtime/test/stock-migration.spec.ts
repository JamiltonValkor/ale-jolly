import 'reflect-metadata';
import {Test} from '@nestjs/testing';
import {randomUUID} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import {execFileSync} from 'node:child_process';
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {INestApplication} from '@nestjs/common';
import {AppModule} from '../src/app.module';
import {configuration} from '../src/config';
import {ErrorResponseV1} from '../src/contracts/v1';
import {configureApp} from '../src/http/configure-app';
import {FieldCipher} from '../src/security/field-cipher';
import {IdentityVerifier} from '../src/security/identity';
import {parseBusinessSeeds} from '../src/stock/config';
import {buildStock, stockSettings, type StockRuntime} from '../src/stock/module';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';
import {ISSUER, testKeys, USER_ID, type TestKeys} from './support/tokens';

const V19 = readFileSync(join(__dirname, '..', 'migrations', 'V19__stock_inventory.sql'), 'utf8');
const BUSINESS = '7e88bd4a-0000-4000-8000-000000000001';
const USER = 'u-stock';

describe('V19: esquema de Stock', () => {
  let db: TestDatabase;
  const sql = (text: string, params: unknown[] = []) => db.database.pool.query(text, params);

  beforeAll(async () => {db = await startTestDatabase();});
  afterAll(async () => {await db.close();});

  const product = async (name: string, runId: string | null = null, kit = false, offering: string | null = 'o-1') => {
    const id = randomUUID();
    await sql(`INSERT INTO assistant.stock_products(id,business_id,user_id,name,normalized_name,offering_type,offering_id,is_kit,occurred_at,run_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),$9)`, [id, BUSINESS, USER, name, name.toLowerCase(), offering ? 'product' : null, offering, kit, runId]);
    return id;
  };
  const variant = async (productId: string) => {
    const id = randomUUID();
    await sql(`INSERT INTO assistant.stock_variants(id,product_id,name,currency) VALUES ($1,$2,'250 ml','COP')`, [id, productId]);
    return id;
  };
  const proposal = async (kind = 'venta', runId: string | null = null) => {
    const id = randomUUID();
    await sql(`INSERT INTO assistant.stock_proposals(id,business_id,user_id,kind,title,reason,payload,effects_yes,effects_no,expires_at,idempotency_key,request_hash,trace_id,created_by,occurred_at,run_id)
      VALUES ($1,$2,$3,$4,'t','r','{}','[]','[]',now(),$5,$6,$7,'stock',now(),$8)`, [id, BUSINESS, USER, kind, randomUUID(), 'a'.repeat(64), randomUUID(), runId]);
    return id;
  };
  const confirm = async (proposalId: string, runId: string | null = null, method = 'web', utterance: string | null = null) => {
    const id = randomUUID();
    await sql(`INSERT INTO assistant.stock_confirmations(id,proposal_id,business_id,method,actor,utterance_id,quote,decision,simulated,run_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'aprobada',$8,$9)`, [id, proposalId, BUSINESS, method, USER, utterance, method === 'canal' ? 'sí' : null, Boolean(runId), runId]);
    return id;
  };
  const movement = async (variantId: string, proposalId: string, confirmationId: string | null, delta: number, runId: string | null = null) => {
    const id = randomUUID();
    await sql(`INSERT INTO assistant.stock_movements(id,business_id,variant_id,kind,delta,origin,confirmation_id,proposal_id,trace_id,occurred_at,simulated,run_id)
      VALUES ($1,$2,$3,'entrada',$4,'test',$5,$6,$7,now(),$8,$9)`, [id, BUSINESS, variantId, delta, confirmationId, proposalId, randomUUID(), Boolean(runId), runId]);
    return id;
  };
  const movementSetup = async () => {
    const variantId = await variant(await product(`P ${randomUUID()}`));
    const proposalId = await proposal();
    return {variantId, proposalId, confirmationId: await confirm(proposalId)};
  };
  const utterance = async () => {
    const id = randomUUID();
    await sql(`INSERT INTO assistant.stock_owner_utterances(id,user_id,device_id,text) VALUES ($1,$2,$3,'sí')`, [id, USER, randomUUID()]);
    return id;
  };

  it('V19 no contiene ALTER ni referencia tablas de otros dominios', () => {
    expect(V19).not.toMatch(/\bALTER\b/i);
    const referenced = [...V19.matchAll(/REFERENCES\s+assistant\.(\w+)/g)].map(match => match[1]!);
    expect(referenced.length).toBeGreaterThan(10);
    expect(referenced.filter(table => !table.startsWith('stock_'))).toEqual([]);
    const created = [...V19.matchAll(/CREATE TABLE\s+assistant\.(\w+)/g)].map(match => match[1]!);
    expect(created.filter(table => !table.startsWith('stock_'))).toEqual([]);
  });

  it('dos corridas siembran el mismo catálogo sin error y sus saldos no se mezclan', async () => {
    const [runA, runB] = [randomUUID(), randomUUID()];
    const [a, b] = [await product('Mismo nombre', runA), await product('Mismo nombre', runB)];
    const [variantA, variantB] = [await variant(a), await variant(b)];
    for (const [runId, variantId, delta] of [[runA, variantA, 5], [runB, variantB, 9]] as const) {
      const proposalId = await proposal('venta', runId);
      await movement(variantId, proposalId, await confirm(proposalId, runId), delta, runId);
    }
    const {rows} = await sql(`SELECT m.run_id, sum(m.delta)::int AS saldo FROM assistant.stock_movements m WHERE m.run_id = ANY($1::uuid[]) GROUP BY m.run_id ORDER BY saldo`, [[runA, runB]]);
    expect(rows).toEqual([{run_id: runA, saldo: 5}, {run_id: runB, saldo: 9}]);
    await product('Mismo nombre real');
    await expect(product('Mismo nombre real')).rejects.toThrow(/stock_products_name_uq/);
  });

  it('reusar una frase en otra confirmación falla en la base (una frase, una propuesta)', async () => {
    const said = await utterance();
    await confirm(await proposal('conteo'), null, 'voz', said);
    await expect(confirm(await proposal('conteo'), null, 'voz', said)).rejects.toThrow(/stock_confirmations_utterance_uq/);
  });

  it('una confirmación por propuesta y prueba obligatoria por método', async () => {
    const id = await proposal();
    await confirm(id);
    await expect(confirm(id)).rejects.toThrow(/proposal_id/);
    await expect(confirm(await proposal(), null, 'voz', null)).rejects.toThrow(/check/);
    await expect(confirm(await proposal(), null, 'semilla')).rejects.toThrow(/check/);
    await expect(confirm(await proposal('venta', randomUUID()), randomUUID(), 'semilla')).resolves.toEqual(expect.any(String));
  });

  it('el mandato no cambia; state, round y last_offer sí', async () => {
    const variantId = await variant(await product(`Pedido ${randomUUID()}`));
    const supplierId = randomUUID();
    await sql(`INSERT INTO assistant.stock_suppliers(id,business_id,user_id,name,occurred_at) VALUES ($1,$2,$3,'Prov',now())`, [supplierId, BUSINESS, USER]);
    const orderId = randomUUID();
    await sql(`INSERT INTO assistant.stock_orders(id,business_id,user_id,variant_id,supplier_id,quantity,status,currency,proposal_id,occurred_at)
      VALUES ($1,$2,$3,$4,$5,10,'negociando','COP',$6,now())`, [orderId, BUSINESS, USER, variantId, supplierId, await proposal('pedido')]);
    await sql(`INSERT INTO assistant.stock_negotiations(order_id,target_price,max_price,max_quantity) VALUES ($1,100,120,10)`, [orderId]);
    await expect(sql(`UPDATE assistant.stock_negotiations SET state='esperando_proveedor', round=1, last_offer=100 WHERE order_id=$1`, [orderId])).resolves.toBeDefined();
    for (const change of ['max_price=999', 'target_price=1', 'max_quantity=99']) {
      await expect(sql(`UPDATE assistant.stock_negotiations SET ${change} WHERE order_id=$1`, [orderId])).rejects.toThrow(/immutable/);
    }
  });

  it('un movimiento sin confirmación falla en la base, y con ella pasa', async () => {
    const {variantId, proposalId, confirmationId} = await movementSetup();
    await expect(movement(variantId, proposalId, null, 3)).rejects.toThrow(/confirmation_id/);
    await expect(movement(variantId, proposalId, confirmationId, 3)).resolves.toEqual(expect.any(String));
  });

  it('stock_movements y stock_audit rechazan UPDATE y DELETE', async () => {
    const {variantId, proposalId, confirmationId} = await movementSetup();
    const id = await movement(variantId, proposalId, confirmationId, 3);
    await expect(sql('UPDATE assistant.stock_movements SET delta=9 WHERE id=$1', [id])).rejects.toThrow(/append-only/);
    await expect(sql('DELETE FROM assistant.stock_movements WHERE id=$1', [id])).rejects.toThrow(/append-only/);
    const auditId = randomUUID();
    await sql(`INSERT INTO assistant.stock_audit(id,business_id,trace_id,actor,action,entity,entity_id,args_hash) VALUES ($1,$2,$3,'a','b','c','d',$4)`, [auditId, BUSINESS, randomUUID(), 'a'.repeat(64)]);
    await expect(sql('UPDATE assistant.stock_audit SET actor=$2 WHERE id=$1', [auditId, 'x'])).rejects.toThrow(/append-only/);
    await expect(sql('DELETE FROM assistant.stock_audit WHERE id=$1', [auditId])).rejects.toThrow(/append-only/);
  });

  it('O-5: un kit puede nacer sin oferta; un producto normal no', async () => {
    await expect(product(`Kit ${randomUUID()}`, null, true, null)).resolves.toEqual(expect.any(String));
    await expect(product(`Normal ${randomUUID()}`, null, false, null)).rejects.toThrow(/check/);
  });

  it('un kit no se contiene a sí mismo y su cantidad es positiva', async () => {
    const kit = await variant(await product(`Kit ${randomUUID()}`, null, true, null));
    const part = await variant(await product(`Parte ${randomUUID()}`));
    await expect(sql(`INSERT INTO assistant.stock_kit_components VALUES ($1,$1,1)`, [kit])).rejects.toThrow(/check/);
    await expect(sql(`INSERT INTO assistant.stock_kit_components VALUES ($1,$2,0)`, [kit, part])).rejects.toThrow(/check/);
    await expect(sql(`INSERT INTO assistant.stock_kit_components VALUES ($1,$2,2)`, [kit, part])).resolves.toBeDefined();
  });

  it('un solo run activo por negocio', async () => {
    const business = randomUUID();
    const run = (status: string) => sql(`INSERT INTO assistant.stock_runs(id,business_id,name,seed,status) VALUES ($1,$2,'n','s',$3)`, [randomUUID(), business, status]);
    await run('activo');
    await run('cerrado');
    await expect(run('activo')).rejects.toThrow(/stock_runs_active_uq/);
  });

  it('una campaña de banco solo puede ser simulada', async () => {
    const variantId = await variant(await product(`Sim ${randomUUID()}`));
    await expect(sql(`INSERT INTO assistant.stock_sim_campaigns(id,business_id,variant_id,budget,status,simulated) VALUES ($1,$2,$3,1,'activa',false)`, [randomUUID(), BUSINESS, variantId])).rejects.toThrow(/check/);
  });

  it('el aviso `decir` se deduplica por día; otro tipo no', async () => {
    const event = (kind: string) => sql(`INSERT INTO assistant.stock_robot_events(business_id,user_id,kind,payload,dedupe_key,dedupe_day) VALUES ($1,$2,$3,'{}','k','2026-11-01')`, [BUSINESS, USER, kind]);
    await event('decir');
    await expect(event('decir')).rejects.toThrow(/stock_robot_events_dedupe_uq/);
    await expect(event('recount')).resolves.toBeDefined();
  });

  it('ningún GRANT del runtime abre escritura en tablas de solo inserción', () => {
    const append = /GRANT SELECT, INSERT ON\s+([^;]+?) TO assistant/.exec(V19)?.[1] ?? '';
    expect(append.split(',').map(table => table.trim()).sort()).toEqual(['assistant.stock_audit', 'assistant.stock_confirmations', 'assistant.stock_movements']);
    const dml = /GRANT SELECT, INSERT, UPDATE, DELETE ON\s+([^;]+?)\s+TO assistant/.exec(V19)?.[1] ?? '';
    const tables = dml.split(',').map(table => table.trim());
    expect(tables).not.toEqual(expect.arrayContaining(['assistant.stock_movements']));
    const created = [...V19.matchAll(/CREATE TABLE\s+(assistant\.\w+)/g)].map(match => match[1]!);
    expect([...tables, 'assistant.stock_audit', 'assistant.stock_confirmations', 'assistant.stock_movements'].sort()).toEqual([...created].sort());
    expect(V19).toContain('GRANT USAGE, SELECT ON SEQUENCE assistant.stock_robot_events_id_seq TO assistant');
  });

  it('con el rol de runtime existente, el libro queda sin UPDATE ni DELETE aunque V1 deje privilegios por defecto', () => {
    const dir = join(__dirname, '..', 'migrations');
    const files = readdirSync(dir).filter(name => /^V\d+__.+\.sql$/.test(name)).sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10));
    const steps = [{op: 'exec', sql: 'CREATE ROLE assistant; CREATE SCHEMA assistant; CREATE TABLE assistant.flyway_schema_history(installed_rank int PRIMARY KEY);'},
      ...files.map(name => ({op: 'exec', sql: readFileSync(join(dir, name), 'utf8')})),
      {op: 'query', sql: `SELECT t, p, has_table_privilege('assistant', 'assistant.' || t, p) AS ok
        FROM unnest(ARRAY['stock_movements','stock_confirmations','stock_audit']) t CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p ORDER BY 1, 2`}];
    const output = execFileSync(process.execPath, [join(__dirname, 'support', 'pglite-runner.mjs')], {input: JSON.stringify(steps), encoding: 'utf8', timeout: 60_000, cwd: join(__dirname, '..')});
    const results = JSON.parse(output) as Array<{ok: boolean; rows?: Array<{t: string; p: string; ok: boolean}>}>;
    expect(results.every(result => result.ok)).toBe(true);
    const allowed = results.at(-1)?.rows?.filter(row => row.ok).map(row => row.p);
    expect(allowed).toEqual(['INSERT', 'SELECT', 'INSERT', 'SELECT', 'INSERT', 'SELECT']);
  });

  describe('STOCK_BUSINESS_SEEDS', () => {
    const seed = `${BUSINESS}:${USER}:COP`;
    const enabled = (seeds: string[]) => stockSettings({
      STOCK_ENABLED: true, STOCK_USER_IDS: [USER], STOCK_BUSINESS_SEEDS: seeds, STOCK_WEB_BASE_URL: '', STOCK_BENCH_ENABLED: false, STOCK_MAX_AUTONOMY_LEVEL: 2,
    });

    it('una entrada repetida no duplica y crea las 4 áreas en nivel 2', async () => {
      await sql('DELETE FROM assistant.stock_enabled_businesses');
      await sql('DELETE FROM assistant.stock_autonomy');
      await buildStock(enabled([seed, seed]), {pool: db.database.pool});
      await buildStock(enabled([seed]), {pool: db.database.pool});
      const {rows} = await sql('SELECT business_id, user_id, currency FROM assistant.stock_enabled_businesses');
      expect(rows).toEqual([{business_id: BUSINESS, user_id: USER, currency: 'COP'}]);
      const areas = await sql('SELECT area, level FROM assistant.stock_autonomy WHERE business_id=$1 ORDER BY area', [BUSINESS]);
      expect(areas.rows).toEqual(['inventario', 'negociacion', 'ofertas', 'reposicion'].map(area => ({area, level: 2})));
    });

    it('un negocio con usuario fuera de STOCK_USER_IDS falla al arrancar', () => {
      expect(() => enabled([`${BUSINESS}:otro:COP`])).toThrow(/CONFIGURATION_INVALID.*STOCK_USER_IDS/);
    });

    it('un formato inválido falla al arrancar, y un user_id con dos puntos se respeta', () => {
      expect(() => parseBusinessSeeds(['no-es-negocio:u:COP'], new Set(['u']))).toThrow(/CONFIGURATION_INVALID/);
      expect(() => parseBusinessSeeds([`${BUSINESS}:u:cop`], new Set(['u']))).toThrow(/CONFIGURATION_INVALID/);
      expect(parseBusinessSeeds([`${BUSINESS}:a:b:USD`], new Set(['a:b']))).toEqual([{businessId: BUSINESS, userId: 'a:b', currency: 'USD'}]);
    });

    it('las llaves STOCK_* vienen apagadas o vacías, sin rechazar el vacío', () => {
      const parsed = configuration({DATABASE_URL: 'postgresql://u:p@localhost/db', KEYCLOAK_ISSUER: ISSUER, KEYCLOAK_JWKS_URL: 'https://example.test/jwks',
        POSTHOG_API_KEY: 'k', FIELD_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'), ASSISTANT_SIGNER_EMAIL: 'stock-test@example-project.iam.gserviceaccount.com',
        STOCK_USER_IDS: '', STOCK_BUSINESS_SEEDS: ''} as unknown as NodeJS.ProcessEnv);
      expect(parsed).toMatchObject({STOCK_ENABLED: false, STOCK_USER_IDS: [], STOCK_BUSINESS_SEEDS: [], STOCK_BENCH_ENABLED: false, STOCK_MAX_AUTONOMY_LEVEL: 2});
    });
  });

  describe('bandera', () => {
    let keys: TestKeys;
    let app: INestApplication;
    let queries: string[];

    const boot = async (stock: StockRuntime | undefined) => {
      const pool = {query: (text: string, params?: unknown[]) => {queries.push(text); return db.database.pool.query(text, params as unknown[]);}, end: async () => undefined};
      const moduleRef = await Test.createTestingModule({imports: [AppModule.register({
        database: new (db.database.constructor as typeof import('../src/persistence/database').Database)(pool as never),
        identity: new IdentityVerifier({issuer: ISSUER, audience: '', clients: ['front']}, keys.jwks),
        flag: {isEnabled: jest.fn().mockResolvedValue(true)}, cipher: new FieldCipher(Buffer.alloc(32, 7)), stock,
      })]}).compile();
      app = configureApp(moduleRef.createNestApplication({bodyParser: false, logger: false}));
      await app.listen(0, '127.0.0.1');
      return `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    };

    beforeAll(async () => {keys = await testKeys();});
    beforeEach(() => {queries = [];});
    afterEach(async () => {await app.close();});

    it('STOCK_ENABLED=false: 404 con contrato y cero consultas sobre stock_*', async () => {
      const spy = {query: jest.fn(async (text: string) => {queries.push(text); return {rows: [], rowCount: 0};})};
      const stock = await buildStock(stockSettings({STOCK_ENABLED: false, STOCK_USER_IDS: [USER], STOCK_BUSINESS_SEEDS: [`${BUSINESS}:${USER}:COP`],
        STOCK_WEB_BASE_URL: '', STOCK_BENCH_ENABLED: false, STOCK_MAX_AUTONOMY_LEVEL: 2}), {pool: spy as never});
      expect(stock).toBeUndefined();
      const base = await boot(stock);
      const response = await fetch(`${base}/assistants/me/stock/status`, {headers: {authorization: `Bearer ${await keys.sign({sub: USER_ID})}`}});
      expect(response.status).toBe(404);
      expect(ErrorResponseV1.parse(await response.json()).code).toBe('NOT_FOUND');
      expect(spy.query).not.toHaveBeenCalled();
      expect(queries.filter(text => /stock_/.test(text))).toEqual([]);
    });

    it('encendida: el usuario habilitado ve sus negocios y otro recibe enabled:false, con el par positivo de la bandera', async () => {
      await sql('DELETE FROM assistant.stock_enabled_businesses');
      const settings = stockSettings({STOCK_ENABLED: true, STOCK_USER_IDS: [USER], STOCK_BUSINESS_SEEDS: [`${BUSINESS}:${USER}:COP`],
        STOCK_WEB_BASE_URL: '', STOCK_BENCH_ENABLED: false, STOCK_MAX_AUTONOMY_LEVEL: 2});
      const base = await boot(await buildStock(settings, {pool: db.database.pool}));
      const status = async (sub: string) => (await fetch(`${base}/assistants/me/stock/status`, {headers: {authorization: `Bearer ${await keys.sign({sub})}`}})).json();
      await expect(status(USER)).resolves.toEqual({enabled: true, business_ids: [BUSINESS]});
      await expect(status(USER_ID)).resolves.toEqual({enabled: false, business_ids: []});
    });
  });
});
