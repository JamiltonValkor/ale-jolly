import { handleMetaOAuthCallback } from '@/features/sales-assistant/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = (request: Request) => handleMetaOAuthCallback(request)
