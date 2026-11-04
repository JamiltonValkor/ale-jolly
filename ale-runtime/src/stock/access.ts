import {notFound} from '../domain/errors';
import type {StockSettings} from './config';
import type {StockQuery} from './store';

const OWNERSHIP_TTL_MS = 60_000;

export interface StockAccessDeps {db: StockQuery; settings: StockSettings; assertOwned(userId: string, businessId: string): Promise<void>; now?: () => number}

/**
 * Filtro común de toda ruta por negocio. Lo ajeno, lo inexistente y lo no habilitado responden igual, sin oráculo. Si
 * la propiedad no se puede determinar, `assertOwned` da 503, nunca 200. Solo se recuerda el resultado positivo, 60 s.
 */
export class StockAccess {
  private readonly owned = new Map<string, number>();

  constructor(private readonly deps: StockAccessDeps) {}

  async assertBusiness(userId: string, businessId: string): Promise<void> {
    if (!this.deps.settings.userIds.has(userId)) throw notFound();
    const {rows} = await this.deps.db.query('SELECT 1 FROM assistant.stock_enabled_businesses WHERE business_id = $1 AND user_id = $2', [businessId, userId]);
    if (!rows.length) throw notFound();
    const now = (this.deps.now ?? Date.now)();
    const cacheKey = `${userId}\n${businessId}`;
    if ((this.owned.get(cacheKey) ?? 0) > now) return;
    await this.deps.assertOwned(userId, businessId);
    this.owned.set(cacheKey, now + OWNERSHIP_TTL_MS);
  }
}
