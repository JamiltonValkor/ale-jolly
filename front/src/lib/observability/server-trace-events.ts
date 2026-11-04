import { isServerTraceCaptureEnabled } from './server-trace-config'
import type {
  ServerGatewayTraceInput,
  ServerTraceEventInput,
} from './server-trace-events.server'

export { isServerTraceCaptureEnabled } from './server-trace-config'
export type {
  ServerGatewayTraceInput,
  ServerTraceEventInput,
} from './server-trace-events.server'

/**
 * Caller-safe trace facade. Product code never waits for observability; the
 * server-only implementation is loaded only when capture is enabled.
 */
export function emitServerTraceEvent(input: ServerTraceEventInput): void {
  if (!isServerTraceCaptureEnabled()) return
  try {
    void import('./server-trace-events.server')
      .then(implementation => implementation.emitServerTraceEvent(input))
      .catch(() => {})
  } catch {
    // Dynamic import setup must never alter a product response.
  }
}

/** Gateway trace facade with the same lazy, non-blocking loading contract. */
export function emitServerGatewayTrace(input: ServerGatewayTraceInput): void {
  if (!isServerTraceCaptureEnabled()) return
  try {
    void import('./server-trace-events.server')
      .then(implementation => implementation.emitServerGatewayTrace(input))
      .catch(() => {})
  } catch {
    // Dynamic import setup must never alter a product response.
  }
}
