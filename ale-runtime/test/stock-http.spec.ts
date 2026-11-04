import 'reflect-metadata';
import {Test} from '@nestjs/testing';
import type {INestApplication} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type {AddressInfo} from 'node:net';
import {join} from 'node:path';
import {AppModule} from '../src/app.module';
import {notFound, serviceUnavailable} from '../src/domain/errors';
import * as contract from '../src/contracts/stock-v1';
import {STOCK_TOOLS} from '../src/contracts/stock-v1';
import {ErrorResponseV1} from '../src/contracts/v1';
import {configureApp} from '../src/http/configure-app';
import {FieldCipher} from '../src/security/field-cipher';
import {IdentityVerifier} from '../src/security/identity';
import {StockAccess} from '../src/stock/access';
import {buildStock, stockSettings, type StockRuntime} from '../src/stock/module';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';
import {key, pgliteStockDb} from './support/stock-world';
import {ISSUER, testKeys, type TestKeys} from './support/tokens';

const TOKEN = 'k'.repeat(40);
const OWNER = 'owner-http';
const BUSINESS = '7e88bd4a-0000-4000-8000-0000000000b1';
const OTHER_BUSINESS = '7e88bd4a-0000-4000-8000-0000000000b2';
const UNOWNED = '7e88bd4a-0000-4000-8000-0000000000b3';

const WEB_ROUTES = [
  'GET /assistants/me/stock/status', 'GET /assistants/me/businesses/:businessId/stock/summary', 'GET /assistants/me/businesses/:businessId/stock/items',
  'GET /assistants/me/businesses/:businessId/stock/proposals', 'POST /assistants/me/businesses/:businessId/stock/proposals/:proposalId/approve',
  'POST /assistants/me/businesses/:businessId/stock/proposals/:proposalId/reject', 'GET /assistants/me/businesses/:businessId/stock/orders',
  'POST /assistants/me/businesses/:businessId/stock/orders/:orderId/cancel', 'GET /assistants/me/businesses/:businessId/stock/autonomy', 'POST /assistants/me/businesses/:businessId/stock/autonomy/:area/level',
];

