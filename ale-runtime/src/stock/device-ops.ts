import {traceMovement} from './audit';
import type {StockUsage} from './usage';
import {randomUUID} from 'node:crypto';
import {Logger} from '@nestjs/common';
import type {Response} from 'express';
import {DeviceOpV1} from '../contracts/stock-v1';
import {conflict, invalidRequest, notFound, serviceUnavailable} from '../domain/errors';
import type {DeviceIdentity} from '../devices/devices.service';
import type {StockDeviceOps} from '../http/devices.controller';
import type {StockAccess} from './access';
import type {StockClock} from './clock';
import {STOCK_LIMITS, type StockSettings} from './config';
import type {NoticeEvent, Notices} from './notices';
import type {StockPhotos} from './photos';
import type {Proposals} from './proposals';
import type {StockDb} from './store';

export type WakeResult = 'solicitado' | 'sin_job' | 'antirrebote' | 'tope' | 'vm_no_lista' | 'no_disponible';
export interface DeviceOpsDeps {
  usage: Pick<StockUsage, 'runBudgets'>;
  db: StockDb; settings: StockSettings; photos: StockPhotos; proposals: Proposals; access: StockAccess;
  /** `bench_seed` corre con propuestas atadas a una sola transacción: si una falla, el lote entero no deja nada (IVB-024). */
  atomicProposals<T>(work: (scoped: Proposals) => Promise<T>): Promise<T>; clock: StockClock; now: () => Date; heartbeatMs: number; notices: Notices;
  wake?(userId: string, businessId: string, reason: 'banco'): Promise<WakeResult>;
  /** Solo con el adaptador simulado: la respuesta del proveedor en el banco. */
  supplierReply?(text: string): void;
  /** Abrir el hilo de eventos pide sincronizar: el robot no pasa por `GET /assistants/me`. */
  kick?(userId: string): void;
}

interface Connection {pump(): void; end(): void}
type EventRow = {id: string | number; kind: string; payload: {solicitud_id?: string} | NoticeEvent['payload']};
type Op<K extends DeviceOpV1['op']> = Extract<DeviceOpV1, {op: K}>;

const KEEPALIVE = ': keepalive\n\n';
const frame = (event: EventRow) => {
  const id = Number(event.id);
  return `event: stock\nid: ${id}\ndata: ${JSON.stringify({id, kind: event.kind, payload: event.payload})}\n\n`;
};

/**
 * Órdenes por `POST /devices/me/stream`, porque el gateway no admite otra ruta. Nada de aquí abre un turno: ni eventos,
 * ni el fin de una foto. Una conexión por usuario; la más nueva cierra la vieja, también entre dos robots.
 */
export class DeviceOps implements StockDeviceOps {
  private readonly logger = new Logger('StockDeviceOps');
  private readonly connections = new Map<string, Connection>();

  constructor(private readonly deps: DeviceOpsDeps) {
    deps.photos.onEvent = userId => this.connections.get(userId)?.pump();
    deps.notices.onEvent = userId => this.connections.get(userId)?.pump();
  }

  enabledFor(userId: string): boolean {
    return this.deps.settings.userIds.has(userId);
  }

  async captureUtterance(device: DeviceIdentity, text: string): Promise<void> {
    try {
      await this.deps.db.query('INSERT INTO assistant.stock_owner_utterances(id,user_id,device_id,text) VALUES ($1,$2,$3,$4)',
        [randomUUID(), device.userId, device.deviceId, text.slice(0, 2000)]);
    } catch (error) {
      this.logger.warn(`frase sin guardar: ${(error as Error).name}`);
    }
  }

  async handle(device: DeviceIdentity, body: unknown, response: Response): Promise<void> {
    const raw = (body as {op?: unknown}).op;
    if (typeof raw === 'string' && raw.startsWith('bench_') && !this.deps.settings.benchEnabled) throw invalidRequest();
    const op = DeviceOpV1.parse(body);
    if (op.op === 'events') return this.serve(device, op, response);
    response.status(200).setHeader('Cache-Control', 'no-store').json(await this.json(device, op));
  }

