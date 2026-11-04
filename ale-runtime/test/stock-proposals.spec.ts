import {randomUUID} from 'node:crypto';
import {mcpOfferingsReader} from '../src/stock/offerings';
import {isAffirmative} from '../src/stock/proposals';
import {nameSimilarity} from '../src/stock/store';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';
import {approve, count, createWorld, created, key, propose, say, seconds, seedDocument, seedVariant, stockIn, type World} from './support/stock-world';

describe('propuestas de Stock', () => {
  let db: TestDatabase;
  let world: World;

  beforeAll(async () => {db = await startTestDatabase();});
  afterAll(async () => {await db.close();});
  beforeEach(async () => {world = await createWorld(db);});

  const proposals = () => world.stock.proposals;
  const balance = (variantId: string) => world.stock.ledger.balance(world.businessId, variantId, null);
  const rowCount = async (sql: string, params: unknown[]) => (await world.db.query<{n: number}>(sql, params)).rows[0]!.n;

  describe('enlace profundo', () => {
    it('lo arma el servidor con la base y el idioma; sin base es nulo y el modelo no puede enviarlo', async () => {
      const variantId = await seedVariant(world);
      const body = {idempotency_key: key(), kind: 'conteo', detalle: {variante_id: variantId, contado: 3, origen: 'voz'}};
      expect(await proposals().create(world.userId, world.businessId, 'mcp', body)).toMatchObject({estado: 'creada', enlace: null});
      const deps = (proposals() as unknown as {deps: {webBaseUrl?: string; locale?: (user: string) => Promise<string | null>}}).deps;
      deps.webBaseUrl = 'https://dev.saleads.ai';
      deps.locale = async () => 'en-US';
      const created = await proposals().create(world.userId, world.businessId, 'mcp', {...body, idempotency_key: key()});
      if (created.estado !== 'creada') throw new Error('sin propuesta');
      expect(created.enlace).toBe(`https://dev.saleads.ai/en/dashboard/meta-assistant?tab=stock&vista=por-aprobar&negocio=${world.businessId}&propuesta=${created.propuesta.id}`);
      await expect(proposals().create(world.userId, world.businessId, 'mcp', {...body, idempotency_key: key(), enlace: 'https://evil.example'})).rejects.toThrow();
    });
  });

  describe('R10: el costo solo se escribe tras confirmar en pantalla', () => {
    const entry = async () => {
      const variantId = await seedVariant(world);
      const {documentId, lineas} = await seedDocument(world, [{variantId, quantity: 12, unitCost: '17000', doubtful: ['cantidad']}]);
      return {variantId, proposal: await propose(world, 'entrada', {document_id: documentId, lineas})};
    };
    const cost = async (variantId: string) => (await world.db.query<{unit_cost: string | null}>('SELECT unit_cost FROM assistant.stock_variants WHERE id = $1', [variantId])).rows[0]!.unit_cost;

    it('sin aprobar no hay costo; approveWeb lo escribe y muestra lo dudoso', async () => {
      const {variantId, proposal} = await entry();
      expect(proposal.tipo === 'entrada' && proposal.detalle.lineas).toEqual([{descripcion: expect.stringMatching(/^Producto → /), cantidad: 12, costo_unitario: '17000.00', dudoso: ['cantidad']}]);
      expect(await cost(variantId)).toBeNull();
      await approve(world, proposal);
      expect(Number(await cost(variantId))).toBe(17000);
      expect(await balance(variantId)).toBe(12);
    });

    it('confirmByVoice y confirmByChannel dan FORBIDDEN en todo tipo distinto de conteo', async () => {
      const {variantId, proposal} = await entry();
      await stockIn(world, variantId, 10);
      const others = [proposal, await propose(world, 'venta', {variante_id: variantId, cantidad: 1}), await propose(world, 'apuesta', {
        variante_id: variantId, presupuesto_diario: '10', tope: '100', duracion_dias: 7, unidades_semana_previstas: null, fuente_prevision: 'supuesto'})];
      await say(world, 'sí');
      for (const item of others) {
        await expect(proposals().confirmByVoice(world.userId, world.businessId, item.id, item.revision)).rejects.toMatchObject({code: 'FORBIDDEN', status: 403});
        await expect(proposals().confirmByChannel(world.userId, world.businessId, item.id, item.revision, 'sí', 's')).rejects.toMatchObject({code: 'FORBIDDEN'});
      }
      expect(await cost(variantId)).not.toBe('17000.00');
      await expect(rowCount('SELECT count(*)::int AS n FROM assistant.stock_confirmations WHERE proposal_id = $1', [proposal.id])).resolves.toBe(0);
    });
  });

  describe('R7: un duplicado se propone unir, nunca se une solo', () => {
    const catalog = (producto: string, nombre = '250 ml') => propose(world, 'catalogo', {producto, variantes: [{nombre}], oferta: {type: 'product', id: 'o-1'}});

    it('dos productos similares producen union_catalogo; sin aprobar siguen, y aprobada suma sin mover filas', async () => {
      await approve(world, await catalog('Shampoo Reparador Capilar'));
      await approve(world, await catalog('Shampoo Reparador Capilar Plus'));
      const pending = (await proposals().list(world.businessId, 'pendiente')).filter(item => item.tipo === 'union_catalogo');
      expect(pending).toHaveLength(1);
      const union = pending[0]!;
      if (union.tipo !== 'union_catalogo') throw new Error('tipo');
      const {origen_id: origin, destino_id: target} = union.detalle;
      expect(union.detalle.similitud).toBeGreaterThanOrEqual(0.6);
      await stockIn(world, origin, 4);
      await stockIn(world, target, 6);
      expect([await balance(origin), await balance(target)]).toEqual([4, 6]);
      await expect(rowCount('SELECT count(*)::int AS n FROM assistant.stock_variant_aliases WHERE alias_variant_id = $1', [origin])).resolves.toBe(0);
      const before = (await world.db.query('SELECT id, variant_id FROM assistant.stock_movements WHERE variant_id = ANY($1::uuid[]) ORDER BY id', [[origin, target]])).rows;
      await approve(world, await proposals().get(world.businessId, union.id));
      expect([await balance(origin), await balance(target)]).toEqual([10, 10]);
      const listed = (await world.stock.reads.items(world.businessId)).items.map(item => item.variante_id);
      expect(listed).toContain(target);
      expect(listed).not.toContain(origin);
      expect((await world.db.query('SELECT id, variant_id FROM assistant.stock_movements WHERE variant_id = ANY($1::uuid[]) ORDER BY id', [[origin, target]])).rows).toEqual(before);
    });

    it('nombres distintos no proponen unión, y el umbral es 0,6', async () => {
      await approve(world, await catalog('Shampoo Reparador'));
      await approve(world, await catalog('Mascarilla de Argán'));
      expect((await proposals().list(world.businessId, 'pendiente')).filter(item => item.tipo === 'union_catalogo')).toEqual([]);
      expect(nameSimilarity('shampoo reparador', 'mascarilla de argan')).toBeLessThan(0.6);
    });

    it('el mismo nombre normalizado no crea un segundo producto', async () => {
      await approve(world, await catalog('Crema de Rizos'));
      await expect(catalog('crema  de RIZOS')).rejects.toMatchObject({code: 'CONFLICT'});
    });
  });

  describe('R1: la oferta se liga sin cambiarla', () => {
    it('una oferta inexistente da error sin escribir; una existente queda ligada', async () => {
      world.offerings.find.mockResolvedValueOnce(null);
      await expect(propose(world, 'catalogo', {producto: 'Sin oferta', variantes: [{nombre: 'x'}], oferta: {type: 'product', id: 'nope'}})).rejects.toMatchObject({code: 'NOT_FOUND'});
      await expect(rowCount('SELECT count(*)::int AS n FROM assistant.stock_proposals WHERE business_id = $1', [world.businessId])).resolves.toBe(0);
      const proposal = await propose(world, 'catalogo', {producto: 'Con oferta', variantes: [{nombre: 'x'}], oferta: {type: 'product', id: 'o-9'}});
      await approve(world, proposal);
      const {rows} = await world.db.query('SELECT offering_type, offering_id, offering_name FROM assistant.stock_products WHERE business_id = $1', [world.businessId]);
      expect(rows).toEqual([{offering_type: 'product', offering_id: 'o-9', offering_name: 'Oferta'}]);
    });

    it('recorre next_cursor: una oferta de la página 2 se liga, y el espía solo ve la lectura exacta', async () => {
      const call = jest.fn(async (_token: string, _name: string, args: Record<string, unknown>) => args.cursor
        ? {ok: true as const, data: {offerings: [{type: 'service', id: 'o-2', name: 'Servicio', price: 29000, currency: 'COP'}], next_cursor: null}}
        : {ok: true as const, data: {offerings: [{type: 'product', id: 'o-1', name: 'Uno'}], next_cursor: 'p2'}});
      const reader = mcpOfferingsReader({mcp: {call}, accessToken: async () => 't', timeoutMs: 1000});
      await expect(reader.find('u', 'b', {type: 'service', id: 'o-2'})).resolves.toEqual({type: 'service', id: 'o-2', name: 'Servicio', price: 29000, currency: 'COP'});
      await expect(reader.find('u', 'b', {type: 'product', id: 'ausente'})).resolves.toBeNull();
      expect([...new Set(call.mock.calls.map(item => item[1]))]).toEqual(['saleads_list_offerings']);
    });

    it('sin token o sin respuesta del MCP: SERVICE_UNAVAILABLE, nunca un falso inexistente', async () => {
      const failing = {call: jest.fn(async () => ({ok: false as const, code: 'mcp_unreachable'}))};
      await expect(mcpOfferingsReader({mcp: failing, accessToken: async () => null, timeoutMs: 1}).find('u', 'b', {type: 'product', id: 'x'})).rejects.toMatchObject({code: 'SERVICE_UNAVAILABLE'});
      await expect(mcpOfferingsReader({mcp: failing, accessToken: async () => 't', timeoutMs: 1}).find('u', 'b', {type: 'product', id: 'x'})).rejects.toMatchObject({code: 'SERVICE_UNAVAILABLE'});
    });
  });

  describe('R16: caja cerrada', () => {
    it('2 cajas con units_per_box=12 proponen 24', async () => {
      const variantId = await seedVariant(world, 'Caja', {unitsPerBox: 12});
      const proposal = await propose(world, 'conteo', {variante_id: variantId, contado: 2, cajas: 2, origen: 'foto'});
      expect(proposal.tipo === 'conteo' && proposal.detalle.contado).toBe(24);
    });

    it('sin units_per_box pregunta y no crea propuesta', async () => {
      const variantId = await seedVariant(world);
      const result = await proposals().create(world.userId, world.businessId, 'stock', {idempotency_key: key(), kind: 'conteo', detalle: {variante_id: variantId, contado: 2, cajas: 2, origen: 'foto'}});
      expect(result).toEqual({estado: 'pregunta', pregunta: {codigo: 'unidades_por_caja', texto: expect.stringContaining('unidades')}});
      await expect(rowCount('SELECT count(*)::int AS n FROM assistant.stock_proposals WHERE business_id = $1', [world.businessId])).resolves.toBe(0);
    });
  });

  describe('idempotencia y revisión', () => {
    const venta = async () => {
      const variantId = await seedVariant(world);
      await stockIn(world, variantId, 5);
      return {variantId, detalle: {variante_id: variantId, cantidad: 1}};
    };

    it('misma clave y hash devuelve lo mismo sin duplicar; otro hash, CONFLICT', async () => {
      const {variantId, detalle} = await venta();
      const body = {idempotency_key: key(), kind: 'venta', detalle};
      const [first, second] = [created(await proposals().create(world.userId, world.businessId, 'stock', body)), created(await proposals().create(world.userId, world.businessId, 'stock', body))];
      expect(second.id).toBe(first.id);
      await expect(proposals().create(world.userId, world.businessId, 'stock', {...body, detalle: {variante_id: variantId, cantidad: 2}})).rejects.toMatchObject({code: 'CONFLICT'});
    });

    it('la idempotencia va antes que la revisión: misma clave repite; clave nueva con revisión vieja da CONFLICT', async () => {
      const {variantId, detalle} = await venta();
      const proposal = await propose(world, 'venta', detalle);
      const decision = key();
      const actor = {userId: world.userId};
      const first = await proposals().approveWeb(actor, world.businessId, proposal.id, proposal.revision, decision);
      await expect(proposals().approveWeb(actor, world.businessId, proposal.id, proposal.revision, decision)).resolves.toEqual(first);
      expect(await balance(variantId)).toBe(4);
      await expect(proposals().approveWeb(actor, world.businessId, proposal.id, proposal.revision, key())).rejects.toMatchObject({code: 'CONFLICT'});
    });

    it('una clave de decisión reusada con otra decisión da CONFLICT', async () => {
      const {detalle} = await venta();
      const proposal = await propose(world, 'venta', detalle);
      const decision = key();
      await proposals().approveWeb({userId: world.userId}, world.businessId, proposal.id, proposal.revision, decision);
      await expect(proposals().reject({userId: world.userId}, world.businessId, proposal.id, proposal.revision, decision)).rejects.toMatchObject({code: 'CONFLICT'});
    });

    it('doble aprobación con revisión vieja, CONFLICT', async () => {
      const {detalle} = await venta();
      const proposal = await propose(world, 'venta', detalle);
      await expect(proposals().approveWeb({userId: world.userId}, world.businessId, proposal.id, proposal.revision + 5, key())).rejects.toMatchObject({code: 'CONFLICT'});
      await expect(approve(world, proposal)).resolves.toMatchObject({estado: 'aprobada'});
    });

    it('una propuesta vencida no se aprueba, y la lectura la marca vencida', async () => {
      const {detalle} = await venta();
      const proposal = await propose(world, 'venta', detalle);
      world.now.value = new Date(world.now.value.getTime() + 73 * 3_600_000);
      await expect(approve(world, proposal)).rejects.toMatchObject({code: 'CONFLICT'});
      await expect(proposals().get(world.businessId, proposal.id)).resolves.toMatchObject({estado: 'vencida'});
      expect((await proposals().list(world.businessId, 'pendiente')).map(item => item.id)).not.toContain(proposal.id);
      expect((await proposals().list(world.businessId, 'vencida')).map(item => item.id)).toContain(proposal.id);
    });

    it('rechazar nunca exige causa, aunque el conteo difiera', async () => {
      const variantId = await seedVariant(world);
      const proposal = await count(world, variantId, 5);
      await expect(proposals().reject({userId: world.userId}, world.businessId, proposal.id, proposal.revision, key())).resolves.toMatchObject({estado: 'rechazada'});
      expect(await balance(variantId)).toBe(0);
    });
  });

  describe('voz: el servidor resuelve la frase', () => {
    const pending = async (recount = 5) => {
      const variantId = await seedVariant(world);
      await stockIn(world, variantId, 5);
      return {variantId, proposal: await count(world, variantId, recount)};
    };
    const confirm = (proposal: {id: string; revision: number}) => proposals().confirmByVoice(world.userId, world.businessId, proposal.id, proposal.revision);

    it('una frase reciente y afirmativa confirma (par positivo)', async () => {
      const {proposal} = await pending();
      await say(world, 'Sí');
      await expect(confirm(proposal)).resolves.toMatchObject({estado: 'aprobada'});
    });

    it('una frase anterior a la propuesta se rechaza', async () => {
      await say(world, 'sí', {recordedAt: seconds(-120)});
      const {proposal} = await pending();
      await expect(confirm(proposal)).rejects.toMatchObject({code: 'CONFLICT'});
    });

    it('una frase de más de 180 s se rechaza', async () => {
      const {proposal} = await pending();
      await world.db.query('UPDATE assistant.stock_proposals SET recorded_at = $2 WHERE id = $1', [proposal.id, seconds(-600)]);
      await say(world, 'sí', {recordedAt: seconds(-181)});
      await expect(confirm(proposal)).rejects.toMatchObject({code: 'CONFLICT'});
    });

    it('la frase de otro usuario no sirve', async () => {
      const {proposal} = await pending();
      await say(world, 'sí', {userId: 'otro-usuario'});
      await expect(confirm(proposal)).rejects.toMatchObject({code: 'CONFLICT'});
      await expect(proposals().confirmByVoice('otro-usuario', world.businessId, proposal.id, proposal.revision)).rejects.toMatchObject({code: 'NOT_FOUND'});
    });

    it.each(['no está listo', 'si no', 'sí, espera', 'no', 'mentira', 'todavía no', 'listo no', 'ok', 'sí señor gracias', 'tal vez'])('«%s» no confirma', async text => {
      expect(isAffirmative(text)).toBe(false);
      const {proposal} = await pending();
      await say(world, text);
      await expect(confirm(proposal)).rejects.toMatchObject({code: 'CONFLICT'});
    });

    it.each(['sí', 'si', 'Confirmo', 'correcto', 'así es', 'dale', 'listo', 'dale pues'])('«%s» confirma', text => {
      expect(isAffirmative(text)).toBe(true);
    });

    it('una frase ya usada no confirma otra propuesta', async () => {
      const {proposal} = await pending();
      await say(world, 'sí');
      await confirm(proposal);
      const second = await pending();
      await expect(confirm(second.proposal)).rejects.toMatchObject({code: 'CONFLICT'});
    });

    describe('con dos conteos pendientes', () => {
      const asks = (proposalId: string) => world.db.query(
        `INSERT INTO assistant.stock_robot_events(business_id,user_id,kind,payload,proposal_id) VALUES ($1,$2,'decir','{"pregunta":true}',$3)`, [world.businessId, world.userId, proposalId]);

      it('si ninguna pregunta lo nombró, CONFLICT', async () => {
        const [a] = [(await pending()).proposal, (await pending()).proposal];
        await say(world, 'sí');
        await expect(confirm(a)).rejects.toMatchObject({code: 'CONFLICT'});
      });

      it('la frase solo confirma el que nombró la última pregunta', async () => {
        const [a, b] = [(await pending()).proposal, (await pending()).proposal];
        await asks(a.id);
        await asks(b.id);
        await say(world, 'sí');
        await expect(confirm(a)).rejects.toMatchObject({code: 'CONFLICT'});
        await expect(confirm(b)).resolves.toMatchObject({estado: 'aprobada'});
      });
    });
  });

  describe('canal atestiguado', () => {
    it('exige cita y deja la prueba', async () => {
      const variantId = await seedVariant(world);
      const proposal = await count(world, variantId, 0);
      await expect(proposals().confirmByChannel(world.userId, world.businessId, proposal.id, proposal.revision, '', 's')).rejects.toMatchObject({code: 'INVALID_REQUEST'});
      await proposals().confirmByChannel(world.userId, world.businessId, proposal.id, proposal.revision, 'sí, confirmo', 's-1');
      const {rows} = await world.db.query('SELECT method, quote, channel, session_id FROM assistant.stock_confirmations WHERE proposal_id = $1', [proposal.id]);
      expect(rows).toEqual([{method: 'canal', quote: 'sí, confirmo', channel: 'whatsapp', session_id: 's-1'}]);
    });
  });

  describe('textos del servidor', () => {
    const uuid = randomUUID();
    const details: Record<string, unknown> = {
      conteo: {variante_id: uuid, contado: 1, origen: 'voz'}, entrada: {document_id: uuid, lineas: [{linea_id: uuid, variante_id: null}]}, venta: {variante_id: uuid, cantidad: 1},
      catalogo: {producto: 'p', variantes: [{nombre: 'v'}], oferta: {type: 'product', id: 'o'}}, union_catalogo: {origen_id: uuid, destino_id: uuid},
      pedido: {variante_id: uuid, proveedor_id: uuid, cantidad: 1, mandato: {precio_objetivo: '1', tope: '2'}},
      kit: {subtipo: 'kit', componentes: [{variante_id: uuid, cantidad: 1}], diagnostico: 'd', fuentes: [], hipotesis: 'h'},
      apuesta: {variante_id: uuid, presupuesto_diario: '1', tope: '2', duracion_dias: 1, unidades_semana_previstas: null, fuente_prevision: 'dato'},
      autonomia: {area: 'inventario', nivel_pedido: 3, monto_tope: '1'},
    };

    it.each(Object.keys(details))('%s rechaza título, motivo y efectos enviados por el modelo', async kind => {
      for (const extra of [{titulo: 'x'}, {motivo: 'x'}, {efectos_si: ['x']}, {efectos_no: ['x']}]) {
        await expect(proposals().create(world.userId, world.businessId, 'stock', {idempotency_key: key(), kind, detalle: {...details[kind] as object, ...extra}})).rejects.toMatchObject({name: 'ZodError'});
        await expect(proposals().create(world.userId, world.businessId, 'stock', {idempotency_key: key(), kind, detalle: details[kind], ...extra})).rejects.toMatchObject({name: 'ZodError'});
      }
    });

    it('los textos libres se recortan a 300 caracteres sin saltos de línea', async () => {
      const variantId = await seedVariant(world, 'Base', {unitCost: '10'});
      const proposal = await propose(world, 'kit', {subtipo: 'kit', componentes: [{variante_id: variantId, cantidad: 2}], diagnostico: `a\nb${'x'.repeat(500)}`, fuentes: [], hipotesis: `h\n\n${'y'.repeat(500)}`});
      if (proposal.tipo !== 'kit') throw new Error('tipo');
      expect(proposal.motivo).toBe('Propuesta para mover producto parado, con margen del servidor.'); // El diagnóstico lo escribe el modelo: nunca va al diálogo.
      expect(proposal.detalle.hipotesis).toHaveLength(300);
      expect(proposal.detalle.hipotesis).not.toMatch(/\n/);
    });
  });

  describe('efectos por tipo', () => {
    it('kit aprobado crea 1 producto sin oferta, 1 variante y N componentes, y calcula el margen', async () => {
      const [a, b] = [await seedVariant(world, 'A', {unitCost: '1000'}), await seedVariant(world, 'B', {unitCost: '500'})];
      await stockIn(world, a, 7, '1000');
      await stockIn(world, b, 7, '500');
      const proposal = await propose(world, 'kit', {subtipo: 'kit', componentes: [{variante_id: a, cantidad: 1}, {variante_id: b, cantidad: 2}], precio_propuesto: '4000', diagnostico: 'd', fuentes: [], hipotesis: 'h'});
      if (proposal.tipo !== 'kit') throw new Error('tipo');
      expect(proposal.detalle).toMatchObject({costo_total: '2000.00', margen_dinero: '2000.00', margen_pct: 50, unidades_alcanzan: 3, costo_incompleto: false, precio_pendiente: false});
      await expect(rowCount('SELECT count(*)::int AS n FROM assistant.stock_products WHERE business_id = $1 AND is_kit', [world.businessId])).resolves.toBe(0);
      await approve(world, proposal);
      const {rows} = await world.db.query<{offering_id: string | null; variant: string; sale_price: string; parts: number}>(
        `SELECT p.offering_id, v.id AS variant, v.sale_price, (SELECT count(*)::int FROM assistant.stock_kit_components c WHERE c.kit_variant_id = v.id) AS parts
           FROM assistant.stock_products p JOIN assistant.stock_variants v ON v.product_id = p.id WHERE p.business_id = $1 AND p.is_kit`, [world.businessId]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({offering_id: null, parts: 2});
      expect(Number(rows[0]!.sale_price)).toBe(4000);
    });

    it('sin costo o sin precio no inventa margen', async () => {
      const a = await seedVariant(world, 'Sin costo');
      const proposal = await propose(world, 'kit', {subtipo: 'kit', componentes: [{variante_id: a, cantidad: 1}], diagnostico: 'd', fuentes: [], hipotesis: 'h'});
      expect(proposal.tipo === 'kit' && proposal.detalle).toMatchObject({costo_total: null, margen_dinero: null, margen_pct: null, costo_incompleto: true, precio_pendiente: true});
    });

    it('complemento aprobado solo guarda la propuesta', async () => {
      const a = await seedVariant(world, 'Base');
      await approve(world, await propose(world, 'kit', {subtipo: 'complemento', componentes: [{variante_id: a, cantidad: 1}], diagnostico: 'd', fuentes: [], hipotesis: 'h'}));
      await expect(rowCount('SELECT count(*)::int AS n FROM assistant.stock_products WHERE business_id = $1 AND is_kit', [world.businessId])).resolves.toBe(0);
    });

    it('apuesta aprobada congela el ritmo base y nada más; sin stock no existe', async () => {
      const variantId = await seedVariant(world);
      const apuesta = {variante_id: variantId, presupuesto_diario: '50000', tope: '500000', duracion_dias: 7, unidades_semana_previstas: 10, fuente_prevision: 'dato'};
      await expect(propose(world, 'apuesta', apuesta)).rejects.toMatchObject({code: 'CONFLICT'});
      await stockIn(world, variantId, 5);
      const movements = await rowCount('SELECT count(*)::int AS n FROM assistant.stock_movements WHERE variant_id = $1', [variantId]);
      await approve(world, await propose(world, 'apuesta', apuesta));
      await expect(rowCount('SELECT count(*)::int AS n FROM assistant.stock_rotation_baselines WHERE variant_id = $1 AND before_bet', [variantId])).resolves.toBe(1);
      await expect(rowCount('SELECT count(*)::int AS n FROM assistant.stock_movements WHERE variant_id = $1', [variantId])).resolves.toBe(movements);
      await expect(rowCount('SELECT count(*)::int AS n FROM assistant.stock_sim_campaigns WHERE variant_id = $1', [variantId])).resolves.toBe(0);
    });

    it('pedido sin variante ni proveedor propios responde 404, ya no 503', async () => {
      const uuid = randomUUID();
      await expect(propose(world, 'pedido', {variante_id: uuid, proveedor_id: uuid, cantidad: 1, mandato: {precio_objetivo: '1', tope: '2'}})).rejects.toMatchObject({code: 'NOT_FOUND'});
    });
  });

  describe('semilla', () => {
    const seeded = async (bench: boolean) => {
      const benchWorld = await createWorld(db, {bench});
      const runId = randomUUID();
      await benchWorld.db.query(`INSERT INTO assistant.stock_runs(id,business_id,name,seed,status) VALUES ($1,$2,'r','s','activo')`, [runId, benchWorld.businessId]);
      const variantId = await seedVariant(benchWorld, 'Simulado', {runId});
      return {benchWorld, runId, proposal: await count(benchWorld, variantId, 0)};
    };

    it('solo con STOCK_BENCH_ENABLED, simulated y run_id', async () => {
      const on = await seeded(true);
      await expect(on.benchWorld.stock.proposals.confirmSeed(on.benchWorld.businessId, on.proposal.id, on.proposal.revision, randomUUID())).rejects.toMatchObject({code: 'FORBIDDEN'});
      await expect(on.benchWorld.stock.proposals.confirmSeed(on.benchWorld.businessId, on.proposal.id, on.proposal.revision, on.runId)).resolves.toMatchObject({estado: 'aprobada', simulado: true});
      const off = await seeded(false);
      await expect(off.benchWorld.stock.proposals.confirmSeed(off.benchWorld.businessId, off.proposal.id, off.proposal.revision, off.runId)).rejects.toMatchObject({code: 'FORBIDDEN'});
    });

    it('una propuesta real no se confirma con semilla', async () => {
      const benchWorld = await createWorld(db, {bench: true});
      const variantId = await seedVariant(benchWorld);
      const proposal = await count(benchWorld, variantId, 0);
      await expect(benchWorld.stock.proposals.confirmSeed(benchWorld.businessId, proposal.id, proposal.revision, randomUUID())).rejects.toMatchObject({code: 'FORBIDDEN'});
    });
  });
});