describe('API de Stock', () => {
  let db: TestDatabase;
  let keys: TestKeys;
  let app: INestApplication;
  let base: string;
  let stock: StockRuntime;
  let owned: jest.Mock<Promise<void>, [string, string]>;
  let flag: jest.Mock<Promise<boolean>, [string]>;
  let ownerToken: string;
  let strangerToken: string;
  const offerings = {find: async (_u: string, _b: string, ref: {type: 'product' | 'service'; id: string}) => ({...ref, name: 'Oferta'})};

  beforeAll(async () => {
    [db, keys] = await Promise.all([startTestDatabase(), testKeys()]);
    [ownerToken, strangerToken] = await Promise.all([keys.sign({sub: OWNER}), keys.sign({sub: 'stranger-http'})]);
    owned = jest.fn(async (_user: string, business: string) => {
      if (business === UNOWNED) throw notFound();
    });
    flag = jest.fn(async (_user: string) => true);
    const settings = stockSettings({STOCK_ENABLED: true, STOCK_USER_IDS: [OWNER], STOCK_BUSINESS_SEEDS: [`${BUSINESS}:${OWNER}:COP`, `${UNOWNED}:${OWNER}:COP`],
      STOCK_WEB_BASE_URL: '', STOCK_BENCH_ENABLED: false, STOCK_MAX_AUTONOMY_LEVEL: 2});
    stock = (await buildStock(settings, {pool: db.database.pool, db: pgliteStockDb(db), offerings, assertOwned: owned,
      documentStore: {signPut: async object => `https://bucket.test/${object}`, exists: async () => false, download: async () => null}, invoiceModel: {id: 'fake', extract: async () => null}}))!;
    const moduleRef = await Test.createTestingModule({imports: [AppModule.register({
      database: db.database, identity: new IdentityVerifier({issuer: ISSUER, audience: '', clients: ['front']}, keys.jwks),
      flag: {isEnabled: flag}, cipher: new FieldCipher(Buffer.alloc(32, 3)), internalApiToken: TOKEN, stock,
    })]}).compile();
    app = configureApp(moduleRef.createNestApplication({bodyParser: false, logger: false}));
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => {await app.close(); await db.close();});
  beforeEach(() => {
    flag.mockClear().mockResolvedValue(true);
  });

  const internalPath = (path: string, business = BUSINESS) => `/internal/stock/businesses/${business}${path}`;
  const webPath = (path: string, business = BUSINESS) => `/assistants/me/businesses/${business}/stock${path}`;
  const internal = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, business = BUSINESS) =>
    fetch(`${base}${internalPath(path, business)}`, {method, ...(body === undefined ? {} : {body: JSON.stringify(body)}), headers: {
      'content-type': 'application/json', 'x-internal-api-token': TOKEN, 'x-user-id': OWNER, 'x-business-id': business, ...headers}});
  const web = (method: string, path: string, options: {body?: unknown; headers?: Record<string, string>; token?: string; business?: string} = {}) =>
    fetch(`${base}${webPath(path, options.business)}`, {method, ...(options.body === undefined ? {} : {body: JSON.stringify(options.body)}), headers: {
      'content-type': 'application/json', authorization: `Bearer ${options.token ?? ownerToken}`, ...options.headers}});
  const code = async (response: Response) => ErrorResponseV1.parse(await response.json()).code;

  const product = async (name = `P ${randomUUID()}`) => {
    const response = await internal('POST', '/proposals', {idempotency_key: key(), kind: 'catalogo', detalle: {producto: name, variantes: [{nombre: '250 ml'}], oferta: {type: 'product', id: 'o-1'}}});
    expect(response.status).toBe(200);
    const {propuesta} = await response.json() as {propuesta: {id: string; revision: number}};
    const approved = await web('POST', `/proposals/${propuesta.id}/approve`, {headers: {'if-match': `"${propuesta.revision}"`, 'idempotency-key': key()}, body: {}});
    expect(approved.status).toBe(200);
    const {rows} = await db.database.pool.query(
      `SELECT v.id FROM assistant.stock_variants v JOIN assistant.stock_products p ON p.id = v.product_id WHERE p.business_id = $1 AND p.name = $2`, [BUSINESS, name]);
    return (rows[0] as {id: string}).id;
  };
  const proposeCount = async (variantId: string, contado = 3) => {
    const response = await internal('POST', '/proposals', {idempotency_key: key(), kind: 'conteo', detalle: {variante_id: variantId, contado, origen: 'voz'}});
    return (await response.json() as {propuesta: {id: string; revision: number}}).propuesta;
  };

  describe('autenticación interna', () => {
    it('sin token válido 401, sin x-user-id 401, y con token vacío configurado 503', async () => {
      const path = `${base}${internalPath('/overview')}`;
      expect((await fetch(path, {headers: {'x-user-id': OWNER, 'x-business-id': BUSINESS}})).status).toBe(401);
      expect((await fetch(path, {headers: {'x-internal-api-token': 'x'.repeat(40), 'x-user-id': OWNER, 'x-business-id': BUSINESS}})).status).toBe(401);
      expect((await fetch(path, {headers: {'x-internal-api-token': TOKEN, 'x-business-id': BUSINESS}})).status).toBe(401);
      expect((await internal('GET', '/overview')).status).toBe(200);
      const moduleRef = await Test.createTestingModule({imports: [AppModule.register({
        database: db.database, identity: new IdentityVerifier({issuer: ISSUER, audience: '', clients: ['front']}, keys.jwks), flag: {isEnabled: flag},
        cipher: new FieldCipher(Buffer.alloc(32, 3)), internalApiToken: '', stock,
      })]}).compile();
      const empty = configureApp(moduleRef.createNestApplication({bodyParser: false, logger: false}));
      await empty.listen(0, '127.0.0.1');
      const response = await fetch(`http://127.0.0.1:${(empty.getHttpServer().address() as AddressInfo).port}${internalPath('/overview')}`, {headers: {'x-internal-api-token': TOKEN, 'x-user-id': OWNER, 'x-business-id': BUSINESS}});
      const status = response.status;
      await response.text();
      await empty.close();
      expect(status).toBe(503);
    });
  });

  describe('aislamiento', () => {
    it('un usuario no habilitado recibe 404 en interna y web, y enabled:false en status', async () => {
      expect((await internal('GET', '/overview', undefined, {'x-user-id': 'stranger-http'})).status).toBe(404);
      expect((await web('GET', '/summary', {token: strangerToken})).status).toBe(404);
      const status = await fetch(`${base}/assistants/me/stock/status`, {headers: {authorization: `Bearer ${strangerToken}`}});
      await expect(status.json()).resolves.toEqual({enabled: false, business_ids: []});
      const own = await fetch(`${base}/assistants/me/stock/status`, {headers: {authorization: `Bearer ${ownerToken}`}});
      expect(contract.StockStatusV1.parse(await own.json())).toEqual({enabled: true, business_ids: [BUSINESS, UNOWNED].sort()});
    });

    it('un negocio ajeno da la misma respuesta que uno inexistente', async () => {
      const foreign = await web('GET', '/summary', {business: UNOWNED});
      const missing = await web('GET', '/summary', {business: OTHER_BUSINESS});
      expect([foreign.status, missing.status]).toEqual([404, 404]);
      await expect(code(foreign)).resolves.toBe(await code(missing));
      expect((await internal('GET', '/overview', undefined, {}, UNOWNED)).status).toBe(404);
    });

    it('x-business-id distinto de la ruta: 404', async () => {
      expect((await internal('GET', '/overview', undefined, {'x-business-id': OTHER_BUSINESS})).status).toBe(404);
    });

    it('propiedad no determinable: 503, nunca 200', async () => {
      const access = new StockAccess({db: stock.db, settings: stock.settings, assertOwned: async () => {throw serviceUnavailable();}});
      await expect(access.assertBusiness(OWNER, BUSINESS)).rejects.toMatchObject({code: 'SERVICE_UNAVAILABLE', status: 503});
    });

    it('sacar a un usuario de STOCK_USER_IDS lo apaga aunque su negocio siga en la tabla', async () => {
      const check = jest.fn(async () => undefined);
      const access = new StockAccess({db: stock.db, settings: {...stock.settings, userIds: new Set()}, assertOwned: check});
      await expect(access.assertBusiness(OWNER, BUSINESS)).rejects.toMatchObject({code: 'NOT_FOUND'});
      expect(check).not.toHaveBeenCalled();
    });

    it('recuerda la propiedad 60 s y vuelve a preguntar al vencer; el resultado negativo no se recuerda', async () => {
      let now = 1_000;
      const check = jest.fn(async () => undefined);
      const access = new StockAccess({db: stock.db, settings: stock.settings, assertOwned: check, now: () => now});
      await access.assertBusiness(OWNER, BUSINESS);
      now += 59_000;
      await access.assertBusiness(OWNER, BUSINESS);
      expect(check).toHaveBeenCalledTimes(1);
      now += 2_000;
      await access.assertBusiness(OWNER, BUSINESS);
      expect(check).toHaveBeenCalledTimes(2);
      const denied = jest.fn(async () => {throw notFound();});
      const closed = new StockAccess({db: stock.db, settings: stock.settings, assertOwned: denied, now: () => now});
      await expect(closed.assertBusiness(OWNER, BUSINESS)).rejects.toMatchObject({code: 'NOT_FOUND'});
      await expect(closed.assertBusiness(OWNER, BUSINESS)).rejects.toMatchObject({code: 'NOT_FOUND'});
      expect(denied).toHaveBeenCalledTimes(2);
    });

    it('las rutas por negocio exigen la bandera de asistente; status no', async () => {
      flag.mockResolvedValue(false);
      const blocked = await web('GET', '/summary');
      expect(blocked.status).toBe(403);
      await expect(code(blocked)).resolves.toBe('ASSISTANT_NOT_ENABLED');
      expect((await fetch(`${base}/assistants/me/stock/status`, {headers: {authorization: `Bearer ${ownerToken}`}})).status).toBe(200);
    });
  });

  describe('errores y encabezados', () => {
    it('STOCK_NEGATIVE y CONFLICT llegan como {code, request_id} con 409, de punta a punta', async () => {
      const variantId = await product();
      const sale = await (await internal('POST', '/proposals', {idempotency_key: key(), kind: 'venta', detalle: {variante_id: variantId, cantidad: 1}})).json() as {propuesta: {id: string; revision: number}};
      const headers = () => ({'if-match': `"${sale.propuesta.revision}"`, 'idempotency-key': key()});
      const negative = await web('POST', `/proposals/${sale.propuesta.id}/approve`, {headers: headers(), body: {}});
      expect(negative.status).toBe(409);
      await expect(code(negative)).resolves.toBe('STOCK_NEGATIVE');
      const stale = await web('POST', `/proposals/${sale.propuesta.id}/approve`, {headers: {...headers(), 'if-match': '"99"'}, body: {}});
      expect(stale.status).toBe(409);
      await expect(code(stale)).resolves.toBe('CONFLICT');
    });

    it('sin If-Match o sin Idempotency-Key: 400 INVALID_REQUEST en approve y reject', async () => {
      const proposal = await proposeCount(await product());
      for (const action of ['approve', 'reject']) {
        for (const headers of [{'if-match': '"1"'}, {'idempotency-key': key()}, {'if-match': 'x', 'idempotency-key': key()}, {'if-match': '"1"', 'idempotency-key': 'corta'}] as Array<Record<string, string>>) {
          const response = await web('POST', `/proposals/${proposal.id}/${action}`, {headers, body: {}});
          expect(response.status).toBe(400);
          await expect(code(response)).resolves.toBe('INVALID_REQUEST');
        }
      }
    });

    it('doble approve con la misma clave devuelve la misma respuesta', async () => {
      const proposal = await proposeCount(await product(), 0);
      const headers = {'if-match': `"${proposal.revision}"`, 'idempotency-key': key()};
      const first = await web('POST', `/proposals/${proposal.id}/approve`, {headers, body: {}});
      const second = await web('POST', `/proposals/${proposal.id}/approve`, {headers, body: {}});
      expect([first.status, second.status]).toEqual([200, 200]);
      await expect(second.json()).resolves.toEqual(await first.json());
    });

    it('aprobar con diferencia sin causa da 400; rechazar nunca la exige', async () => {
      const proposal = await proposeCount(await product(), 5);
      const noCause = await web('POST', `/proposals/${proposal.id}/approve`, {headers: {'if-match': `"${proposal.revision}"`, 'idempotency-key': key()}, body: {}});
      expect(noCause.status).toBe(400);
      const rejected = await web('POST', `/proposals/${proposal.id}/reject`, {headers: {'if-match': `"${proposal.revision}"`, 'idempotency-key': key()}, body: {}});
      expect(rejected.status).toBe(200);
      expect(rejected.headers.get('cache-control')).toBe('no-store');
    });

    it('confirm-count rechaza todo tipo distinto de conteo con 403', async () => {
      const variantId = await product();
      const sale = await (await internal('POST', '/proposals', {idempotency_key: key(), kind: 'venta', detalle: {variante_id: variantId, cantidad: 1}})).json() as {propuesta: {id: string; revision: number}};
      const response = await internal('POST', `/proposals/${sale.propuesta.id}/confirm-count`, {revision: 1, metodo: 'canal', cita: 'sí', canal: 'whatsapp', session_id: 's'});
      expect(response.status).toBe(403);
      await expect(code(response)).resolves.toBe('FORBIDDEN');
    });

    it('confirm-count por canal confirma un conteo; sin cita o con cita en voz da 400', async () => {
      const proposal = await proposeCount(await product(), 0);
      const canal = {revision: 1, metodo: 'canal', canal: 'whatsapp', session_id: 's'};
      expect((await internal('POST', `/proposals/${proposal.id}/confirm-count`, canal)).status).toBe(400);
      expect((await internal('POST', `/proposals/${proposal.id}/confirm-count`, {revision: 1, metodo: 'voz', cita: 'sí'})).status).toBe(400);
      const ok = await internal('POST', `/proposals/${proposal.id}/confirm-count`, {...canal, cita: 'sí, confirmo'});
      expect(ok.status).toBe(200);
      expect(contract.StockProposalV1.parse(await ok.json()).estado).toBe('aprobada');
    });
  });

  describe('POST /proposals con esquema cerrado', () => {
    const uuid = randomUUID();
    const cases: Record<string, unknown> = {
      conteo: {variante_id: uuid, contado: 1, origen: 'voz'}, entrada: {document_id: uuid, lineas: [{linea_id: uuid, variante_id: null}]}, venta: {variante_id: uuid, cantidad: 1},
      catalogo: {producto: 'p', variantes: [{nombre: 'v'}], oferta: {type: 'product', id: 'o'}}, union_catalogo: {origen_id: uuid, destino_id: uuid},
      pedido: {variante_id: uuid, proveedor_id: uuid, cantidad: 1, mandato: {precio_objetivo: '1', tope: '2'}},
      kit: {subtipo: 'kit', componentes: [{variante_id: uuid, cantidad: 1}], diagnostico: 'd', fuentes: [], hipotesis: 'h'},
      apuesta: {variante_id: uuid, presupuesto_diario: '1', tope: '2', duracion_dias: 1, unidades_semana_previstas: null, fuente_prevision: 'dato'},
      autonomia: {area: 'inventario', nivel_pedido: 3, monto_tope: '1'},
    };

    it.each(Object.keys(cases))('%s con un campo extra da 400, y sin él pasa la validación', async kind => {
      const extra = await internal('POST', '/proposals', {idempotency_key: key(), kind, detalle: {...cases[kind] as object, extra: 1}});
      expect(extra.status).toBe(400);
      const outer = await internal('POST', '/proposals', {idempotency_key: key(), kind, detalle: cases[kind], user_id: 'otro'});
      expect(outer.status).toBe(400);
      const clean = await internal('POST', '/proposals', {idempotency_key: key(), kind, detalle: cases[kind]});
      expect(clean.status).not.toBe(400);
    });

    it('catalogo sin oferta da 400: V19 exige oferta en todo producto que no sea kit', async () => {
      const response = await internal('POST', '/proposals', {idempotency_key: key(), kind: 'catalogo', detalle: {producto: 'p', variantes: [{nombre: 'v'}]}});
      expect(response.status).toBe(400);
    });
  });

  describe('lecturas', () => {
    let fresh: {business: string; token: string};
    const emptyHarness = async () => {
      const businessId = randomUUID();
      await db.database.pool.query('INSERT INTO assistant.stock_enabled_businesses(business_id,user_id,currency) VALUES ($1,$2,$3)', [businessId, OWNER, 'COP']);
      fresh = {business: businessId, token: ownerToken};
    };

    it('una lectura sin datos da listas vacías, no 404', async () => {
      await emptyHarness();
      const read = async (path: string) => {
        const response = await web('GET', path, {business: fresh.business});
        expect(response.status).toBe(200);
        return response.json();
      };
      await expect(read('/items')).resolves.toEqual({items: [], kits: []});
      await expect(read('/proposals')).resolves.toEqual({propuestas: []});
      await expect(read('/orders')).resolves.toEqual({pedidos: []});
      await expect(read('/summary')).resolves.toMatchObject({unidades_esperadas: 0, ultimo_conteo_en: null, moneda: 'COP'});
    });

    it('stock por producto: causa preguntada con su propuesta, y luego cuadra', async () => {
      const name = `Shampoo ${randomUUID()}`;
      const variantId = await product(name);
      const proposal = await proposeCount(variantId, 3);
      const find = async () => contract.StockItemsV1.parse(await (await web('GET', '/items')).json()).items.find(item => item.variante_id === variantId)!;
      expect(await find()).toMatchObject({estado: 'causa_preguntada', propuesta_id: proposal.id, contado: 3, diferencia: 3, esperado: 0, oferta: {id: 'o-1', nombre: 'Oferta'}});
      const approved = await web('POST', `/proposals/${proposal.id}/approve`, {headers: {'if-match': '"1"', 'idempotency-key': key()}, body: {causa: 'otra'}});
      expect(approved.status).toBe(200);
      expect(await find()).toMatchObject({estado: 'cuadra', propuesta_id: null, esperado: 3, ultimo_conteo: 3});
      const detail = contract.StockItemDetailV1.parse(await (await internal('GET', `/items/${variantId}`)).json());
      expect(detail).toMatchObject({saldo: 3, moneda: 'COP'});
      expect((await internal('GET', `/items/${randomUUID()}`)).status).toBe(404);
    });

    it('propuestas filtradas por estado desde la web y el MCP', async () => {
      const proposal = await proposeCount(await product(), 1);
      const web200 = contract.StockProposalsV1.parse(await (await web('GET', '/proposals?status=pendiente&businessId=x')).json());
      expect(web200.propuestas.map(item => item.id)).toContain(proposal.id);
      const closed = contract.StockProposalsV1.parse(await (await internal('GET', '/proposals?status=rechazada&limit=5')).json());
      expect(closed.propuestas.map(item => item.id)).not.toContain(proposal.id);
    });

    it('niveles de autonomía: contrato de bajar, y `negociacion` queda en 1 solo con la ruta del dueño', async () => {
      const levels = contract.StockAutonomyV1.parse(await (await web('GET', '/autonomy')).json());
      expect(levels.areas.map(area => area.area)).toEqual(['inventario', 'reposicion', 'negociacion', 'ofertas']);
      const headers = {'if-match': '"1"', 'idempotency-key': key()};
      const path = '/autonomy/negociacion/level';
      expect((await web('POST', path, {headers, body: {nivel: 1, otro: 1}})).status).toBe(400);
      expect((await web('POST', path, {body: {nivel: 1}})).status).toBe(400);
      expect((await web('POST', path, {headers: {'if-match': '"1"'}, body: {nivel: 1}})).status).toBe(400);
      expect((await web('POST', path, {headers: {'idempotency-key': key()}, body: {nivel: 1}})).status).toBe(400);
      expect((await web('POST', '/autonomy/inexistente/level', {headers, body: {nivel: 1}})).status).toBe(404);
      const raise = await web('POST', path, {headers, body: {nivel: 3}});
      expect([raise.status, await code(raise)]).toEqual([400, 'INVALID_REQUEST']);
      expect((await web('POST', path, {token: strangerToken, headers, body: {nivel: 1}})).status).not.toBe(200);
      const lowered = await web('POST', path, {headers, body: {nivel: 1, motivo: 'por ahora no'}});
      expect(lowered.status).toBe(200);
      expect(contract.StockAutonomyAreaV1.parse(await lowered.json())).toEqual({area: 'negociacion', nivel: 1, nivel_efectivo: 1, revision: 2});
      const again = await web('POST', path, {headers, body: {nivel: 1, motivo: 'por ahora no'}});
      expect([again.status, ((await again.json()) as {revision: number}).revision]).toEqual([200, 2]);
      const blocked = await internal('POST', '/proposals', {idempotency_key: key(), kind: 'autonomia', detalle: {area: 'negociacion', nivel_pedido: 2, monto_tope: '10'}});
      expect(blocked.status).toBe(200);
      expect(contract.StockProposeResponseV1.parse(await blocked.json())).toMatchObject({estado: 'bloqueado', bloqueo: {area: 'negociacion', nivel_efectivo: 1}});
    });

    it('R34: `detalle` no acepta evidencia, y sin condición cumplida la petición da 409 CONFLICT', async () => {
      const detalle = {area: 'reposicion', nivel_pedido: 3, monto_tope: '500000'};
      const forged = await internal('POST', '/proposals', {idempotency_key: key(), kind: 'autonomia', detalle: {...detalle, evidencia: [{dato: 'x', valor: '1', fuente: 'y', simulado: false}]}});
      expect(forged.status).toBe(400);
      const refused = await internal('POST', '/proposals', {idempotency_key: key(), kind: 'autonomia', detalle});
      expect([refused.status, await code(refused)]).toEqual([409, 'CONFLICT']);
    });

    it('con un run activo las lecturas filtran por él', async () => {
      await emptyHarness();
      const runId = randomUUID();
      const seeded = fresh.business;
      const add = async (name: string, run: string | null) => {
        const id = randomUUID();
        await db.database.pool.query(`INSERT INTO assistant.stock_products(id,business_id,user_id,name,normalized_name,offering_type,offering_id,occurred_at,simulated,run_id) VALUES ($1,$2,$3,$4,$4,'product','o',now(),$5,$6)`,
          [id, seeded, OWNER, name, run !== null, run]);
        await db.database.pool.query(`INSERT INTO assistant.stock_variants(id,product_id,name,currency) VALUES ($1,$2,'v','COP')`, [randomUUID(), id]);
      };
      await add('real', null);
      await add('sim', runId);
      const names = async () => contract.StockItemsV1.parse(await (await web('GET', '/items', {business: seeded})).json()).items.map(item => item.producto);
      await expect(names()).resolves.toEqual(['real']);
      await db.database.pool.query(`INSERT INTO assistant.stock_runs(id,business_id,name,seed,status) VALUES ($1,$2,'r','s','activo')`, [runId, seeded]);
      await expect(names()).resolves.toEqual(['sim']);
      const summary = contract.StockSummaryV1.parse(await (await web('GET', '/summary', {business: seeded})).json());
      expect(summary.simulado).toBe(true);
    });

    it('cada lectura web lleva Cache-Control no-store', async () => {
      for (const path of ['/summary', '/items', '/proposals', '/orders', '/autonomy']) {
        expect((await web('GET', path)).headers.get('cache-control')).toBe('no-store');
      }
    });
  });

  describe('lógica pendiente: contrato vivo y 503', () => {
    const id = randomUUID();
    const pending: Array<[string, string, unknown?]> = [
      ['POST', '/photos', {idempotency_key: key(), concepto: 'jar', etiqueta: 'frascos'}],
      // Sin canal configurado: el canal real del proveedor sigue pendiente.
      ['POST', '/supplier/send', {idempotency_key: key(), order_id: id, texto: 't', precio_unitario_ofrecido: null, cantidad: null, cierre: false}],
      ['GET', `/supplier/wait?order_id=${id}`]
    ];

    it('bet-signal: variante inexistente da 200 con se_puede_pautar en falso, y un id inválido 404', async () => {
      const answer = await internal('GET', `/bet-signal/${id}`);
      expect([answer.status, await answer.json()]).toEqual([200, expect.objectContaining({se_puede_pautar: false, motivo_no: 'sin_producto'})]);
      expect((await internal('GET', '/bet-signal/no-es-uuid')).status).toBe(404);
    });

    it('una foto inexistente da 404: fotos ya no es lógica pendiente, y sin bucket pedir una responde 503', async () => {
      expect((await internal('GET', `/photos/${randomUUID()}`)).status).toBe(404);
    });

    it('documentos: registra por la ruta interna, y extraer sin archivo responde no_subido', async () => {
      const body = {idempotency_key: key(), tipo: 'factura', content_type: 'application/pdf', tamano: 10, sha256: 'c'.repeat(64), canal: 'whatsapp'};
      const registered = await internal('POST', '/documents', body);
      const result = await registered.json() as {document_id: string; ya_existia: boolean};
      expect([registered.status, result.ya_existia]).toEqual([200, false]);
      const extracted = await internal('POST', `/documents/${result.document_id}/extract`);
      expect([extracted.status, await extracted.json()]).toEqual([200, {status: 'no_subido'}]);
      expect((await internal('POST', '/documents', {...body, sha256: 'corto'})).status).toBe(400);
      expect((await internal('POST', `/documents/${randomUUID()}/extract`)).status).toBe(404);
    });

    it.each(pending.map(([method, path, body]) => ({method, path, body})))('$method $path responde 503 hasta su tarea', async ({method, path, body}) => {
      expect((await internal(method, path, body)).status).toBe(503);
    });

    it('robot/say: sin robot responde robot_offline, y un texto largo se rechaza con motivo', async () => {
      const body = {texto: 'x'.repeat(240), pregunta: false, proposal_id: null, producto_id: null, prioridad: 'normal', dedupe_key: 'k'};
      const said = await internal('POST', '/robot/say', body);
      expect([said.status, await said.json()]).toEqual([200, {status: expect.stringMatching(/robot_offline|fuera_de_horario/)}]);
      const long = await internal('POST', '/robot/say', {...body, texto: 'x'.repeat(241)});
      expect([long.status, (await long.json() as {code: string}).code]).toEqual([400, 'STOCK_TEXT_TOO_LONG']);
    });

    it('robot/say: referencia ajena da 404', async () => {
      const response = await internal('POST', '/robot/say', {texto: 't', pregunta: false, proposal_id: randomUUID(), producto_id: null, prioridad: 'normal', dedupe_key: 'k2'});
      expect(response.status).toBe(404);
    });

    it('overview: con `tarjeta` entrega la clave una vez; `order_id` va solo con `negociar`', async () => {
      const first = await (await internal('GET', '/overview?tarjeta=tick')).json() as {tarjeta: {permitida: boolean; clave: string; nueva: boolean}};
      expect(first.tarjeta).toMatchObject({permitida: true, nueva: true});
      expect(first.tarjeta.clave).toMatch(new RegExp(`^stock:${BUSINESS}:tick:\\d{10}-\\d$`));
      expect((await (await internal('GET', '/overview?tarjeta=tick')).json() as {tarjeta: unknown}).tarjeta).toEqual({...first.tarjeta, nueva: false});
      expect((await (await internal('GET', '/overview')).json() as {tarjeta?: unknown}).tarjeta).toBeUndefined();
      expect((await internal('GET', '/overview?tarjeta=negociar')).status).toBe(400);
      expect((await internal('GET', `/overview?tarjeta=tick&order_id=${UNOWNED}`)).status).toBe(400);
    });

    it('IVB-024 factura huérfana: overview lista la factura sin leer, y su tarjeta tiene clave propia por documento', async () => {
      type Overview = {facturas_sin_procesar: Array<{document_id: string; estado: string; canal: string}>; tarjeta?: {permitida: boolean; clave: string; nueva: boolean}};
      const pendingIds = async () => ((await (await internal('GET', '/overview')).json()) as Overview).facturas_sin_procesar.map(item => item.document_id);
      const register = async (sha256: string, tipo = 'factura') => (await (await internal('POST', '/documents',
        {idempotency_key: key(), tipo, content_type: 'application/pdf', tamano: 10, sha256, canal: 'whatsapp'})).json() as {document_id: string}).document_id;
      const before = await pendingIds();
      const first = await register('d'.repeat(64));
      const second = await register('e'.repeat(64));
      const screenshot = await register('f'.repeat(64), 'pantallazo');
      const listed = ((await (await internal('GET', '/overview')).json()) as Overview).facturas_sin_procesar;
      expect(listed.filter(item => !before.includes(item.document_id))).toEqual([
        {document_id: first, estado: 'registrado', canal: 'whatsapp', recibido_en: expect.any(String)},
        {document_id: second, estado: 'registrado', canal: 'whatsapp', recibido_en: expect.any(String)},
      ]);
      expect(listed.map(item => item.document_id)).not.toContain(screenshot);

      // Dos facturas en la misma ventana ya no comparten la clave de la ventana: cada una tiene su tarjeta.
      const card = async (documentId: string) => ((await (await internal('GET', `/overview?tarjeta=factura&document_id=${documentId}`)).json()) as Overview).tarjeta!;
      const a = await card(first);
      const b = await card(second);
      expect(a).toMatchObject({permitida: true, nueva: true, clave: `stock:${BUSINESS}:factura:${first}`});
      expect(b.clave).toBe(`stock:${BUSINESS}:factura:${second}`);
      expect(await card(first)).toEqual({...a, nueva: false});
      expect((await internal('GET', `/overview?tarjeta=factura&document_id=${randomUUID()}`)).status).toBe(404);
      expect((await internal('GET', `/overview?tarjeta=tick&document_id=${first}`)).status).toBe(400);

      // Ya leída por Stock, sale de la lista.
      await db.database.pool.query(`UPDATE assistant.stock_documents SET status = 'extraido' WHERE id = $1`, [first]);
      expect(await pendingIds()).not.toContain(first);
      expect(await pendingIds()).toContain(second);
    });

    it('cancelar pedido: ruta web, sin apagar el contrato; uno inexistente da 404', async () => {
      expect((await web('POST', `/orders/${UNOWNED}/cancel`)).status).toBe(404);
      expect((await web('POST', '/orders/no-es-uuid/cancel')).status).toBe(404);
    });

    it('overview: los avisos para el canal salen una vez, en un solo mensaje', async () => {
      await db.database.pool.query('INSERT INTO assistant.stock_robot_events(business_id,user_id,kind,payload,status) VALUES ($1,$2,$3,$4,$5)',
        [BUSINESS, OWNER, 'decir', JSON.stringify({texto: 'Se venció.', pregunta: false, prioridad: 'normal', run_id: null}), 'para_canal']);
      expect((await (await internal('GET', '/overview')).json() as {avisos_canal: unknown}).avisos_canal).toEqual({mensaje: 'Se venció.', cantidad: 1});
      expect((await (await internal('GET', '/overview')).json() as {avisos_canal: unknown}).avisos_canal).toBeNull();
    });

    it('sus entradas ya son cerradas: un destinatario extra da 400', async () => {
      expect((await internal('POST', '/supplier/send', {idempotency_key: key(), order_id: id, texto: 't', precio_unitario_ofrecido: null, cantidad: null, cierre: false, to: '+57'})).status).toBe(400);
      expect((await internal('POST', '/robot/say', {texto: 't', pregunta: false, proposal_id: null, producto_id: null, prioridad: 'normal', dedupe_key: 'k', user_id: 'x'})).status).toBe(400);
    });
  });

  describe('contrato', () => {
    const registered = () => {
      const server = app.getHttpAdapter().getInstance() as {router: {stack: Array<{route?: {path: string; methods: Record<string, boolean>}}>}};
      return server.router.stack.flatMap(layer => layer.route && /stock/.test(layer.route.path)
        ? Object.keys(layer.route.methods).filter(method => method !== '_all').map(method => `${method.toUpperCase()} ${layer.route!.path}`) : []);
    };
    const internalRoutes = () => Object.values(STOCK_TOOLS).map(tool => `${tool.method} /internal/stock/businesses/:businessId${tool.path}`);

    it('existen exactamente las 15 rutas internas y las 9 web, ninguna otra bajo stock', () => {
      expect(Object.keys(STOCK_TOOLS)).toHaveLength(15);
      expect(registered().sort()).toEqual([...internalRoutes(), ...WEB_ROUTES].sort());
    });

    it('ninguna ruta interna aprueba, rechaza ni toca autonomía: la plata se aprueba en pantalla', () => {
      const internal = registered().filter(route => route.includes('/internal/'));
      expect(internal.filter(route => /approve|reject|autonomy|confirm(?!-count)/.test(route))).toEqual([]);
      expect(internal.filter(route => /confirm/.test(route))).toEqual(['POST /internal/stock/businesses/:businessId/proposals/:id/confirm-count']);
    });

    const docs = (name: string) => readFileSync(join(__dirname, '..', 'docs', name), 'utf8');
    const blocks = (text: string, label: string) => [...text.matchAll(new RegExp(`<!-- ${label}: (\\w+) -->\\n\`\`\`json\\n([\\s\\S]*?)\\n\`\`\``, 'g'))]
      .map(match => ({name: match[1]!, value: JSON.parse(match[2]!) as unknown}));

    it('cada ejemplo de stock-contract-v1.md pasa por su esquema y están todos los tipos', () => {
      const examples = blocks(docs('stock-contract-v1.md'), 'ejemplo');
      expect(examples.length).toBeGreaterThanOrEqual(17);
      for (const {name, value} of examples) {
        const schema = (contract as unknown as Record<string, {parse(input: unknown): unknown}>)[name];
        expect(schema).toBeDefined();
        schema!.parse(value);
      }
      const kinds = examples.filter(item => item.name === 'StockProposalV1').map(item => (item.value as {tipo: string}).tipo);
      expect(kinds.sort()).toEqual([...contract.StockProposalKindV1.options].sort());
    });

    it('stock-contract-v1.md trae tabla de campos, tipo y nulable, incluida autonomía', () => {
      const text = docs('stock-contract-v1.md');
      expect(text).toContain('| Campo | Tipo | Nulable | Obligatorio |');
      for (const field of ['nivel_efectivo', 'ultimo_conteo_en', 'causa_requerida', 'costo_incompleto']) expect(text).toContain(`\`${field}\``);
    });

    it('stock-tools-v1.md tiene las 15, y cada ejemplo pasa por su esquema de entrada y salida', () => {
      const text = docs('stock-tools-v1.md');
      const inputs = blocks(text, 'entrada');
      const outputs = blocks(text, 'salida');
      expect(inputs.map(item => item.name).sort()).toEqual(Object.keys(STOCK_TOOLS).sort());
      expect(outputs.map(item => item.name).sort()).toEqual(Object.keys(STOCK_TOOLS).sort());
      for (const {name, value} of inputs) STOCK_TOOLS[name as keyof typeof STOCK_TOOLS].input.parse(value);
      for (const {name, value} of outputs) STOCK_TOOLS[name as keyof typeof STOCK_TOOLS].output.parse(value);
    });

    it('un ejemplo roto hace fallar la validación (la prueba de contrato puede fallar)', () => {
      expect(() => contract.StockSummaryV1.parse({unidades_esperadas: 'x'})).toThrow();
      expect(() => STOCK_TOOLS.saleads_stock_supplier_send.input.parse({to: '+57'})).toThrow();
    });
  });
});
