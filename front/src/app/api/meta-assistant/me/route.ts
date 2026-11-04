import { metaAssistantRoutes } from '@/features/sales-assistant/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = metaAssistantRoutes.me.GET
export const DELETE = metaAssistantRoutes.me.DELETE
