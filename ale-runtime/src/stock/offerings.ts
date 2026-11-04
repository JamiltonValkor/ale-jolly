import {serviceUnavailable} from '../domain/errors';
import type {McpToolClient} from '../orqa/mcp-client';

export interface OfferingRef {type: 'product' | 'service'; id: string}
export interface Offering extends OfferingRef {name: string; price?: number | null; currency?: string | null}

/** R1: la oferta se lee y se liga como dato. Stock nunca la cambia. */
export interface OfferingsReader {find(userId: string, businessId: string, ref: OfferingRef): Promise<Offering | null>}

export interface OfferingsReaderDeps {mcp: McpToolClient; accessToken(userId: string): Promise<string | null>; timeoutMs: number}

const MAX_PAGES = 100;

/** Recorre `next_cursor`: sin paginar, una oferta de la página 2 daría un falso «inexistente». */
export function mcpOfferingsReader(deps: OfferingsReaderDeps): OfferingsReader {
  return {
    async find(userId, businessId, ref) {
      const token = await deps.accessToken(userId);
      if (!token) throw serviceUnavailable();
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = await deps.mcp.call(token, 'saleads_list_offerings', {business_id: businessId, ...(cursor ? {cursor} : {})}, deps.timeoutMs);
        if (!result.ok || !Array.isArray(result.data.offerings)) throw serviceUnavailable();
        for (const item of result.data.offerings as Array<{type?: unknown; id?: unknown; name?: unknown; price?: unknown; currency?: unknown}>) {
          if (item.id === ref.id && item.type === ref.type) return {...ref, name: typeof item.name === 'string' ? item.name : '', price: typeof item.price === 'number' ? item.price : null,
            currency: typeof item.currency === 'string' ? item.currency : null};
        }
        const next = result.data.next_cursor;
        if (typeof next !== 'string' || !next) return null;
        cursor = next;
      }
      throw serviceUnavailable();
    },
  };
}
