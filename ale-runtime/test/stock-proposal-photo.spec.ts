import 'reflect-metadata';
import {Test} from '@nestjs/testing';
import type {INestApplication} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import type {z} from 'zod';
import {AppModule} from '../src/app.module';
import {StockProposalV1, StockProposalsV1} from '../src/contracts/stock-v1';
import {configureApp} from '../src/http/configure-app';
import {FieldCipher} from '../src/security/field-cipher';
import {IdentityVerifier} from '../src/security/identity';
import {buildStock, stockSettings} from '../src/stock/module';
import {gcsPhotoStore, type PhotoStore} from '../src/stock/photos';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';
import {approve, createWorld, key, pgliteStockDb, propose, seedVariant, type World} from './support/stock-world';
import {ISSUER, testKeys} from './support/tokens';

type Conteo = Extract<StockProposalV1, {tipo: 'conteo'}>['detalle'];
type Kit = Extract<StockProposalV1, {tipo: 'kit'}>['detalle'];
const DAY = 86_400_000;
const detailField = (kind: string, name: string): z.ZodType =>
  (StockProposalV1.options.find(option => option.shape.tipo.value === kind)!.shape.detalle as unknown as z.ZodObject).shape[name] as z.ZodType;
const signed = (object: string) => `https://storage.googleapis.com/saleads-dev-meta-assistant-stock-photos/${object}?X-Goog-Signature=abc`;

/** Fake del adaptador de IVB-009: cuenta firmas para comprobar que el modelo nunca las recibe. */
function fakeStore() {
  const calls: Array<{object: string; ttl: number}> = [];
  const store: PhotoStore & {fail: boolean} = {
    fail: false,
    signPut: async object => signed(object),
    signGet: async (object, ttl) => {
      if (store.fail) throw new Error('iam caído');
      calls.push({object, ttl});
      return signed(object);
    },
  };
  return {store, calls};
}

/** Foto lista, como la deja `photo_done`. */
async function seedPhoto(world: World, options: {total?: number; recordedAt?: Date} = {}): Promise<{id: string; object: string}> {
  const id = randomUUID();
  const object = `${world.businessId}/${id}/numerada.png`;
  await world.db.query(
    `INSERT INTO assistant.stock_photos(id,business_id,user_id,request_id,status,concept,label,object_original,object_numerada,sam,total,fuente,idempotency_key,occurred_at,recorded_at)
     VALUES ($1,$2,$3,$9,'lista','jar','frascos',$4,$5,$6,$7,'camara',$10,$8,$8)`,
    [id, world.businessId, world.userId, `${world.businessId}/${id}/original.png`, object, JSON.stringify({total: options.total ?? 4, objetos: []}), options.total ?? 4,
      options.recordedAt ?? world.now.value, id, id]);
  return {id, object};
}

const conteo = (proposal: StockProposalV1): Conteo => {
  if (proposal.tipo !== 'conteo') throw new Error(proposal.tipo);
  return proposal.detalle;
};
const kitOf = (proposal: StockProposalV1): Kit => {
  if (proposal.tipo !== 'kit') throw new Error(proposal.tipo);
  return proposal.detalle;
};