  private async json(device: DeviceIdentity, op: Exclude<DeviceOpV1, {op: 'events'}>): Promise<unknown> {
    const {photos} = this.deps;
    switch (op.op) {
      case 'photo_url': return photos.photoUrl(device.userId, op);
      case 'photo_done': await photos.done(device.userId, op); return {ok: true};
      case 'photo_failed': await photos.failed(device.userId, op); return {ok: true};
      case 'event_ack': await this.ack(device.userId, op); return {ok: true};
      case 'state': await this.state(device, op); return {ok: true};
      case 'bench_clock': return this.benchClock(device, op);
      case 'bench_seed': return this.benchSeed(device, op);
      case 'bench_campaign': return this.benchCampaign(device, op);
      case 'bench_state': return this.benchState(device, op);
      case 'bench_tick': return this.benchTick(device, op);
      case 'bench_supplier_reply': return this.benchSupplierReply(device, op);
      case 'bench_close': return this.benchClose(device, op);
    }
  }

  // ---- Eventos ------------------------------------------------------------------------------------------------

  private presence(device: DeviceIdentity, state: 'activo' | 'dormido') {
    return this.deps.db.query(
      `INSERT INTO assistant.stock_device_presence(device_id,user_id,device_state,events_seen_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (device_id) DO UPDATE SET device_state = $3, events_seen_at = $4`, [device.deviceId, device.userId, state, this.deps.now()]);
  }

  /** Cambiar de estado no prueba que el hilo de eventos viva: sin fila previa nace vencida. */
  private async state(device: DeviceIdentity, op: Op<'state'>): Promise<void> {
    await this.deps.db.query(
      `INSERT INTO assistant.stock_device_presence(device_id,user_id,device_state,events_seen_at) VALUES ($1,$2,$3,'epoch')
       ON CONFLICT (device_id) DO UPDATE SET device_state = $3`, [device.deviceId, device.userId, op.device_state]);
    this.connections.get(device.userId)?.pump();          // al despertar salen los avisos retenidos
  }

  /** El latido solo renueva la hora: `op.device_state` es de cuando conectó, y pisaría un `state` posterior. */
  private renew(device: DeviceIdentity) {
    return this.deps.db.query('UPDATE assistant.stock_device_presence SET events_seen_at = $2 WHERE device_id = $1', [device.deviceId, this.deps.now()]);
  }

  private async ack(userId: string, op: Op<'event_ack'>): Promise<void> {
    const {rows} = await this.deps.db.query<{status: string}>('SELECT status FROM assistant.stock_robot_events WHERE id = $1 AND user_id = $2', [op.event_id, userId]);
    if (!rows[0]) throw notFound();
    await this.deps.db.query(
      `UPDATE assistant.stock_robot_events SET status = $3, acked_at = COALESCE(acked_at, $4)
        WHERE id = $1 AND user_id = $2 AND status IN ('pendiente','entregado','recibido')`, [op.event_id, userId, op.estado === 'vencido' ? 'para_canal' : op.estado, this.deps.now()]);
  }

  /** Lo pendiente, y una sola reentrega de lo `foto` sin ack. El evento conserva su `id`: el robot deduplica. */
  private async due(userId: string, after: number, first: boolean): Promise<EventRow[]> {
    const {db, now} = this.deps;
    const horizon = new Date(now().getTime() - STOCK_LIMITS.eventRedeliverSeconds * 1000);
    const {rows: fresh} = await db.query<EventRow>(
      `UPDATE assistant.stock_robot_events SET status='entregado', delivered_at=$3
        WHERE id IN (SELECT id FROM assistant.stock_robot_events
                      WHERE user_id=$1 AND id>$2 AND kind<>'decir' AND (status='pendiente' OR ($4 AND status='entregado')) AND (expires_at IS NULL OR expires_at > $3))
        RETURNING id, kind, payload`, [userId, after, now(), first]);
    const {rows: again} = await db.query<EventRow>(
      `UPDATE assistant.stock_robot_events SET payload = payload || '{"reentrega":true}'::jsonb
        WHERE user_id=$1 AND kind='foto' AND status='entregado' AND delivered_at <= $2 AND NOT payload ? 'reentrega' AND (expires_at IS NULL OR expires_at > $3)
        RETURNING id, kind, payload`, [userId, horizon, now()]);
    return [...fresh, ...again.filter(event => !fresh.some(row => Number(row.id) === Number(event.id)))].sort((a, b) => Number(a.id) - Number(b.id));
  }

