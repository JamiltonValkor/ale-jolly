import {startTestDatabase, type TestDatabase} from './support/pglite-db';
import {approve, count, createWorld, key, propose, say, seedKit, seedVariant, stockIn, type World} from './support/stock-world';

/** Las pruebas de negocio de `plan-negocio.md` que dependen del libro. Cada una nombra la regla que garantiza. */
describe('reglas de negocio de Stock', () => {
  let db: TestDatabase;
  let world: World;

  beforeAll(async () => {db = await startTestDatabase();});
  afterAll(async () => {await db.close();});
  beforeEach(async () => {world = await createWorld(db);});

  const balance = (variantId: string) => world.stock.ledger.balance(world.businessId, variantId, null);
  const movements = async (variantId: string) => (await world.db.query<{kind: string; delta: number; cause: string | null; confirmation_id: string}>(
    'SELECT kind, delta, cause, confirmation_id FROM assistant.stock_movements WHERE variant_id = $1 ORDER BY recorded_at', [variantId])).rows;

  it('R4: un conteo sin confirmar no cambia el saldo, y al aprobarlo sí', async () => {
    const variantId = await seedVariant(world);
    await stockIn(world, variantId, 10);
    const proposal = await count(world, variantId, 7);
    expect(await balance(variantId)).toBe(10);
    await approve(world, proposal, 'venta');
    expect(await balance(variantId)).toBe(7);
  });

  it('R4: una propuesta rechazada no crea movimiento, y su par aprobado sí', async () => {
    const variantId = await seedVariant(world);
    await stockIn(world, variantId, 10);
    const [rejected, approved] = [await propose(world, 'venta', {variante_id: variantId, cantidad: 3}), await propose(world, 'venta', {variante_id: variantId, cantidad: 2})];
    await world.stock.proposals.reject({userId: world.userId}, world.businessId, rejected.id, rejected.revision, key(), 'no fue');
    expect(await balance(variantId)).toBe(10);
    await approve(world, approved);
    expect(await balance(variantId)).toBe(8);
  });

  it('R2: vender 3 kits de (1 A, 2 B) inserta A-3 y B-6 con la misma confirmación', async () => {
    const [a, b] = [await seedVariant(world), await seedVariant(world)];
    await stockIn(world, a, 10);
    await stockIn(world, b, 10);
    const kit = await seedKit(world, [[a, 1], [b, 2]]);
    await approve(world, await propose(world, 'venta', {variante_id: kit, cantidad: 3}));
    const [ma, mb] = [(await movements(a)).at(-1)!, (await movements(b)).at(-1)!];
    expect(ma).toMatchObject({kind: 'venta', delta: -3});
    expect(mb).toMatchObject({kind: 'venta', delta: -6});
    expect(ma.confirmation_id).toBe(mb.confirmation_id);
    expect(await balance(a)).toBe(7);
    expect(await balance(b)).toBe(4);
  });

  it('R2: un kit con un componente insuficiente no mueve nada', async () => {
    const [a, b] = [await seedVariant(world), await seedVariant(world)];
    await stockIn(world, a, 10);
    await stockIn(world, b, 1);
    const kit = await seedKit(world, [[a, 1], [b, 2]]);
    const before = [...await movements(a), ...await movements(b)].length;
    await expect(approve(world, await propose(world, 'venta', {variante_id: kit, cantidad: 1}))).rejects.toMatchObject({code: 'STOCK_NEGATIVE'});
    expect([...await movements(a), ...await movements(b)].length).toBe(before);
  });

  describe('R6: una diferencia produce una pregunta', () => {
    const differing = async () => {
      const variantId = await seedVariant(world);
      await stockIn(world, variantId, 10);
      return {variantId, proposal: await count(world, variantId, 8)};
    };

    it('deja causa_requerida con las opciones, y aprobar sin causa falla por web', async () => {
      const {proposal} = await differing();
      if (proposal.tipo !== 'conteo') throw new Error('tipo');
      expect(proposal.detalle).toMatchObject({causa_requerida: true, causa_opciones: ['venta', 'fiado', 'movimiento', 'otra'], esperado: 10, contado: 8, diferencia: -2});
      await expect(approve(world, proposal)).rejects.toMatchObject({code: 'INVALID_REQUEST'});
      await expect(world.stock.proposals.get(world.businessId, proposal.id)).resolves.toMatchObject({estado: 'pendiente'});
    });

    it('un conteo que cuadra no pregunta', async () => {
      const variantId = await seedVariant(world);
      await stockIn(world, variantId, 10);
      const proposal = await count(world, variantId, 10);
      if (proposal.tipo !== 'conteo') throw new Error('tipo');
      expect(proposal.detalle).toMatchObject({causa_requerida: false, causa_opciones: []});
      await expect(approve(world, proposal)).resolves.toMatchObject({estado: 'aprobada'});
    });

    it('con causa crea el ajuste por web', async () => {
      const {variantId, proposal} = await differing();
      await approve(world, proposal, 'fiado');
      expect((await movements(variantId)).at(-1)).toMatchObject({kind: 'ajuste', delta: -2, cause: 'fiado'});
    });

    it('con causa crea el ajuste por voz, y sin causa falla', async () => {
      const {variantId, proposal} = await differing();
      await say(world, 'sí');
      const {proposals} = world.stock;
      await expect(proposals.confirmByVoice(world.userId, world.businessId, proposal.id, proposal.revision)).rejects.toMatchObject({code: 'INVALID_REQUEST'});
      await proposals.confirmByVoice(world.userId, world.businessId, proposal.id, proposal.revision, 'venta');
      expect((await movements(variantId)).at(-1)).toMatchObject({kind: 'ajuste', cause: 'venta'});
    });

    it('con causa crea el ajuste por canal, y sin causa falla', async () => {
      const {variantId, proposal} = await differing();
      const {proposals} = world.stock;
      await expect(proposals.confirmByChannel(world.userId, world.businessId, proposal.id, proposal.revision, 'sí, fueron dos', 's1')).rejects.toMatchObject({code: 'INVALID_REQUEST'});
      await proposals.confirmByChannel(world.userId, world.businessId, proposal.id, proposal.revision, 'sí, fueron dos', 's1', 'movimiento');
      expect((await movements(variantId)).at(-1)).toMatchObject({kind: 'ajuste', cause: 'movimiento'});
    });
  });
});
