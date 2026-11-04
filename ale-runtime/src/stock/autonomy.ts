import {randomUUID} from 'node:crypto';
import {StockAreaV1, StockAutonomyAreaV1, StockAutonomyV1, type StockProposalKindV1, type StockProposeRequestV1} from '../contracts/stock-v1';
import {conflict, forbidden, invalidRequest, serviceUnavailable} from '../domain/errors';
import {argsHash, writeAudit} from './audit';
import {AUTONOMY_AREAS, INITIAL_AUTONOMY_LEVEL, type StockSettings} from './config';
import {activeRun, type StockDb, type StockQuery} from './store';

/** R33: qué habilita cada peldaño. Lista cerrada: pagar no es una capacidad en ningún nivel (R36). */
export const LEVEL_CAPABILITIES = {
  1: ['aprender'],
  2: ['aprender', 'proponer'],
  3: ['aprender', 'proponer', 'operar_con_limites'],
  4: ['aprender', 'proponer', 'operar_con_limites', 'operar_negocio'],
} as const;
type Level = keyof typeof LEVEL_CAPABILITIES;

const KIND_AREA: Record<Exclude<StockProposalKindV1, 'autonomia'>, StockAreaV1> = {
  conteo: 'inventario', entrada: 'inventario', venta: 'inventario', catalogo: 'inventario', union_catalogo: 'inventario',
  pedido: 'reposicion', kit: 'ofertas', apuesta: 'ofertas',
};
export const areaOf = (request: StockProposeRequestV1): StockAreaV1 => request.kind === 'autonomia' ? request.detalle.area : KIND_AREA[request.kind];

const ACTIONS: Record<StockAreaV1, string> = {inventario: 'operar el inventario', reposicion: 'reponer', negociacion: 'negociar', ofertas: 'operar las ofertas'};

const spoken = (amount: string | number): string => Number(amount).toLocaleString('es-CO', {maximumFractionDigits: 2});

/** Frases de plantilla: solo llevan enums y cifras del servidor. El modelo no aporta ninguna palabra. */
export const autonomyTexts = (input: {area: StockAreaV1; nivel: number; efectivo: number; monto: string; ahorro: string; moneda: string}) => ({
  title: `Permiso para ${ACTIONS[input.area]}: nivel ${input.nivel}`,
  reason: `Pedido recibido sin diferencia y ahorro confirmado de ${spoken(input.ahorro)} ${input.moneda}.`,
  effectsYes: [`Queda registrado tu permiso. El nivel real sigue en ${input.efectivo}: nada se compra ni se paga solo.`],
  effectsNo: [`Todo sigue igual, en nivel ${input.efectivo}.`],
  // `pregunta` va en falso al guardarla: se responde en pantalla, y no debe contar como la última pregunta de un conteo.
  notice: `Ya recibimos un pedido completo y ahorramos ${spoken(input.ahorro)} ${input.moneda}. ¿Me das permiso para ${ACTIONS[input.area]} hasta ${spoken(input.monto)} ${input.moneda}? Decídelo en la pantalla de Stock.`,
});

export interface AutonomyEvidence {dato: string; valor: string; fuente: string; simulado: boolean}
export interface AutonomyState {level: number; revision: number}
export interface StockBlocked {estado: 'bloqueado'; bloqueo: {codigo: 'nivel_autonomia'; area: StockAreaV1; nivel_efectivo: number; texto: string}}

interface GrantProof {revision_nivel: number; tope_al_aprobar: number}

/**
 * Escalera de autonomía (R33 a R36). Toda decisión de tope sale de `effective`: ni el modelo ni una ruta interna
 * pueden cambiarla. Aprobar registra permiso y nunca toca `level`; el permiso nace atado a la revisión del área y al
 * tope vigente, así que bajar de nivel lo anula y subir el tope exige una aprobación nueva.
 */
export class Autonomy {
  constructor(private readonly db: StockDb, private readonly settings: StockSettings) {}

  private async state(q: StockQuery, businessId: string, area: StockAreaV1): Promise<AutonomyState> {
    const {rows} = await q.query<AutonomyState>('SELECT level, revision FROM assistant.stock_autonomy WHERE business_id = $1 AND area = $2', [businessId, area]);
    return rows[0] ?? {level: INITIAL_AUTONOMY_LEVEL, revision: 1};
  }