  /** Contrapresión propia: `pipeTurn` valida `StreamEventV1`. La presencia solo se renueva con un keepalive que salió. */
  private async serve(device: DeviceIdentity, op: Op<'events'>, response: Response): Promise<void> {
    const {heartbeatMs, photos, notices} = this.deps;
    const userId = device.userId;
    this.deps.kick?.(userId);
    const spoken = new Set<number>();
    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-store, no-transform');
    response.setHeader('X-Accel-Buffering', 'no');
    response.setHeader('Connection', 'keep-alive');
    response.flushHeaders();
    response.socket?.setNoDelay(true);

    const write = (chunk: string) => new Promise<boolean>(resolve => {
      if (response.writableEnded || response.destroyed) return resolve(false);
      response.write(chunk, error => resolve(!error));
    });
    let running = false;
    let queued = false;
    let first = true;
    const pump = () => {
      if (running) {queued = true; return;}
      running = true;
      void (async () => {
        do {
          queued = false;
          const events = [...await this.due(userId, op.after, first), ...await notices.due(userId, device.deviceId, op.after, spoken)];
          for (const event of events.sort((a, b) => Number(a.id) - Number(b.id))) {
            first = false;
            if (event.kind === 'foto' && 'solicitud_id' in event.payload && event.payload.solicitud_id) await photos.delivered(event.payload.solicitud_id, device.deviceId);
            if (!await write(frame(event))) break;
          }
          first = false;
        } while (queued && !response.writableEnded);
      })().catch(error => this.logger.warn(`eventos sin entregar: ${(error as Error).name}`)).finally(() => {running = false;});
    };
    const beat = () => {
      void write(KEEPALIVE).then(sent => sent ? this.renew(device) : undefined)
        .then(() => photos.sweep()).then(pump).catch(error => this.logger.warn(`latido fallido: ${(error as Error).name}`));
    };

    const connection: Connection = {pump, end: () => {if (!response.writableEnded) response.end();}};
    this.connections.get(userId)?.end();
    this.connections.set(userId, connection);
    const closed = new Promise<void>(resolve => response.once('close', resolve));
    await this.presence(device, op.device_state);
    await photos.sweep();
    pump();
    const timer = setInterval(beat, heartbeatMs);
    timer.unref();
    await closed;
    clearInterval(timer);
    if (this.connections.get(userId) === connection) this.connections.delete(userId);
  }

  // ---- Banco: solo con `STOCK_BENCH_ENABLED` y usuario en `STOCK_USER_IDS` --------------------------------------------

  private async run(userId: string, runId: string): Promise<{id: string; business_id: string}> {
    const {rows} = await this.deps.db.query<{id: string; business_id: string}>(
      `SELECT r.id, r.business_id FROM assistant.stock_runs r JOIN assistant.stock_enabled_businesses e ON e.business_id = r.business_id
        WHERE r.id = $1 AND e.user_id = $2 AND r.status = 'activo'`, [runId, userId]);
    if (!rows[0]) throw conflict();
    return rows[0];
  }

  private async benchClock(device: DeviceIdentity, op: Op<'bench_clock'>) {
    const {clock, db, now} = this.deps;
    const run = await this.run(device.userId, op.run_id);
    const from = await clock.at(run.business_id);
    await db.tx(async tx => {
      await tx.query(
        `INSERT INTO assistant.stock_clock_offsets(business_id,offset_seconds,updated_by) VALUES ($1,$2,'banco')
         ON CONFLICT (business_id) DO UPDATE SET offset_seconds = $2, updated_by = 'banco', updated_at = now()`, [run.business_id, op.offset_seconds]);
      await tx.query('INSERT INTO assistant.stock_clock_jumps(id,business_id,from_ts,to_ts,run_id,actor) VALUES ($1,$2,$3,$4,$5,$6)',
        [randomUUID(), run.business_id, from, new Date(now().getTime() + op.offset_seconds * 1000), run.id, device.deviceId]);
    });
    return {ok: true, ahora: (await clock.at(run.business_id)).toISOString()};
  }

