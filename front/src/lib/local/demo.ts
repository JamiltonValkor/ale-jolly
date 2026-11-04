import type { Business } from '@/types/business.types'

/**
 * Identidad fija del modo local (docs/CONTRATO-LOCAL.md, «Negocio y usuario de
 * demo»). El token lo emite saleads-sim; aquí solo viven los datos públicos.
 */
export const DEMO_USER = {
  id: process.env.NEXT_PUBLIC_DEMO_USER_ID || '00000000-0000-4000-a000-000000000001',
  name: process.env.NEXT_PUBLIC_DEMO_USER_NAME || 'Demo owner',
  email: 'demo-owner@saleads.local',
} as const

export const DEMO_BUSINESS: Business = {
  business_id:
    process.env.NEXT_PUBLIC_DEMO_BUSINESS_ID ||
    'a6b8e93d-386f-4141-96ff-4b49e137728a',
  business_name: process.env.NEXT_PUBLIC_DEMO_BUSINESS_NAME || 'Masquebella (demo)',
  offering_type: 'products',
  industry: null,
  completion_status: 'complete',
  created_at: '2026-11-04T00:00:00.000Z',
  is_selected: true,
  currency: 'COP',
  country: 'CO',
}
