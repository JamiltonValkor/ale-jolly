/**
 * Cliente HTTP saliente único del servicio (Keycloak, PostHog, Compute, Hermes).
 * Siempre manda un `User-Agent` explícito: Cloudflare bloquea con 403 el UA por
 * defecto (hallazgo G-01 de la prueba real OCB-002). Aplica un timeout por
 * llamada. No registra URLs con query, cuerpos ni cabeceras.
 */
export interface OutboundOptions { userAgent: string; timeoutMs: number }

export type OutboundFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export function outboundFetch(options: OutboundOptions, base: typeof fetch = fetch): OutboundFetch {
  return async (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('user-agent', options.userAgent);
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return base(input, {...init, headers, signal});
  };
}

/** Cabeceras para librerías que hacen su propio fetch (p. ej. el JWKS de jose). */
export function outboundHeaders(options: OutboundOptions): Record<string, string> {
  return {'user-agent': options.userAgent};
}