  /**
   * Pasa por las reglas reales: `aplicar` crea y confirma con método `semilla`, nunca toca el libro por fuera.
   * IVB-024 (P8): el lote es atómico. Una venta que daba `STOCK_NEGATIVE` dejaba aplicada la venta anterior del mismo
   * lote y su propia propuesta pendiente en «Por aprobar». Ahora corrida, presupuestos, proveedores y propuestas van en
   * una transacción: si algo falla, el lote no deja nada y el error sale tal cual.
   */
  private async benchSeed(device: DeviceIdentity, op: Op<'bench_seed'>) {
    const {access} = this.deps;
    const {userId} = device;
    const seed = op.semilla;
    await access.assertBusiness(userId, seed.negocio_id);
    return this.deps.atomicProposals(async proposals => {
      const q = proposals.queries();
      await q.query(`INSERT INTO assistant.stock_runs(id,business_id,name,seed,status) VALUES ($1,$2,$3,$4,'activo') ON CONFLICT (id) DO NOTHING`,
        [op.run_id, seed.negocio_id, seed.nombre, seed.semilla]);
      const {rows} = await q.query<{id: string; business_id: string}>(
        `SELECT r.id, r.business_id FROM assistant.stock_runs r JOIN assistant.stock_enabled_businesses e ON e.business_id = r.business_id
          WHERE r.id = $1 AND e.user_id = $2 AND r.status = 'activo'`, [op.run_id, userId]);
      const run = rows[0];
      if (!run || run.business_id !== seed.negocio_id) throw conflict();
      for (const [metric, limit] of Object.entries(seed.presupuestos)) {
        await q.query(`INSERT INTO assistant.stock_run_budgets(run_id,metric,limit_value) VALUES ($1,$2,$3) ON CONFLICT (run_id, metric) DO NOTHING`, [run.id, metric, limit]);
      }
      for (const supplier of seed.proveedores) {
        const inserted = await q.query(
          `INSERT INTO assistant.stock_suppliers(id,business_id,user_id,name,lead_time_days,occurred_at,simulated,run_id) VALUES ($1,$2,$3,$4,$5,$6,true,$7) ON CONFLICT (id) DO NOTHING RETURNING id`,
          [supplier.id, run.business_id, userId, supplier.nombre, supplier.dias_entrega, await proposals.businessNow(run.business_id), run.id]);
        if (!inserted.rows.length) continue;
        for (const quote of supplier.cotizaciones) {
          await q.query(
            `INSERT INTO assistant.stock_supplier_quotes(id,supplier_id,variant_id,price,freight,min_qty,payment_term_days,warranty,equivalent_proof,currency) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [randomUUID(), supplier.id, quote.variante_id, quote.precio, quote.flete, quote.minimo, quote.plazo_pago_dias, quote.garantia, quote.prueba_equivalencia && JSON.stringify(quote.prueba_equivalencia), quote.moneda]);
        }
      }
      for (const cost of seed.costos) {
        const {rowCount} = await q.query(
          `UPDATE assistant.stock_variants v SET unit_cost = $2 FROM assistant.stock_products p
            WHERE v.id = $1 AND p.id = v.product_id AND p.business_id = $3 AND p.run_id = $4 AND v.currency = $5`,
          [cost.variante_id, cost.costo_unitario, run.business_id, run.id, cost.moneda]);
        if (!rowCount) throw conflict();
      }
      const create = ({causa: _causa, ...item}: (typeof seed.aplicar)[number]) => proposals.create(userId, run.business_id, 'banco', item);
      let aplicadas = 0;
      for (const item of seed.aplicar) {
        const created = await create(item);
        if (created.estado !== 'creada' || created.propuesta.estado !== 'pendiente') continue;
        await proposals.confirmSeed(run.business_id, created.propuesta.id, created.propuesta.revision, run.id, item.causa);
        aplicadas += 1;
      }
      let pendientes = 0;
      for (const item of seed.propuestas) {
        if ((await create(item)).estado === 'creada') pendientes += 1;
      }
      return {ok: true, lote: op.lote, ultimo: op.ultimo, aplicadas, pendientes};
    });
  }

  private async benchCampaign(device: DeviceIdentity, op: Op<'bench_campaign'>) {
    const {db} = this.deps;
    const run = await this.run(device.userId, op.run_id);
    const {rows} = await db.query<{payload: {variante_id: string; presupuesto_diario: string}}>(
      `SELECT payload FROM assistant.stock_proposals WHERE id = $1 AND business_id = $2 AND run_id = $3 AND kind = 'apuesta' AND status = 'aprobada'`, [op.proposal_id, run.business_id, run.id]);
    if (!rows[0]) throw conflict();
    const id = randomUUID();
    await db.query(`INSERT INTO assistant.stock_sim_campaigns(id,business_id,variant_id,budget,signals,status,run_id) VALUES ($1,$2,$3,$4,$5,'activa',$6)`,
      [id, run.business_id, rows[0].payload.variante_id, rows[0].payload.presupuesto_diario, JSON.stringify(op.senales), run.id]);
    return {ok: true, campana_id: id, simulado: true};
  }

  private async benchState(device: DeviceIdentity, op: Op<'bench_state'>) {
    const {db, clock} = this.deps;
    const run = await this.run(device.userId, op.run_id);
    const {rows: proposals} = await db.query(`SELECT id, kind, status FROM assistant.stock_proposals WHERE business_id = $1 AND run_id = $2 ORDER BY recorded_at`, [run.business_id, run.id]);
    const {rows: variants} = await db.query(
      `SELECT v.id, v.name AS variante, p.name AS producto FROM assistant.stock_variants v JOIN assistant.stock_products p ON p.id = v.product_id
        WHERE p.business_id = $1 AND p.run_id = $2 ORDER BY p.name, v.name`, [run.business_id, run.id]);
    const {rows: moved} = await db.query<{n: number}>('SELECT count(*)::int AS n FROM assistant.stock_movements WHERE business_id = $1 AND run_id = $2', [run.business_id, run.id]);
    const chain = op.movement_id ? await traceMovement(db, op.movement_id, run.id) : null;
    return {ahora: (await clock.at(run.business_id)).toISOString(), movimientos: moved[0]?.n ?? 0, propuestas: proposals, variantes: variants,
      presupuestos: await this.deps.usage.runBudgets(db, run.id), ...(op.movement_id ? {trace: chain?.auditoria ?? [], cadena: chain} : {})};
  }

  private async benchTick(device: DeviceIdentity, op: Op<'bench_tick'>) {
    const run = await this.run(device.userId, op.run_id);
    return {status: this.deps.wake ? await this.deps.wake(device.userId, run.business_id, 'banco') : 'no_disponible'};
  }

  /**
   * Cierra la corrida: lectura y libro vuelven a `run_id IS NULL`, y el negocio queda libre para otra corrida (índice
   * único de activa). Nada se borra (R3). El reloj vuelve a la hora real, con su salto registrado: el desfase es por negocio
   * y no por corrida, y si quedara puesto, el uso real del negocio viviría en la fecha simulada.
   */
  private async benchClose(device: DeviceIdentity, op: Op<'bench_close'>) {
    const {clock, db, now} = this.deps;
    const run = await this.run(device.userId, op.run_id);
    const from = await clock.at(run.business_id);
    let avisos = 0;
    await db.tx(async tx => {
      const closed = await tx.query(`UPDATE assistant.stock_runs SET status = 'cerrado' WHERE id = $1 AND status = 'activo' RETURNING id`, [run.id]);
      if (!closed.rows.length) throw conflict();
      await tx.query(
        `INSERT INTO assistant.stock_clock_offsets(business_id,offset_seconds,updated_by) VALUES ($1,0,'banco')
         ON CONFLICT (business_id) DO UPDATE SET offset_seconds = 0, updated_by = 'banco', updated_at = now()`, [run.business_id]);
      await tx.query('INSERT INTO assistant.stock_clock_jumps(id,business_id,from_ts,to_ts,run_id,actor) VALUES ($1,$2,$3,$4,$5,$6)',
        [randomUUID(), run.business_id, from, now(), run.id, device.deviceId]);
      // Los avisos de la corrida que no alcanzó a decir el robot mueren con ella: si no, al despertar diría cifras de una
      // corrida cerrada en medio de la siguiente. Quedan como `descartado`, no se borran (R3).
      const discarded = await tx.query(
        `UPDATE assistant.stock_robot_events SET status = 'descartado'
          WHERE business_id = $1 AND kind = 'decir' AND status IN ('pendiente','entregado') AND dedupe_key LIKE $2`,
        [run.business_id, `%@corrida-${run.id}`]);
      return discarded.rowCount ?? 0;
    }).then(n => { avisos = n; });
    return {ok: true, run_id: run.id, estado: 'cerrado', avisos_descartados: avisos, ahora: (await clock.at(run.business_id)).toISOString()};
  }

  private async benchSupplierReply(device: DeviceIdentity, op: Op<'bench_supplier_reply'>) {
    await this.run(device.userId, op.run_id);
    if (!this.deps.supplierReply) throw serviceUnavailable();
    this.deps.supplierReply(op.texto);
    return {ok: true, simulado: true};
  }
}
