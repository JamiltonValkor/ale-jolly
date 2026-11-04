import {randomUUID} from 'node:crypto';
import {traceMovement} from '../src/stock/audit';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';
import {approve, createWorld, propose, say, seconds, seedDocument, seedVariant, stockIn, type World} from './support/stock-world';

describe('trazabilidad', () => {
  let db: TestDatabase;
  beforeAll(async () => {db = await startTestDatabase();});
  afterAll(async () => {await db.close();});

  const presentPhoto = async (world: World, total: number) => {
    const id = randomUUID();
    await world.db.query(
      `INSERT INTO assistant.stock_photos(id,business_id,user_id,request_id,status,concept,label,object_original,object_numerada,total,occurred_at)
       VALUES ($1,$2,$3,$1,'lista','jar','frasco',$4,$5,$6,$7)`, [id, world.businessId, world.userId, `${world.businessId}/${id}/original.jpg`, `${world.businessId}/${id}/numerada.png`, total, world.now.value]);
    await world.db.query(`INSERT INTO assistant.stock_audit(id,business_id,trace_id,actor,action,entity,entity_id,args_hash) VALUES ($1,$2,$3::uuid,'robot','photo_done','stock_photos',$3::text,$4)`,
      [randomUUID(), world.businessId, id, 'a'.repeat(64)]);
    return id;
  };
  const movementOf = async (world: World, proposalId: string) => (await world.db.query<{id: string; trace_id: string}>('SELECT id, trace_id FROM assistant.stock_movements WHERE proposal_id = $1', [proposalId])).rows[0]!;

  it('desde `movement.id` llega a confirmación, propuesta, foto, tarjeta y frase en una consulta', async () => {
    const world = await createWorld(db);
    const variantId = await seedVariant(world);
    await stockIn(world, variantId, 10);
    const card = await world.stock.usage.reserveCard(world.businessId, 'conteo');
    if (!card.permitida) throw new Error('sin cupo');
    const photoId = await presentPhoto(world, 7);
    const created = await world.stock.proposals.create(world.userId, world.businessId, 'mcp', {
      kind: 'conteo', idempotency_key: `${card.id}-1`, detalle: {variante_id: variantId, contado: 7, origen: 'foto', photo_id: photoId},
    } as never);
    if (created.estado !== 'creada') throw new Error(created.estado);
    await say(world, 'sí', {recordedAt: seconds(1)});
    await world.stock.proposals.confirmByVoice(world.userId, world.businessId, created.propuesta.id, created.propuesta.revision, 'fiado');
    const movement = await movementOf(world, created.propuesta.id);
    expect(movement.trace_id).toBe(card.id);

    const chain = (await traceMovement(world.db, movement.id, null))!;
    expect(chain.propuesta).toEqual({id: created.propuesta.id, tipo: 'conteo'});
    expect(chain.confirmacion).toMatchObject({metodo: 'voz'});
    expect(chain.foto).toMatchObject({id: photoId, estado: 'lista', objeto: `${world.businessId}/${photoId}/original.jpg`});
    expect(chain.tarjeta).toEqual({clave: card.clave});
    expect(chain.frase).toMatchObject({texto: 'sí'});
    expect(chain.auditoria.map(item => item.action)).toEqual(expect.arrayContaining(['tarjeta_reservada', 'movimiento', 'photo_done']));
  });

  it('una clave con un uuid que el servidor no reservó no adopta esa traza', async () => {
    const world = await createWorld(db);
    const variantId = await seedVariant(world);
    const forged = randomUUID();
    const created = await world.stock.proposals.create(world.userId, world.businessId, 'mcp', {kind: 'conteo', idempotency_key: `${forged}-1`, detalle: {variante_id: variantId, contado: 1, origen: 'voz'}} as never);
    if (created.estado !== 'creada') throw new Error(created.estado);
    const {rows} = await world.db.query<{trace_id: string}>('SELECT trace_id FROM assistant.stock_proposals WHERE id = $1', [created.propuesta.id]);
    expect(rows[0]!.trace_id).not.toBe(forged);
  });

  it('llega al documento por una entrada, y el registro sobrevive aunque el bucket borre la imagen', async () => {
    const world = await createWorld(db);
    const variantId = await seedVariant(world, 'Shampoo', {unitCost: '1000.00'});
    const {documentId, lineas} = await seedDocument(world, [{variantId, quantity: 4, unitCost: '1000.00'}]);
    const proposal = await propose(world, 'entrada', {document_id: documentId, lineas});
    await approve(world, proposal);
    const chain = (await traceMovement(world.db, (await movementOf(world, proposal.id)).id, null))!;
    expect(chain.documento?.id).toBe(documentId);
    expect(chain.foto).toBeNull();
    expect(chain.confirmacion).toMatchObject({metodo: 'web'});
  });

  // IVB-024, cierre de la oficial: la cadena de la entrada salía con `tarjeta: null` porque su clave no traía `tarjeta.id`.
  it('una entrada sin tarjeta.id en la clave adopta la traza de la tarjeta factura de su documento, y de ninguna otra', async () => {
    const world = await createWorld(db);
    const variantId = await seedVariant(world, 'Tónico', {unitCost: '1000.00'});
    const {documentId, lineas} = await seedDocument(world, [{variantId, quantity: 4, unitCost: '1000.00'}]);
    const other = await seedDocument(world, [{variantId, quantity: 2, unitCost: '1000.00'}]);
    const card = await world.stock.usage.reserveCard(world.businessId, 'factura', documentId);
    if (!card.permitida) throw new Error('sin cupo');
    const proposal = await propose(world, 'entrada', {document_id: documentId, lineas});
    await approve(world, proposal);
    const movement = await movementOf(world, proposal.id);
    expect(movement.trace_id).toBe(card.id);
    expect((await traceMovement(world.db, movement.id, null))!.tarjeta).toEqual({clave: card.clave});
    const unrelated = await propose(world, 'entrada', {document_id: other.documentId, lineas: other.lineas});
    const {rows} = await world.db.query<{trace_id: string}>('SELECT trace_id FROM assistant.stock_proposals WHERE id = $1', [unrelated.id]);
    expect(rows[0]!.trace_id).not.toBe(card.id);
  });

  it('un movimiento de otra corrida no se ve', async () => {
    const world = await createWorld(db);
    const variantId = await seedVariant(world);
    await stockIn(world, variantId, 3);
    const {rows} = await world.db.query<{id: string}>('SELECT id FROM assistant.stock_movements WHERE business_id = $1', [world.businessId]);
    expect(await traceMovement(world.db, rows[0]!.id, randomUUID())).toBeNull();
  });
});
