import {randomUUID} from 'node:crypto';
import {recordMovement} from '../src/stock/ledger';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';
import {approve, count, createWorld, key, propose, seedKit, seedVariant, stockIn, type World} from './support/stock-world';

describe('libro de inventario', () => {
  let db: TestDatabase;
  let world: World;

  beforeAll(async () => {db = await startTestDatabase();});
  afterAll(async () => {await db.close();});
  beforeEach(async () => {world = await createWorld(db);});

  const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 10, minute));
  const ledger = () => world.stock.ledger;
  const balance = (variantId: string) => ledger().balance(world.businessId, variantId, null);

  /** Devolución: ningún `kind` de propuesta la crea todavía, así que entra por la puerta del libro con confirmación real. */
  const giveBack = async (variantId: string, delta: number) => {
    const proposal = await propose(world, 'venta', {variante_id: variantId, cantidad: 1});
    await world.stock.proposals.reject({userId: world.userId}, world.businessId, proposal.id, proposal.revision, key());
    const {rows} = await world.db.query<{id: string; trace_id: string}>(
      'SELECT c.id, p.trace_id FROM assistant.stock_confirmations c JOIN assistant.stock_proposals p ON p.id = c.proposal_id WHERE p.id = $1', [proposal.id]);
    await world.db.tx(tx => recordMovement(tx, {businessId: world.businessId, variantId, kind: 'devolucion', delta, occurredAt: world.now.value, origin: 'prueba',
      confirmationId: rows[0]!.id, proposalId: proposal.id, traceId: rows[0]!.trace_id, actor: 'prueba', runId: null, simulated: false}));
  };

  it('conteo 39 con saldo 42 a las 10:00, +60 a las 10:05 y conteo aprobado a las 10:10: 99, no 39', async () => {
    const variantId = await seedVariant(world);
    world.now.value = at(-10);
    await stockIn(world, variantId, 42);
    world.now.value = at(0);
    const proposal = await count(world, variantId, 39);
    world.now.value = at(5);
    await stockIn(world, variantId, 60);
    world.now.value = at(10);
    await approve(world, proposal, 'otra');
    expect(await balance(variantId)).toBe(99);
    expect((await ledger().expected(world.businessId, variantId, null)).expected).toBe(99);
    expect(await ledger().balanceAt(world.businessId, variantId, null, at(0))).toBe(39);
  });

  it('el ajuste queda en conteo_en y recorded_at sigue el reloj de la base', async () => {
    const variantId = await seedVariant(world);
    world.now.value = new Date('2031-01-01T00:00:00Z');
    await stockIn(world, variantId, 5);
    const {rows} = await world.db.query<{occurred_at: Date; recorded_at: Date}>('SELECT occurred_at, recorded_at FROM assistant.stock_movements WHERE variant_id = $1', [variantId]);
    expect(new Date(rows[0]!.occurred_at).toISOString()).toBe('2031-01-01T00:00:00.000Z');
    expect(Math.abs(new Date(rows[0]!.recorded_at).getTime() - Date.now())).toBeLessThan(60_000);
  });

  it('occurred_at usa el desfase del negocio', async () => {
    await world.db.query(`INSERT INTO assistant.stock_clock_offsets(business_id,offset_seconds,updated_by) VALUES ($1,3600,'banco')`, [world.businessId]);
    const variantId = await seedVariant(world);
    world.now.value = at(0);
    await stockIn(world, variantId, 5);
    const {rows} = await world.db.query<{occurred_at: Date}>('SELECT occurred_at FROM assistant.stock_movements WHERE variant_id = $1', [variantId]);
    expect(new Date(rows[0]!.occurred_at).toISOString()).toBe('2026-11-01T11:00:00.000Z');
  });

  it('una devolución entre conteos no produce diferencia en el siguiente conteo exacto', async () => {
    const variantId = await seedVariant(world);
    world.now.value = at(0);
    await stockIn(world, variantId, 10);
    world.now.value = at(1);
    await approve(world, await count(world, variantId, 10));
    world.now.value = at(2);
    await giveBack(variantId, 2);
    world.now.value = at(3);
    expect((await ledger().expected(world.businessId, variantId, null))).toMatchObject({expected: 12, returned: 2, lastCount: 10});
    const next = await count(world, variantId, 12);
    expect(next.tipo === 'conteo' && next.detalle.diferencia).toBe(0);
  });

  it('primer conteo sin base: se toma 0', async () => {
    const variantId = await seedVariant(world);
    const proposal = await count(world, variantId, 24);
    expect(proposal.tipo === 'conteo' && proposal.detalle.esperado).toBe(0);
    await approve(world, proposal, 'otra');
    expect(await balance(variantId)).toBe(24);
  });

  it('un conteo más viejo que el último confirmado queda superado', async () => {
    const variantId = await seedVariant(world);
    world.now.value = at(0);
    const older = await count(world, variantId, 5);
    world.now.value = at(1);
    await approve(world, await count(world, variantId, 8), 'otra');
    await expect(approve(world, older, 'otra')).rejects.toMatchObject({code: 'CONFLICT'});
    expect(await balance(variantId)).toBe(8);
  });

  it('si saldo_a(conteo_en) cambia, sube la revisión y el dueño ve la cifra nueva', async () => {
    const variantId = await seedVariant(world);
    world.now.value = at(0);
    const early = await count(world, variantId, 3);
    world.now.value = at(1);
    const late = await count(world, variantId, 5);
    await approve(world, early, 'otra');
    await expect(approve(world, late, 'otra')).rejects.toMatchObject({code: 'CONFLICT'});
    const fresh = await world.stock.proposals.get(world.businessId, late.id);
    expect(fresh.revision).toBe(late.revision + 1);
    expect(fresh.tipo === 'conteo' && fresh.detalle).toMatchObject({esperado: 3, diferencia: 2});
    await approve(world, fresh, 'otra');
    expect(await balance(variantId)).toBe(5);
  });

  it('una venta que dejaría -1 responde STOCK_NEGATIVE, sin movimiento, y deja un evento recount', async () => {
    const variantId = await seedVariant(world);
    await stockIn(world, variantId, 2);
    const proposal = await propose(world, 'venta', {variante_id: variantId, cantidad: 3});
    await expect(approve(world, proposal)).rejects.toMatchObject({code: 'STOCK_NEGATIVE', status: 409});
    expect(await balance(variantId)).toBe(2);
    const {rows} = await world.db.query<{kind: string; payload: {variante_id: string}; status: string}>('SELECT kind, payload, status FROM assistant.stock_robot_events WHERE proposal_id = $1', [proposal.id]);
    expect(rows).toEqual([{kind: 'recount', payload: {variante_id: variantId, motivo: 'stock_negativo'}, status: 'pendiente'}]);
    await expect(world.stock.proposals.get(world.businessId, proposal.id)).resolves.toMatchObject({estado: 'pendiente'});
  });

  it('una venta exacta deja saldo 0 y es válida (par de no negativo)', async () => {
    const variantId = await seedVariant(world);
    await stockIn(world, variantId, 3);
    await approve(world, await propose(world, 'venta', {variante_id: variantId, cantidad: 3}));
    expect(await balance(variantId)).toBe(0);
  });

  it('todo movimiento nuevo escribe stock_audit con su trace_id', async () => {
    const variantId = await seedVariant(world);
    await stockIn(world, variantId, 3);
    const {rows} = await world.db.query<{action: string; same: boolean}>(
      `SELECT a.action, a.trace_id = m.trace_id AS same FROM assistant.stock_movements m JOIN assistant.stock_audit a ON a.entity_id = m.id::text WHERE m.variant_id = $1`, [variantId]);
    expect(rows).toEqual([{action: 'movimiento', same: true}]);
  });

  it('un run activo aísla lectura y libro: las filas reales no se ven y viceversa', async () => {
    const real = await seedVariant(world);
    await stockIn(world, real, 5);
    const runId = randomUUID();
    await world.db.query(`INSERT INTO assistant.stock_runs(id,business_id,name,seed,status) VALUES ($1,$2,'r','s','activo')`, [runId, world.businessId]);
    await expect(propose(world, 'venta', {variante_id: real, cantidad: 1})).rejects.toMatchObject({code: 'NOT_FOUND'});
    const simulated = await seedVariant(world, 'Simulado', {runId});
    const proposal = await propose(world, 'venta', {variante_id: simulated, cantidad: 1});
    expect(proposal.simulado).toBe(true);
    await expect(ledger().balance(world.businessId, simulated, null)).resolves.toBe(0);
    await world.db.query(`UPDATE assistant.stock_runs SET status='cerrado' WHERE id=$1`, [runId]);
    await expect(world.stock.proposals.list(world.businessId)).resolves.not.toEqual(expect.arrayContaining([expect.objectContaining({id: proposal.id})]));
  });

  it('un kit y sus candados no se bloquean en cruz (orden por variante)', async () => {
    const [a, b] = [await seedVariant(world), await seedVariant(world)];
    await stockIn(world, a, 10);
    await stockIn(world, b, 10);
    const [ab, ba] = [await seedKit(world, [[a, 1], [b, 1]]), await seedKit(world, [[b, 1], [a, 1]])];
    await Promise.all([approve(world, await propose(world, 'venta', {variante_id: ab, cantidad: 1})), approve(world, await propose(world, 'venta', {variante_id: ba, cantidad: 1}))]);
    expect(await balance(a)).toBe(8);
  });

  it('toma el candado de cada variante en orden, antes de tocar la propuesta y el libro', async () => {
    const [a, b] = [await seedVariant(world), await seedVariant(world)];
    await stockIn(world, a, 5);
    await stockIn(world, b, 5);
    const kit = await seedKit(world, [[a, 1], [b, 1]]);
    const proposal = await propose(world, 'venta', {variante_id: kit, cantidad: 1});
    const seen: Array<{sql: string; params?: unknown[]}> = [];
    const originalTx = world.db.tx.bind(world.db);
    world.db.tx = work => originalTx(tx => work({query: ((sql: string, params?: unknown[]) => {seen.push({sql, params}); return tx.query(sql, params);}) as typeof tx.query}));
    await approve(world, proposal);
    const locks = seen.filter(item => item.sql.includes('pg_advisory_xact_lock')).map(item => item.params?.[0]);
    expect(locks).toEqual([a, b].sort());
    const lastLock = seen.map(item => item.sql.includes('pg_advisory_xact_lock')).lastIndexOf(true);
    expect(lastLock).toBeLessThan(seen.findIndex(item => item.sql.includes('FOR UPDATE')));
    expect(lastLock).toBeLessThan(seen.findIndex(item => item.sql.includes('INSERT INTO assistant.stock_movements')));
  });

  it('R3 y R5: tras 200 secuencias sembradas, saldo y esperado coinciden con un modelo en memoria independiente', async () => {
    let seed = 20261101;
    const random = (max: number) => {seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % max;};
    let minute = 0;
    const tick = () => {world.now.value = new Date(Date.UTC(2026, 10, 1) + ++minute * 60_000); return world.now.value.getTime();};
    let steps = 0;
    for (let sequence = 0; sequence < 200; sequence++) {
      const variantId = await seedVariant(world);
      // El modelo no usa SQL ni funciones del libro: su propia lista de hechos.
      const facts: Array<{at: number; delta: number; kind: 'in' | 'out' | 'adjust'}> = [];
      let base = 0;
      let baseAt = -Infinity;
      const modelBalance = (until = Infinity) => facts.filter(fact => fact.at <= until).reduce((sum, fact) => sum + fact.delta, 0);
      const modelExpected = () => base + facts.filter(fact => fact.at > baseAt && fact.kind !== 'adjust').reduce((sum, fact) => sum + fact.delta, 0);
      for (let step = 0; step < 4; step++) {
        const action = random(3);
        const amount = 1 + random(9);
        if (action === 0) {
          const time = tick();
          await stockIn(world, variantId, amount);
          facts.push({at: time, delta: amount, kind: 'in'});
        } else if (action === 1) {
          const proposal = await propose(world, 'venta', {variante_id: variantId, cantidad: amount});
          const time = tick();
          if (modelBalance() >= amount) {
            await approve(world, proposal);
            facts.push({at: time, delta: -amount, kind: 'out'});
          } else {
            await expect(approve(world, proposal)).rejects.toMatchObject({code: 'STOCK_NEGATIVE'});
          }
        } else {
          const countedAt = tick();
          const proposal = await count(world, variantId, amount);
          if (random(2) === 0) { // Aprobación tardía: entra mercancía entre el conteo y su aprobación.
            const time = tick();
            await stockIn(world, variantId, 3);
            facts.push({at: time, delta: 3, kind: 'in'});
          }
          const delta = amount - modelBalance(countedAt);
          tick();
          await approve(world, proposal, 'otra');
          if (delta !== 0) facts.push({at: countedAt, delta, kind: 'adjust'});
          base = amount;
          baseAt = countedAt;
        }
        steps++;
        expect(await balance(variantId)).toBe(modelBalance());
        expect((await ledger().expected(world.businessId, variantId, null)).expected).toBe(modelExpected());
      }
      expect(await balance(variantId)).toBe((await ledger().expected(world.businessId, variantId, null)).expected);
    }
    expect(steps).toBe(800);
  }, 180_000);
});
