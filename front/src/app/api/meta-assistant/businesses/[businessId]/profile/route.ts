import { metaAssistantRoutes } from '@/features/sales-assistant/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = metaAssistantRoutes.businessProfile.GET
export const PUT = metaAssistantRoutes.businessProfile.PUT
