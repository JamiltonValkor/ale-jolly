import { metaAssistantRoutes } from '@/features/sales-assistant/server'
import { withLocalOAuthInternal } from '@/lib/local/local-oauth-internal'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Modo local (cambio 4): con LOCAL_OAUTH_INTERNAL=true el BFF resuelve el
// acceso OAuth dentro de la red; sin la variable es la ruta de SaleADS.
export const POST = withLocalOAuthInternal(metaAssistantRoutes.activation.POST)