  /** Nivel que de verdad puede operar: lo guardado o lo aprobado por el dueño, siempre bajo el tope del servidor. */
  async effective(q: StockQuery, businessId: string, area: StockAreaV1): Promise<number> {
    const {level, revision} = await this.state(q, businessId, area);
    const {rows} = await q.query<{granted: number | null}>(
      `SELECT max(r.to_level)::int AS granted
         FROM assistant.stock_autonomy_requests r JOIN assistant.stock_proposals p ON p.id = r.proposal_id
        WHERE r.business_id = $1 AND r.area = $2 AND p.run_id IS NOT DISTINCT FROM $3 AND r.to_level > r.from_level
          AND (r.evidence->>'revision_nivel')::int = $4 AND (r.evidence->>'tope_al_aprobar')::int >= r.to_level`,
      [businessId, area, await activeRun(q, businessId), revision]);
    return Math.min(this.settings.maxAutonomyLevel, Math.max(level, rows[0]?.granted ?? 0));
  }

  async assert(businessId: string, area: StockAreaV1, level: number): Promise<void> {
    if (await this.effective(this.db, businessId, area) < level) throw forbidden();
  }

  /**
   * Única puerta para un pedido sin propuesta aprobada. Sin permiso y bajo el tope responde 403; con ambos pasa la
   * barrera y aun así no opera: comprar en nivel 3 no entra en esta ola, y aquí no hay escritura posible.
   */
  async orderWithoutProposal(businessId: string): Promise<never> {
    await this.assert(businessId, 'reposicion', 3);
    throw serviceUnavailable();
  }

  /** R33: en un nivel sin `proponer`, la herramienta responde bloqueado y no crea nada. */
  async blocked(q: StockQuery, businessId: string, area: StockAreaV1): Promise<StockBlocked | null> {
    const effective = await this.effective(q, businessId, area);
    if ((LEVEL_CAPABILITIES[effective as Level] as readonly string[]).includes('proponer')) return null;
    return {estado: 'bloqueado', bloqueo: {codigo: 'nivel_autonomia', area, nivel_efectivo: effective, texto: `El área ${area} está en nivel ${effective}: observa y aprende, sin proponer.`}};
  }

  async levels(businessId: string, area: StockAreaV1, q: StockQuery = this.db) {
    const [{level, revision}, effective] = [await this.state(q, businessId, area), await this.effective(q, businessId, area)];
    return StockAutonomyAreaV1.parse({area, nivel: level, nivel_efectivo: effective, revision});
  }

  /** Solo lee: un negocio habilitado sin filas igual ve las cuatro áreas. */
  async read(businessId: string) {
    const areas = [];
    for (const area of AUTONOMY_AREAS) areas.push(await this.levels(businessId, area));
    return StockAutonomyV1.parse({areas});
  }

  /** Serializa peticiones, permisos y bajadas de un área. Crea la fila si el negocio aún no la tiene. */
  async lock(tx: StockQuery, businessId: string, area: StockAreaV1): Promise<AutonomyState> {
    await tx.query('INSERT INTO assistant.stock_autonomy(business_id, area, level) VALUES ($1, $2, $3) ON CONFLICT (business_id, area) DO NOTHING', [businessId, area, INITIAL_AUTONOMY_LEVEL]);
    const {rows} = await tx.query<AutonomyState>('SELECT level, revision FROM assistant.stock_autonomy WHERE business_id = $1 AND area = $2 FOR UPDATE', [businessId, area]);
    return rows[0]!;
  }

