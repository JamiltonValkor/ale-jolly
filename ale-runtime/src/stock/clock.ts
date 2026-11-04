import type {StockQuery} from './store';

/** Reloj por negocio: `occurred_at` se puede simular. `recorded_at` nunca pasa por aquí: es `now()` de la base. */
export class StockClock {
  constructor(private readonly db: StockQuery, private readonly now: () => Date = () => new Date()) {}

  /** Dentro de una transacción se pasa su `tx`: pedir otra conexión con el pool lleno bloquearía el libro. */
  async at(businessId: string, q: StockQuery = this.db): Promise<Date> {
    const {rows} = await q.query<{offset_seconds: string | number}>(
      'SELECT offset_seconds FROM assistant.stock_clock_offsets WHERE business_id = $1', [businessId]);
    return new Date(this.now().getTime() + Number(rows[0]?.offset_seconds ?? 0) * 1000);
  }
}