describe('propuesta de conteo con foto y kit con fuentes', () => {
  let test: TestDatabase;
  beforeAll(async () => {test = await startTestDatabase();});
  afterAll(async () => {await test.close();});

  describe('foto firmada al leer', () => {
    let world: World;
    let fake: ReturnType<typeof fakeStore>;
    let variant: string;
    beforeEach(async () => {
      fake = fakeStore();
      world = await createWorld(test, {deps: {photoStore: fake.store}});
      variant = await seedVariant(world);
    });
    const countWithPhoto = async (options: {recordedAt?: Date} = {}) => {
      const photo = await seedPhoto(world, options);
      return {photo, proposal: await propose(world, 'conteo', {variante_id: variant, contado: 0, origen: 'foto', photo_id: photo.id})};
    };
    const webList = async () => world.stock.proposals.list(world.businessId, 'pendiente', 50, {web: true});

    it('vigente: la web recibe URL GET firmada de 15 minutos, del objeto numerado, sin la ruta como dato', async () => {
      const {photo} = await countWithPhoto();
      const [proposal] = await webList();
      const detalle = conteo(proposal!);
      expect(detalle).toMatchObject({foto_estado: 'disponible', foto_url: signed(photo.object), total_objetos: 4,
        foto_expira_en: new Date(world.now.value.getTime() + 900_000).toISOString(), foto_tomada_en: world.now.value.toISOString()});
      expect(fake.calls).toEqual([{object: photo.object, ttl: 900}]);
      // La ruta solo viaja dentro de la URL firmada: ningún campo la trae suelta.
      expect(Object.entries(detalle).filter(([name, value]) => name !== 'foto_url' && typeof value === 'string' && value.includes(photo.id))).toEqual([]);
      expect(StockProposalsV1.parse({propuestas: [proposal]})).toBeTruthy();
    });

    it('por MCP (sin web) el estado es el mismo pero sin URL, y no se firma nada', async () => {
      const {proposal} = await countWithPhoto();
      expect(conteo(proposal)).toMatchObject({foto_estado: 'disponible', foto_url: null, foto_expira_en: null, total_objetos: 4});
      const [listed] = await world.stock.proposals.list(world.businessId, 'pendiente');
      expect(conteo(listed!)).toMatchObject({foto_estado: 'disponible', foto_url: null});
      expect(conteo(await world.stock.proposals.get(world.businessId, proposal.id))).toMatchObject({foto_url: null});
      expect(fake.calls).toEqual([]);
    });

    it('vencida: a los 30 días del bucket no hay URL, aunque la foto exista; a los 29 sí', async () => {
      await countWithPhoto({recordedAt: new Date(world.now.value.getTime() - 30 * DAY)});
      expect(conteo((await webList())[0]!)).toMatchObject({foto_estado: 'no_disponible', foto_url: null, foto_expira_en: null, total_objetos: 4});
      expect(fake.calls).toEqual([]);
      await world.db.query('UPDATE assistant.stock_photos SET recorded_at = $2 WHERE business_id = $1', [world.businessId, new Date(world.now.value.getTime() - 29 * DAY)]);
      expect(conteo((await webList())[0]!).foto_estado).toBe('disponible');
    });

    it('perdida: sin objeto numerado, foto no lista o de otro negocio da no_disponible sin URL', async () => {
      const {photo} = await countWithPhoto();
      for (const sql of [
        'UPDATE assistant.stock_photos SET object_numerada = NULL WHERE id = $1',
        `UPDATE assistant.stock_photos SET object_numerada = 'x', status = 'fallida' WHERE id = $1`,
        `UPDATE assistant.stock_photos SET status = 'lista', business_id = '${randomUUID()}' WHERE id = $1`,
      ]) {
        await world.db.query(sql, [photo.id]);
        expect(conteo((await webList())[0]!)).toMatchObject({foto_estado: 'no_disponible', foto_url: null, foto_expira_en: null});
      }
      expect(fake.calls).toEqual([]);
    });

    it('perdida: si la firma falla, no_disponible y la lista no se cae', async () => {
      await countWithPhoto();
      fake.store.fail = true;
      expect(conteo((await webList())[0]!)).toMatchObject({foto_estado: 'no_disponible', foto_url: null});
    });

    it('sin foto: sin_foto', async () => {
      await propose(world, 'conteo', {variante_id: variant, contado: 0, origen: 'voz'});
      expect(conteo((await webList())[0]!)).toMatchObject({foto_estado: 'sin_foto', foto_url: null, foto_tomada_en: null, total_objetos: null});
    });

    it('aprobar y rechazar desde la web devuelven la foto firmada', async () => {
      const {photo, proposal} = await countWithPhoto();
      expect(conteo(await approve(world, proposal))).toMatchObject({foto_estado: 'disponible', foto_url: signed(photo.object)});
      const second = (await countWithPhoto()).proposal;
      const decision = key();
      expect(conteo(await world.stock.proposals.reject({userId: world.userId}, world.businessId, second.id, second.revision, decision))).toMatchObject({foto_estado: 'disponible', foto_url: expect.stringContaining('X-Goog-Signature')});
      // Repetir con la misma clave también responde firmada.
      expect(conteo(await world.stock.proposals.reject({userId: world.userId}, world.businessId, second.id, second.revision, decision)).foto_url).toEqual(expect.stringContaining('X-Goog-Signature'));
    });

    it('con el adaptador real del bucket, la URL es la que acepta el front: https en storage.googleapis.com, firmada y con 900 s', async () => {
      world = await createWorld(test, {deps: {photoStore: gcsPhotoStore('saleads-dev-meta-assistant-stock-photos', {email: 'sa@x.iam.gserviceaccount.com', sign: async () => Buffer.from('firma')})}});
      variant = await seedVariant(world);
      const {photo} = await countWithPhoto();
      const url = new URL(conteo((await webList())[0]!).foto_url!);
      expect([url.protocol, url.hostname, url.pathname]).toEqual(['https:', 'storage.googleapis.com', `/saleads-dev-meta-assistant-stock-photos/${photo.object}`]);
      expect([url.searchParams.get('X-Goog-Expires'), url.searchParams.get('X-Goog-Signature')]).toEqual(['900', Buffer.from('firma').toString('hex')]);
    });

    it('sin bucket configurado: una foto lista se declara no_disponible en la web', async () => {
      world = await createWorld(test);
      variant = await seedVariant(world);
      await countWithPhoto();
      expect(conteo((await webList())[0]!)).toMatchObject({foto_estado: 'no_disponible', foto_url: null});
    });
  });

  describe('kit: fuentes, precio_fuente y diagnóstico', () => {
    let world: World;
    let variant: string;
    beforeEach(async () => {
      world = await createWorld(test);
      variant = await seedVariant(world, 'Mascarilla', {unitCost: '10000'});
    });
    const kit = (extra: object) => propose(world, 'kit', {subtipo: 'kit', componentes: [{variante_id: variant, cantidad: 1}], diagnostico: 'valor_percibido', fuentes: [], hipotesis: 'h', ...extra});

    it('salen en la propuesta, limpios y en una línea', async () => {
      const detalle = kitOf(await kit({diagnostico: 'precio\n​bajo', precio_fuente: 'Tres\ttiendas‮ de Bogotá',
        fuentes: [{url: 'https://tienda.example/mascarilla', fecha: '2026-10-30'}, {url: 'http://otra.example/p?a=1', fecha: '30\noct'}]}));
      expect(detalle).toMatchObject({diagnostico: 'precio bajo', precio_fuente: 'Tres tiendas de Bogotá',
        fuentes: [{url: 'https://tienda.example/mascarilla', fecha: '2026-10-30'}, {url: 'http://otra.example/p?a=1', fecha: '30 oct'}]});
    });

    it('sin precio_fuente sale nulo; sin fuentes, lista vacía', async () => {
      expect(kitOf(await kit({}))).toMatchObject({precio_fuente: null, fuentes: [], diagnostico: 'valor_percibido'});
    });

    it('solo enlaces http/https sin credenciales: los demás no se guardan ni salen', async () => {
      const bad = ['javascript:alert(1)', 'data:text/html,hola', 'ftp://x.example/a', 'mailto:a@b.example', 'https://usuario:clave@x.example/'];
      const proposal = await kit({fuentes: [...bad.map(url => ({url, fecha: 'hoy'})), {url: 'https://ok.example/', fecha: 'hoy'}]});
      expect(kitOf(proposal).fuentes).toEqual([{url: 'https://ok.example/', fecha: 'hoy'}]);
      const {rows} = await world.db.query<{payload: {fuentes: unknown[]}}>('SELECT payload FROM assistant.stock_proposals WHERE id = $1', [proposal.id]);
      expect(rows[0]!.payload.fuentes).toEqual([{url: 'https://ok.example/', fecha: 'hoy'}]);
    });

    it('una fila guardada antes de este cambio también se filtra al leer', async () => {
      const proposal = await kit({});
      await world.db.query(`UPDATE assistant.stock_proposals SET payload = payload || $2::jsonb WHERE id = $1`,
        [proposal.id, JSON.stringify({fuentes: [{url: 'javascript:alert(1)', fecha: 'x'}, {url: 'https://ok.example/', fecha: 'a\nb'}, {url: 5}], precio_fuente: 'uno\ndos', diagnostico: 'tres\u200b\ncuatro'})]);
      expect(kitOf(await world.stock.proposals.get(world.businessId, proposal.id))).toMatchObject({fuentes: [{url: 'https://ok.example/', fecha: 'a b'}], precio_fuente: 'uno dos', diagnostico: 'tres cuatro'});
    });

    it('el contrato de conteo solo acepta foto_url https o nula', () => {
      const field = detailField('conteo', 'foto_url');
      expect([null, signed('a/b.png')].map(value => field.safeParse(value).success)).toEqual([true, true]);
      expect(['http://storage.googleapis.com/a', 'a/b/numerada.png', 'javascript:1'].map(value => field.safeParse(value).success)).toEqual([false, false, false]);
    });

    it('el contrato rechaza un enlace que no sea web', () => {
      const shape = detailField('kit', 'fuentes');
      expect(shape.safeParse([{url: 'https://ok.example/', fecha: 'x'}]).success).toBe(true);
      for (const url of ['javascript:alert(1)', 'ftp://x.example/', 'https://u:p@x.example/']) expect(shape.safeParse([{url, fecha: 'x'}]).success).toBe(false);
    });
  });

  describe('por HTTP: la web firma, la ruta interna del MCP no', () => {
    const TOKEN = 'k'.repeat(40);
    const OWNER = 'owner-foto';
    const BUSINESS = '7e88bd4a-0000-4000-8000-0000000000c1';
    let app: INestApplication;
    let base: string;
    let ownerToken: string;
    let world: World;

    beforeAll(async () => {
      const keys = await testKeys();
      ownerToken = await keys.sign({sub: OWNER});
      const {store} = fakeStore();
      const settings = stockSettings({STOCK_ENABLED: true, STOCK_USER_IDS: [OWNER], STOCK_BUSINESS_SEEDS: [`${BUSINESS}:${OWNER}:COP`],
        STOCK_WEB_BASE_URL: '', STOCK_BENCH_ENABLED: false, STOCK_MAX_AUTONOMY_LEVEL: 2});
      const db = pgliteStockDb(test);
      const now = {value: new Date()};
      const stock = (await buildStock(settings, {pool: test.database.pool, db, offerings: {find: async (_u, _b, ref) => ({...ref, name: 'Oferta'})},
        assertOwned: async () => undefined, photoStore: store, now: () => now.value}))!;
      world = {stock, db, businessId: BUSINESS, userId: OWNER, offerings: {find: jest.fn()}, now};
      const moduleRef = await Test.createTestingModule({imports: [AppModule.register({
        database: test.database, identity: new IdentityVerifier({issuer: ISSUER, audience: '', clients: ['front']}, keys.jwks),
        flag: {isEnabled: async () => true}, cipher: new FieldCipher(Buffer.alloc(32, 3)), internalApiToken: TOKEN, stock,
      })]}).compile();
      app = configureApp(moduleRef.createNestApplication({bodyParser: false, logger: false}));
      await app.listen(0, '127.0.0.1');
      base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    });
    afterAll(async () => {await app.close();});

    it('GET web trae foto_url firmada y GET interno la trae nula', async () => {
      const variant = await seedVariant(world);
      const photo = await seedPhoto(world);
      await propose(world, 'conteo', {variante_id: variant, contado: 0, origen: 'foto', photo_id: photo.id});
      const web = await fetch(`${base}/assistants/me/businesses/${BUSINESS}/stock/proposals?status=pendiente`, {headers: {authorization: `Bearer ${ownerToken}`}});
      const internal = await fetch(`${base}/internal/stock/businesses/${BUSINESS}/proposals?status=pendiente`, {headers: {
        'x-internal-api-token': TOKEN, 'x-user-id': OWNER, 'x-business-id': BUSINESS}});
      expect([web.status, internal.status]).toEqual([200, 200]);
      const [fromWeb, fromMcp] = [StockProposalsV1.parse(await web.json()).propuestas[0]!, StockProposalsV1.parse(await internal.json()).propuestas[0]!];
      expect(conteo(fromWeb)).toMatchObject({foto_estado: 'disponible', foto_url: signed(photo.object)});
      expect(conteo(fromMcp)).toMatchObject({foto_estado: 'disponible', foto_url: null, foto_expira_en: null});
    });
  });
});

describe('foto de la propuesta en un entorno local', () => {
  it('con STOCK_PHOTO_WEB_BASE el navegador recibe la URL firmada por esa base; sin ella, la de Storage', async () => {
    const signer = {email: 'sa@x.iam.gserviceaccount.com', sign: async () => Buffer.from('firma')};
    const now = new Date('2026-11-04T12:00:00Z');
    const signed = await gcsPhotoStore('fotos', signer).signGet('a/b.jpg', 600, now);
    expect(signed.startsWith('https://storage.googleapis.com/fotos/a/b.jpg?')).toBe(true);
    expect(gcsPhotoStore('fotos', signer).webUrl).toBeUndefined();
    const local = gcsPhotoStore('fotos', signer, 'http://localhost:8071/');
    expect(local.webUrl!(signed)).toBe(signed.replace('https://storage.googleapis.com', 'http://localhost:8071'));
  });
});
