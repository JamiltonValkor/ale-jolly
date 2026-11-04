import {randomUUID} from 'node:crypto';
import {notFound} from '../src/domain/errors';
import {StockClock} from '../src/stock/clock';
import {StockPhotos, gcsPhotoStore, type PhotoStore} from '../src/stock/photos';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';
import {pgliteStockDb} from './support/stock-world';
import type {StockDb} from '../src/stock/store';

const SHA = 'b'.repeat(64);
const sam = (total: number) => ({concepto: 'jar', total, ms: 5, objetos: Array.from({length: total}, (_, i) => ({n: i + 1, caja: [0, 0, 5, 5] as [number, number, number, number], confianza: 0.8}))});

describe('fotos de Stock', () => {
  let test: TestDatabase;
  let db: StockDb;
  let photos: StockPhotos;
  let now: {value: Date};
  let user: string;
  let business: string;
  const store: PhotoStore = {signPut: async (object, type) => `https://put/${object}?t=${type}`, signGet: async object => `https://get/${object}`};

  beforeAll(async () => {
    test = await startTestDatabase();
    db = pgliteStockDb(test);
  });
  afterAll(async () => {await test.close();});

  const build = (waitMs = 40) => new StockPhotos({usage: {spend: async () => true}, db, clock: new StockClock(db, () => now.value), store, waitMs, now: () => now.value});
  beforeEach(async () => {
    now = {value: new Date('2027-11-01T10:00:00.000Z')};
    user = `u-${randomUUID().slice(0, 8)}`;
    business = randomUUID();
    photos = build();
    await db.query(`INSERT INTO assistant.stock_device_presence(device_id,user_id,device_state,events_seen_at) VALUES ($1,$2,'activo',$3)`, [randomUUID(), user, now.value]);
  });

  const take = (extra: {photo_id?: string; concepto?: string; idempotency_key?: string} = {}, service = photos) =>
    service.take(user, business, {idempotency_key: extra.idempotency_key ?? randomUUID(), concepto: extra.concepto ?? 'jar', etiqueta: 'frascos', ...(extra.photo_id ? {photo_id: extra.photo_id} : {})});
  const lastRequest = async () => (await db.query<{request_id: string; id: string}>(`SELECT id, request_id FROM assistant.stock_photos WHERE user_id = $1 ORDER BY recorded_at DESC, id LIMIT 1`, [user])).rows[0]!;
  const events = async () => (await db.query<{payload: {foto_id: string | null; solicitud_id: string}; status: string}>(`SELECT payload, status FROM assistant.stock_robot_events WHERE user_id = $1 ORDER BY id`, [user])).rows;
  const complete = async (requestId: string, total = 0) => {
    await photos.photoUrl(user, {request_id: requestId, role: 'original', content_type: 'image/jpeg'});
    await photos.photoUrl(user, {request_id: requestId, role: 'numerada', content_type: 'image/jpeg'});
    await photos.done(user, {request_id: requestId, sam: sam(total), fuente: 'camara', imagen_sha256: SHA});
  };

  it('sin respuesta del robot: pending al vencer la espera, y get_photo da el resultado cuando llega', async () => {
    const pending = await take();
    expect(pending.status).toBe('pending');
    const {id, request_id} = await lastRequest();
    expect(await photos.get(business, id)).toEqual({status: 'pending', photo_id: id});
    await complete(request_id, 4);
    expect(await photos.get(business, id)).toMatchObject({status: 'ok', total: 4, fuente: 'camara', simulado: false, image_url: `https://get/${business}/${id}/numerada.jpg`, image_expires_in: 900});
  });

  it('reinicio entre take_photo y photo_done: la base conserva el resultado', async () => {
    await take();
    const {id, request_id} = await lastRequest();
    photos = build();
    await complete(request_id, 2);
    expect(await build().get(business, id)).toMatchObject({status: 'ok', total: 2});
  });

  it('el resultado despierta la espera sin agotarla', async () => {
    photos = build(5_000);
    const started = Date.now();
    const waiting = take();
    await new Promise(resolve => setTimeout(resolve, 30));
    await complete((await lastRequest()).request_id, 1);
    expect(await waiting).toMatchObject({status: 'ok', total: 1});
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('photo_failed despierta la espera con su motivo', async () => {
    photos = build(5_000);
    const waiting = take();
    await new Promise(resolve => setTimeout(resolve, 30));
    await photos.failed(user, {request_id: (await lastRequest()).request_id, motivo: 'camara'});
    expect(await waiting).toEqual({status: 'fallida', motivo: 'camara'});
  });

  it('misma clave de idempotencia no crea otra foto; con otro concepto da conflicto', async () => {
    const key = randomUUID();
    await take({idempotency_key: key});
    await take({idempotency_key: key});
    expect((await events()).length).toBe(1);
    await expect(take({idempotency_key: key, concepto: 'lid'})).rejects.toMatchObject({code: 'CONFLICT'});
  });

  it('R14: el reintento reusa la imagen, pide con foto_id y el tercero da tope_reintentos', async () => {
    await take();
    const root = await lastRequest();
    await complete(root.request_id, 0);
    const original = (await photos.get(business, root.id));
    expect(original).toMatchObject({status: 'ok', total: 0});
    await take({photo_id: root.id, concepto: 'bottle'});
    const retry = await lastRequest();
    expect((await events()).at(-1)!.payload.foto_id).toBe(root.id);
    await expect(photos.photoUrl(user, {request_id: (await events()).at(-1)!.payload.solicitud_id, role: 'original', content_type: 'image/jpeg'})).rejects.toMatchObject({code: 'CONFLICT'});
    expect(retry.id).not.toBeUndefined();
    await take({photo_id: root.id, concepto: 'lid'});
    expect(await take({photo_id: root.id, concepto: 'can'})).toEqual({status: 'fallida', motivo: 'tope_reintentos'});
    expect((await events()).length).toBe(3);
    const {rows} = await db.query<{object_original: string}>('SELECT object_original FROM assistant.stock_photos WHERE parent_photo_id = $1', [root.id]);
    expect(rows.map(row => row.object_original)).toEqual([`${business}/${root.id}/original.jpg`, `${business}/${root.id}/original.jpg`]);
  });

  it('R14: el reintento conserva la fecha de la foto: una vieja no se hace pasar por conteo de hoy', async () => {
    await take();
    const root = await lastRequest();
    await complete(root.request_id, 0);
    const old = new Date('2027-10-20T10:00:00.000Z');
    await db.query('UPDATE assistant.stock_photos SET occurred_at = $2 WHERE id = $1', [root.id, old]);
    await take({photo_id: root.id, concepto: 'bottle'});
    const {rows} = await db.query<{occurred_at: string}>('SELECT occurred_at FROM assistant.stock_photos WHERE parent_photo_id = $1', [root.id]);
    expect(new Date(rows[0]!.occurred_at)).toEqual(old);
  });

  it('R14: un resultado con otra imagen en un reintento se rechaza', async () => {
    await take();
    const root = await lastRequest();
    await complete(root.request_id);
    await take({photo_id: root.id, concepto: 'bottle'});
    const request = (await events()).at(-1)!.payload.solicitud_id;
    await photos.photoUrl(user, {request_id: request, role: 'numerada', content_type: 'image/jpeg'});
    await expect(photos.done(user, {request_id: request, sam: sam(1), fuente: 'camara', imagen_sha256: 'c'.repeat(64)})).rejects.toMatchObject({code: 'CONFLICT'});
    await photos.done(user, {request_id: request, sam: sam(1), fuente: 'camara', imagen_sha256: SHA});
  });

  it('R14: sin original subido no hay reintento', async () => {
    await take();
    const {id} = await lastRequest();
    expect(await take({photo_id: id})).toEqual({status: 'fallida', motivo: 'sin_original'});
  });

  it('una foto ajena o inexistente da 404', async () => {
    await take();
    const {id} = await lastRequest();
    await expect(photos.get(randomUUID(), id)).rejects.toMatchObject(notFound());
  });

  it('reintento con photo_id inexistente o ajeno: fallida foto_desconocida, sin evento ni llamada a SAM', async () => {
    await take();
    const {id} = await lastRequest();
    const before = await db.query<{n: number}>(`SELECT count(*)::int AS n FROM assistant.stock_robot_events WHERE kind = 'foto'`);
    expect(await take({photo_id: randomUUID()})).toEqual({status: 'fallida', motivo: 'foto_desconocida'});
    expect(await photos.take(user, randomUUID(), {idempotency_key: randomUUID(), concepto: 'jar', etiqueta: 'frascos', photo_id: id})).toEqual({status: 'fallida', motivo: 'foto_desconocida'});
    const after = await db.query<{n: number}>(`SELECT count(*)::int AS n FROM assistant.stock_robot_events WHERE kind = 'foto'`);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('evento vencido a los 30 minutos: pasa a vencido y la espera en curso responde fallida', async () => {
    photos = build(10_000);
    const waiting = take();
    await new Promise(resolve => setTimeout(resolve, 30));
    now.value = new Date(now.value.getTime() + 29 * 60_000);
    await photos.sweep();
    expect((await events())[0]!.status).toBe('pendiente');
    now.value = new Date(now.value.getTime() + 2 * 60_000);
    await photos.sweep();
    expect(await waiting).toEqual({status: 'fallida', motivo: 'vencido'});
    expect((await events())[0]!.status).toBe('vencido');
  });

  it('fuente simulada queda marcada', async () => {
    await take();
    const {id, request_id} = await lastRequest();
    await photos.photoUrl(user, {request_id, role: 'original', content_type: 'image/jpeg'});
    await photos.photoUrl(user, {request_id, role: 'numerada', content_type: 'image/jpeg'});
    await photos.done(user, {request_id, sam: sam(1), fuente: 'simulada', imagen_sha256: SHA});
    expect(await photos.get(business, id)).toMatchObject({fuente: 'simulada', simulado: true});
  });

  it('el adaptador de bucket firma el content-type pedido', async () => {
    const gcs = gcsPhotoStore('saleads-dev-meta-assistant-stock', {email: 'a@b.iam.gserviceaccount.com', sign: async () => Buffer.from('x')});
    const url = new URL(await gcs.signPut('n/f/original.png', 'image/png', 300, now.value));
    expect(url.pathname).toBe('/saleads-dev-meta-assistant-stock/n/f/original.png');
    expect(url.searchParams.get('X-Goog-Expires')).toBe('300');
    expect(url.searchParams.get('X-Goog-SignedHeaders')).toBe('content-type;host');
  });
});
