import type {RenewalOutcome, RevokeOutcome} from '../renewal/credential-renewal';

/**
 * Lo que el ciclo de vida (OCB-012) necesita de la credencial del asistente.
 * Lo implementa `CredentialRenewal` de OCB-009 (src/renewal):
 *
 * - `revokeStoredCredential`: RFC 7009 con el refresh guardado (endpoint
 *   interno de Keycloak). Cierra la sesión offline del cliente del asistente;
 *   la sesión web sigue viva. Nunca lanza: `revoked`, `no_credential` o
 *   `failed{reason}`, y registra sus propios eventos `credential.revoked` /
 *   `credential.revoke_failed`.
 * - `renewBeforeStart`: refresca y resiembra `hermes-mcp-tokens` antes de
 *   `instances.start`. No bloquea el encendido.
 */
export interface LifecycleCredentials {
  revokeStoredCredential(userId: string): Promise<RevokeOutcome>;
  renewBeforeStart(userId: string): Promise<RenewalOutcome>;
}
