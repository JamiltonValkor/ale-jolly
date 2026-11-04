import 'server-only'

// Movido a `shared/` (ola saleads-api-agencial-v1) para que el BFF del equipo autónomo lo reuse.
export { readJsonBody } from '@/shared/lib/bff/request-body'
