import { autonomousTeamRoutes } from '@/features/autonomous-team/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = autonomousTeamRoutes.creditCap.GET
export const PUT = autonomousTeamRoutes.creditCap.PUT
