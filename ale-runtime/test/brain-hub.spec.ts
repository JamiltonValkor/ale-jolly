import {BrainHubRepository} from '../src/brain-hub/repository';
import {BrainHubService} from '../src/brain-hub/service';
import {findPii} from '../src/brain-hub/pii';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';

const BUSINESS = '00000000-0000-4000-8000-000000000002';
const LESSON = 'Para novias funciona mejor mostrar el proceso completo del maquillaje que solo el resultado final.';

describe('buzón del Cerebro SaleADS (OSB-015)', () => {
  let db: TestDatabase;
  let service: BrainHubService;
  const share = (user = 'u1', text = LESSON, provenance = 'owner_decided') =>
    service.shareLesson(user, {business_id: BUSINESS, industry_slug: 'belleza_y_cuidado_personal', text, provenance});

  beforeAll(async () => {db = await startTestDatabase();});
  afterAll(async () => {await db.close();});
  beforeEach(async () => {
    for (const table of ['lessons', 'catalog_items', 'installs', 'sharing_preferences']) await db.database.pool.query(`DELETE FROM brain_hub.${table}`);
    service = new BrainHubService({repository: new BrainHubRepository(db.database.pool), admins: new Set(['owner'])});
  });

  it('acepta lecciones de lo que el dueño dice o decide', async () => {
    const result = await share();
    expect(result).toMatchObject({accepted: true, reason: 'received'});
    expect((await service.ownerLessons('u1')).map(l => l.text)).toEqual([LESSON]);
  });

  it.each(['platform', 'inferred_from_platform', 'inferred', 'saleads_seed'])('procedencia %s → 422 sin escribir', async provenance => {
    await expect(share('u1', LESSON, provenance)).rejects.toMatchObject({code: 'REJECTED', status: 422});
    expect(await service.ownerLessons('u1')).toEqual([]);
  });

  it.each([
    ['email', 'Escríbele a la clienta a cliente.vip@gmail.com para confirmar la cita del sábado.'],
    ['phone_or_id', 'Si llaman al 300 123 4567 hay que responder antes de una hora para no perder la venta.'],
    ['url_query', 'El anuncio que mejor funcionó fue https://beauty.example/promo?utm_source=ig&cliente=88 en temporada.'],
    ['document', 'La clienta con cédula 1020304050 pidió factura con todos sus datos al comprar el kit.'],
    ['person_name', 'Ana López siempre compra el kit de novia cuando le mostramos el antes y después en historias.'],
  ])('PII (%s) → 422 sin escribir', async (kind, text) => {
    expect(findPii(text)).toBe(kind);
    await expect(share('u1', text)).rejects.toMatchObject({status: 422});
  });

  it('una lección sin PII no da falsos positivos', () => {
    expect(findPii(LESSON)).toBeNull();
    expect(findPii('Los martes de 7 a 9 pm las publicaciones de tutoriales reciben más mensajes por WhatsApp.')).toBeNull();
  });

  it('compartir viene activado y la API no permite apagarlo (MLB-017); una fila vieja apagada no acepta lecciones hasta reactivar', async () => {
    expect(await service.sharing('u1')).toEqual({enabled: true, notice_pending: true});
    await expect(service.setSharing('u1', false)).rejects.toMatchObject({status: 400});
    expect(await service.sharing('u1')).toMatchObject({enabled: true});
    await db.database.pool.query("INSERT INTO brain_hub.sharing_preferences (user_id, opted_out_at) VALUES ('u1', now())");
    expect(await share()).toEqual({accepted: false, lesson_id: null, reason: 'sharing_off'});
    expect(await service.setSharing('u1', true)).toMatchObject({enabled: true});
    expect((await service.ackNotice('u1')).notice_pending).toBe(false);
  });

  it('el dueño ve solo sus lecciones', async () => {
    await share('u1');
    await share('u2', 'Para quinceañeras conviene mostrar paquetes con fotos del evento y no solo del maquillaje.');
    expect((await service.ownerLessons('u2')).map(l => l.text)).toEqual([expect.stringContaining('quinceañeras')]);
  });

  it('la API admin exige la lista blanca', async () => {
    await expect(service.adminLessons('intruso', {})).rejects.toMatchObject({code: 'FORBIDDEN', status: 403});
  });

  it('validar y publicar crea un ítem del catálogo con versión y procedencia; retirar lo saca', async () => {
    const {lesson_id} = await share();
    await service.validate('owner', lesson_id!);
    const published = await service.publish('owner', lesson_id!, {item_id: 'skill.beauty.process', name: 'Muestra el proceso', summary: 'Contenido de proceso para novias.'});
    expect(published).toEqual({catalog_item_id: 'skill.beauty.process', version: '1.0.0'});
    expect((await service.activeItem('skill.beauty.process'))?.source).toBe('validated_lesson');
    expect((await service.catalog('belleza_y_cuidado_personal')).map(i => i.id)).toEqual(['skill.beauty.process']);
    const lessons = await service.adminLessons('owner', {status: 'published'});
    expect(lessons[0]?.catalog_item_id).toBe('skill.beauty.process');
    expect((await service.adminCatalog('owner')).map(i => i.id)).toEqual(['skill.beauty.process']);
    await expect(service.adminCatalog('intruso')).rejects.toMatchObject({code: 'FORBIDDEN', status: 403});
    await service.retire('owner', 'skill.beauty.process');
    expect(await service.activeItem('skill.beauty.process')).toBeNull();
    expect(await service.adminCatalog('owner')).toEqual([]);
  });

  it('publicar una versión nueva reemplaza a la anterior sin retirarla', async () => {
    for (const text of [LESSON, 'Para novias funciona publicar testimonios aprobados por el dueño, nunca inventados ni editados.']) {
      const {lesson_id} = await share('u1', text);
      await service.validate('owner', lesson_id!);
      await service.publish('owner', lesson_id!, {item_id: 'skill.beauty.process', name: 'Muestra el proceso', summary: null});
    }
    expect((await service.activeItem('skill.beauty.process'))?.version).toBe('1.1.0');
    const {rows} = await db.database.pool.query("SELECT version, status FROM brain_hub.catalog_items ORDER BY version");
    expect(rows).toEqual([{version: '1.0.0', status: 'superseded'}, {version: '1.1.0', status: 'active'}]);
  });

  it('no se publica una lección sin validar', async () => {
    const {lesson_id} = await share();
    await expect(service.publish('owner', lesson_id!, {item_id: 'skill.x', name: 'X', summary: null})).rejects.toMatchObject({status: 400});
  });
});