  /**
   * El dueño baja, o devuelve a nivel 2 un área que él mismo dejó en 1: ese es el único regreso, nunca sube más. Cambiar
   * la revisión anula todo permiso anterior: regresar no revive un nivel 3 aprobado antes. `motivo` e idempotencia quedan
   * en el historial del área.
   */
  async lower(actor: {userId: string}, businessId: string, area: StockAreaV1, revision: number, key: string, level: number, motivo?: string) {
    const hash = argsHash(['bajar', area, level, motivo ?? null]);
    return this.db.tx(async tx => {
      const current = await this.lock(tx, businessId, area);
      const {rows} = await tx.query<{request_hash: string}>(
        `SELECT evidence->>'request_hash' AS request_hash FROM assistant.stock_autonomy_requests WHERE business_id = $1 AND evidence->>'idempotency_key' = $2`, [businessId, key]);
      if (rows[0]) {
        if (rows[0].request_hash !== hash) throw conflict();
        return this.levels(businessId, area, tx);
      }
      const restoring = current.level === 1 && level === INITIAL_AUTONOMY_LEVEL;
      if (level >= current.level && !restoring) throw invalidRequest();
      if (current.revision !== revision) throw conflict();
      await tx.query('UPDATE assistant.stock_autonomy SET level = $3, revision = revision + 1, updated_at = now() WHERE business_id = $1 AND area = $2', [businessId, area, level]);
      const id = randomUUID();
      await tx.query(
        'INSERT INTO assistant.stock_autonomy_requests(id,business_id,area,from_level,to_level,evidence) VALUES ($1,$2,$3,$4,$5,$6)',
        [id, businessId, area, current.level, level, JSON.stringify({motivo: motivo ?? null, actor: actor.userId, idempotency_key: key, request_hash: hash})]);
      await writeAudit(tx, {businessId, traceId: randomUUID(), actor: actor.userId, action: restoring ? 'regresar_nivel' : 'bajar_nivel', entity: 'stock_autonomy_requests', entityId: id, args: {area, level}});
      return this.levels(businessId, area, tx);
    });
  }

  /** Condición de pedir, calculada del libro: `null` si ningún pedido la cumple. El modelo no aporta ninguna cifra. */
  async evidence(q: StockQuery, businessId: string, runId: string | null): Promise<{items: AutonomyEvidence[]; ahorro: string} | null> {
    const {rows} = await q.query<{quantity: number; entered: number; saving: string; simulated: boolean}>(
      `SELECT o.quantity, o.saving_confirmed AS saving, o.simulated,
              COALESCE((SELECT sum(m.delta) FROM assistant.stock_movements m WHERE m.order_id = o.id AND m.kind = 'entrada'), 0)::int AS entered
         FROM assistant.stock_orders o
        WHERE o.business_id = $1 AND o.run_id IS NOT DISTINCT FROM $2 AND o.status = 'recibido' AND o.received_qty = o.quantity AND o.saving_confirmed > 0`, [businessId, runId]);
    const orders = rows.filter(row => row.entered === row.quantity);
    if (!orders.length) return null;
    const simulado = orders.some(row => row.simulated);
    const ahorro = (orders.reduce((sum, row) => sum + Math.round(Number(row.saving) * 100), 0) / 100).toFixed(2);
    return {ahorro, items: [
      {dato: 'Pedidos recibidos sin diferencia', valor: String(orders.length), fuente: 'pedidos', simulado},
      {dato: 'Unidades recibidas y confirmadas', valor: String(orders.reduce((sum, row) => sum + row.entered, 0)), fuente: 'movimientos', simulado},
      {dato: 'Ahorro confirmado', valor: ahorro, fuente: 'pedidos', simulado},
    ]};
  }

  /** R35: registra el permiso. Si el área cambió desde la petición o la evidencia ya no se sostiene, no hay permiso. */
  async grant(tx: StockQuery, input: {businessId: string; runId: string | null; proposalId: string; area: StockAreaV1; level: number; montoTope: string; revision: number}): Promise<void> {
    const current = await this.lock(tx, input.businessId, input.area);
    const evidence = await this.evidence(tx, input.businessId, input.runId);
    if (current.revision !== input.revision || !evidence) throw conflict();
    const proof: GrantProof = {revision_nivel: current.revision, tope_al_aprobar: this.settings.maxAutonomyLevel};
    await tx.query(
      'INSERT INTO assistant.stock_autonomy_requests(id,business_id,area,from_level,to_level,evidence,proposal_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [randomUUID(), input.businessId, input.area, current.level, input.level, JSON.stringify({...proof, monto_tope: input.montoTope, evidencia: evidence.items}), input.proposalId]);
  }

  /** ¿El permiso de esa propuesta sigue siendo la respuesta vigente? Si bajaron el nivel o cambió el tope, se puede pedir otra vez. */
  async grantStands(q: StockQuery, proposalId: string, state: AutonomyState): Promise<boolean> {
    const {rows} = await q.query<{evidence: GrantProof}>('SELECT evidence FROM assistant.stock_autonomy_requests WHERE proposal_id = $1', [proposalId]);
    const proof = rows[0]?.evidence;
    return proof?.revision_nivel === state.revision && proof.tope_al_aprobar === this.settings.maxAutonomyLevel;
  }
}
