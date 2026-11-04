import type { BusinessListResponse } from '@/types/business.types'
import { DEMO_BUSINESS } from '@/lib/local/demo'

/** Stub del modo local: la cuenta demo tiene un único negocio, ya elegido. */
export const businessApi = {
  async listBusinesses(): Promise<BusinessListResponse> {
    return {
      businesses: [DEMO_BUSINESS],
      selected_business_id: DEMO_BUSINESS.business_id,
      quota: {
        tier: 'pro',
        max_businesses: 1,
        current_count: 1,
        remaining: 0,
        can_create_more: false,
      },
    } as BusinessListResponse
  },
}
