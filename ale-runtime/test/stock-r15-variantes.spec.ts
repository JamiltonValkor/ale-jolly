import {randomUUID} from 'node:crypto';
import {StockProposeResponseV1, StockProposalsV1, type StockProposalV1} from '../src/contracts/stock-v1';
import {saysReparto, spokenNumbers} from '../src/stock/proposals';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';
import {createWorld, key, say, stockIn, type World} from './support/stock-world';

type Box = [number, number, number, number];
/** Diez botellas en fila, como la foto sintética de IVB-023. */
const row = (from: number, to: number): Box[] => Array.from({length: to - from}, (_, index) => [(from + index) * 100, 0, (from + index) * 100 + 80, 200] as Box);

/**
 * R15 como barrera del servidor (IVB-023): dos veces seguidas, Stock tomó una foto de botellas iguales y propuso 5 y 5
 * entre reparador e hidratante. Las skills 1.0.0 y 1.0.1 no lo evitaron.
 */
describe('R15: si no se distingue la variante, Jolly pregunta y nunca reparte', () => {
  let db: TestDatabase;
  let world: World;
  let product: string;
  let reparador: string;
  let hidratante: string;

  beforeAll(async () => {db = await startTestDatabase();});
  afterAll(async () => {await db.close();});
  beforeEach(async () => {
    world = await createWorld(db);
    [product, reparador, hidratante] = [randomUUID(), randomUUID(), randomUUID()];
    await world.db.query(
      `INSERT INTO assistant.stock_products(id,business_id,user_id,name,normalized_name,offering_type,offering_id,offering_name,is_kit,occurred_at,simulated,run_id)
       VALUES ($1,$2,$3,'Shampoo','shampoo','product','o-1','Oferta',false,now(),false,null)`, [product, world.businessId, world.userId]);
    for (const [id, name] of [[reparador, 'Reparador'], [hidratante, 'Hidratante']]) {
      await world.db.query(`INSERT INTO assistant.stock_variants(id,product_id,name,currency) VALUES ($1,$2,$3,'COP')`, [id, product, name]);
    }
    await stockIn(world, reparador, 5);
    await stockIn(world, hidratante, 5);
  });

  /** Foto lista, como la deja `photo_done`. `parent` es la foto original de un reintento (R14). */
  async function photo(options: {concept?: string; boxes?: Box[]; parent?: string} = {}): Promise<string> {
    const id = randomUUID();
    const boxes = options.boxes ?? row(0, 10);
    await world.db.query(
      `INSERT INTO assistant.stock_photos(id,business_id,user_id,request_id,status,concept,label,parent_photo_id,object_original,object_numerada,sam,total,fuente,idempotency_key,occurred_at)
       VALUES ($1,$2,$3,$9,'lista',$4,'repisa',$5,'o.png','n.png',$6,$7,'camara',$10,$8)`,
      [id, world.businessId, world.userId, options.concept ?? 'bottle', options.parent ?? null,
        JSON.stringify({concepto: options.concept ?? 'bottle', total: boxes.length, ms: 1, objetos: boxes.map((caja, index) => ({n: index + 1, caja, confianza: 0.9}))}),
        boxes.length, world.now.value, id, id]);
    return id;
  }

  const propose = async (variante_id: string, contado: number, photo_id?: string, idempotency_key = key()) =>
    StockProposeResponseV1.parse(await world.stock.proposals.create(world.userId, world.businessId, 'stock', {
      idempotency_key, kind: 'conteo', detalle: {variante_id, contado, origen: photo_id ? 'foto' : 'voz', ...(photo_id ? {photo_id} : {})}}));
  const balance = (variantId: string) => world.stock.ledger.balance(world.businessId, variantId, null);
  const pending = async () => (await world.stock.proposals.list(world.businessId, 'pendiente')).filter(item => item.tipo === 'conteo');
  const proposalOf = (response: StockProposeResponseV1): StockProposalV1 => {
    if (!('propuesta' in response)) throw new Error(response.estado);
    return response.propuesta;
  };
  const dudosa = (proposal: StockProposalV1) => proposal.tipo === 'conteo' ? proposal.detalle : null;
  const approve = (proposal: StockProposalV1, reparto?: Array<{variante_id: string; contado: number; causa?: 'venta'}>) =>
    world.stock.proposals.approveWeb({userId: world.userId}, world.businessId, proposal.id, proposal.revision, key(), 'venta', undefined, reparto);

  describe('botellas iguales (IVB-023): se bloquea', () => {
    it('5 y 5 desde la misma foto deja una sola propuesta por producto con el total y una pregunta', async () => {
      const foto = await photo();
      const firstKey = key();
      const first = await propose(reparador, 5, foto, firstKey);
      expect(first.estado).toBe('creada');
      const second = await propose(hidratante, 5, foto);

      expect(second.estado).toBe('variante_por_confirmar');
      if (second.estado !== 'variante_por_confirmar') throw new Error();
      expect(second.pregunta.opciones.map(option => option.nombre).sort()).toEqual(['Hidratante', 'Reparador']);
      expect(second.pregunta.texto).toBe('Conté 10 de Shampoo y no distingo Reparador o Hidratante. ¿Cuántos hay de cada una?');
      expect(dudosa(second.propuesta)).toMatchObject({producto: 'Shampoo', contado: 10, esperado: 10, diferencia: 0, variante_dudosa: 'Reparador o Hidratante', total_objetos: 10});
      // El reparto de Stock desaparece: no queda ninguna propuesta por variante viva.
      expect((await pending()).map(item => item.id)).toEqual([second.propuesta.id]);
      expect((await world.stock.proposals.get(world.businessId, proposalOf(first).id)).estado).toBe('vencida');
      // El mismo shape del contrato congelado: el front estricto lo sigue leyendo.
      expect(StockProposalsV1.parse({propuestas: await world.stock.proposals.list(world.businessId, undefined, 50, {web: true})})).toBeTruthy();
      // Repetir la clave del primero, o proponer otra vez desde la foto, devuelve la misma propuesta por producto.
      expect(proposalOf(await propose(reparador, 5, foto, firstKey)).id).toBe(second.propuesta.id);
      expect(proposalOf(await propose(reparador, 7, foto)).id).toBe(second.propuesta.id);
      expect(await pending()).toHaveLength(1);
    });

    it('la plantilla «Conté 5 de Reparador» se descarta y la que queda es la pregunta del servidor', async () => {
      const foto = await photo();
      const first = proposalOf(await propose(reparador, 5, foto));
      const merged = proposalOf(await propose(hidratante, 5, foto));
      const {rows} = await world.db.query<{proposal_id: string; status: string; texto: string}>(
        `SELECT proposal_id, status, payload->>'texto' AS texto FROM assistant.stock_robot_events WHERE kind = 'decir' AND business_id = $1 ORDER BY id`, [world.businessId]);
      expect(rows.find(item => item.proposal_id === first.id)?.status).toBe('descartado');
      expect(rows.find(item => item.proposal_id === merged.id)?.texto).toContain('no distingo Reparador o Hidratante');
      // Aunque Ale escriba su propia pregunta con un reparto sugerido, sale la del servidor.
      await world.stock.notices.say(world.userId, world.businessId, {
        texto: '¿Son cinco reparador y cinco hidratante?', pregunta: true, proposal_id: merged.id, producto_id: null, prioridad: 'normal', dedupe_key: 'r15'});
      const said = await world.db.query<{texto: string}>(`SELECT payload->>'texto' AS texto FROM assistant.stock_robot_events WHERE dedupe_key = 'r15'`);
      expect(said.rows[0]?.texto).not.toContain('cinco');
    });

    it('un reintento sobre la misma imagen con el mismo concepto, aunque en plural, también se bloquea', async () => {
      const original = await photo();
      const retry = await photo({concept: 'bottles', parent: original});
      await propose(reparador, 5, original);
      expect((await propose(hidratante, 5, retry)).estado).toBe('variante_por_confirmar');
    });

    it('conceptos distintos que encuentran las mismas botellas no son evidencia', async () => {
      const original = await photo();
      const azul = await photo({concept: 'blue bottle', parent: original});
      const verde = await photo({concept: 'green bottle', parent: original});
      await propose(reparador, 10, azul);
      expect((await propose(hidratante, 10, verde)).estado).toBe('variante_por_confirmar');
      expect(dudosa((await pending())[0]!)).toMatchObject({contado: 10}); // Nunca más de lo que vio SAM.
    });

    it('si una variante ya se confirmó desde esa foto, la otra no nace: se pregunta', async () => {
      const foto = await photo();
      await approve(proposalOf(await propose(reparador, 5, foto)));
      const second = await propose(hidratante, 5, foto);
      expect(second).toMatchObject({estado: 'pregunta', pregunta: {codigo: 'variante'}});
      expect(await pending()).toHaveLength(0);
    });
  });

  describe('confirmar el reparto', () => {
    let merged: StockProposalV1;
    beforeEach(async () => {
      const foto = await photo();
      await propose(reparador, 5, foto);
      merged = proposalOf(await propose(hidratante, 5, foto));
    });

    it('R4: sin confirmar no cambia el saldo; en pantalla sin reparto, o con una suma distinta, no se aprueba', async () => {
      expect([await balance(reparador), await balance(hidratante)]).toEqual([5, 5]);
      await expect(approve(merged)).rejects.toMatchObject({code: 'INVALID_REQUEST'});
      await expect(approve(merged, [{variante_id: reparador, contado: 6}, {variante_id: hidratante, contado: 3}])).rejects.toMatchObject({code: 'INVALID_REQUEST'});
      await expect(approve(merged, [{variante_id: randomUUID(), contado: 10}])).rejects.toMatchObject({code: 'INVALID_REQUEST'});
      expect([await balance(reparador), await balance(hidratante)]).toEqual([5, 5]);
    });

    it('el inventario muestra las dos variantes con el conteo por aprobar, sin cifra inventada por variante', async () => {
      const {items} = await world.stock.reads.items(world.businessId);
      for (const id of [reparador, hidratante]) {
        expect(items.find(item => item.variante_id === id)).toMatchObject({estado: 'conteo_por_aprobar', propuesta_id: merged.id, contado: null, diferencia: null});
      }
    });

    it('en pantalla con el reparto del dueño: un conteo y un ajuste por variante, con la misma confirmación', async () => {
      const approved = await approve(merged, [{variante_id: reparador, contado: 6}, {variante_id: hidratante, contado: 4}]);
      expect(approved.estado).toBe('aprobada');
      expect([await balance(reparador), await balance(hidratante)]).toEqual([6, 4]);
      const {rows} = await world.db.query<{variant_id: string; counted: number; confirmation_id: string}>(
        'SELECT variant_id, counted, confirmation_id FROM assistant.stock_counts WHERE proposal_id = $1 ORDER BY counted', [merged.id]);
      expect(rows.map(item => [item.variant_id, item.counted])).toEqual([[hidratante, 4], [reparador, 6]]);
      expect(rows[0]!.confirmation_id).toBe(rows[1]!.confirmation_id);
    });

    it('por voz, un «sí» no basta: la frase del dueño debe traer cada cantidad y cada variante', async () => {
      const reparto = [{variante_id: reparador, contado: 6}, {variante_id: hidratante, contado: 4}];
      const confirm = (withReparto = true) => world.stock.proposals.confirmByVoice(world.userId, world.businessId, merged.id, merged.revision, 'venta', withReparto ? reparto : undefined);
      await say(world, 'sí');
      await expect(confirm(false)).rejects.toMatchObject({code: 'INVALID_REQUEST'});
      await expect(confirm()).rejects.toMatchObject({code: 'CONFLICT'});
      await say(world, 'seis de reparador');
      await expect(confirm()).rejects.toMatchObject({code: 'CONFLICT'});
      await say(world, 'son seis reparadores y cuatro hidratantes');
      expect((await confirm()).estado).toBe('aprobada');
      expect([await balance(reparador), await balance(hidratante)]).toEqual([6, 4]);
    });

    it('por canal, la cita debe traer el reparto', async () => {
      const reparto = [{variante_id: reparador, contado: 5}, {variante_id: hidratante, contado: 5}];
      const confirm = (quote: string) => world.stock.proposals.confirmByChannel(world.userId, world.businessId, merged.id, merged.revision, quote, 'sesion-1', undefined, reparto);
      await expect(confirm('sí, confirmo')).rejects.toMatchObject({code: 'CONFLICT'});
      expect((await confirm('Hay 5 reparador y 5 hidratante')).estado).toBe('aprobada');
    });
  });

  describe('evidencia distinta de la foto: pasa', () => {
    it('SAM con un concepto por variante que separa objetos distintos sobre la misma imagen', async () => {
      const original = await photo();
      const azul = await photo({concept: 'blue bottle', parent: original, boxes: row(0, 6)});
      const verde = await photo({concept: 'green bottle', parent: original, boxes: row(6, 10)});
      const [first, second] = [await propose(reparador, 6, azul), await propose(hidratante, 4, verde)];
      expect([first.estado, second.estado]).toEqual(['creada', 'creada']);
      await approve(proposalOf(first));
      await approve(proposalOf(second));
      expect([await balance(reparador), await balance(hidratante)]).toEqual([6, 4]);
    });

    it('fotos distintas, una por repisa', async () => {
      expect((await propose(reparador, 5, await photo())).estado).toBe('creada');
      expect((await propose(hidratante, 5, await photo())).estado).toBe('creada');
    });

    it('lo dijo la dueña: conteos sin foto', async () => {
      expect((await propose(reparador, 6)).estado).toBe('creada');
      expect((await propose(hidratante, 4)).estado).toBe('creada');
    });

    it('la misma variante contada dos veces desde la foto no es un reparto', async () => {
      const foto = await photo();
      await propose(reparador, 10, foto);
      expect((await propose(reparador, 10, foto)).estado).toBe('creada');
    });
  });

  describe('lectura de la frase', () => {
    it('números en palabras y en cifras', () => {
      expect(spokenNumbers('treinta y dos, veintidós y 7; ninguno de los otros')).toEqual([32, 22, 7, 0]);
    });

    it('sin negaciones, con cada variante y cada cantidad', () => {
      const names = ['Reparador', 'Hidratante'];
      const reparto = [{contado: 6, nombre: 'Reparador'}, {contado: 4, nombre: 'Hidratante'}];
      expect(saysReparto('seis reparadores y cuatro hidratantes', reparto, names)).toBe(true);
      expect(saysReparto('no, seis reparadores y cuatro hidratantes', reparto, names)).toBe(false);
      expect(saysReparto('seis y cuatro', reparto, names)).toBe(false);
      expect(saysReparto('cinco y cinco', [{contado: 5, nombre: 'Reparador'}, {contado: 5, nombre: 'Hidratante'}], names)).toBe(false);
      expect(saysReparto('cinco reparador y cinco hidratante', [{contado: 5, nombre: 'Reparador'}, {contado: 5, nombre: 'Hidratante'}], names)).toBe(true);
      expect(saysReparto('cinco reparador', [{contado: 5, nombre: 'Reparador'}, {contado: 5, nombre: 'Hidratante'}], names)).toBe(false);
    });
  });
});
