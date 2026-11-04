/**
 * Usuario autenticado por el token web (cliente `front`).
 * `userId` es el `sub` de Keycloak: identifica la fila del asistente y es el
 * `distinct_id` de PostHog. Nunca se reenvía a Hermes ni al MCP.
 */
export interface Principal { readonly userId: string; readonly clientId: string }

/** Lectura de la bandera del asistente: `true`/`false`, o lanza si no hay respuesta booleana. */
export interface AssistantFlag { isEnabled(userId: string): Promise<boolean> }
