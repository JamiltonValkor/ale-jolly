import 'server-only'
import {
  ServerApiError,
  buildServerGatewayUrl,
} from '@/lib/fetch/server-gateway'
import { withTraceHeaders } from '@/shared/observability/trace-context'
import {
  assistantGatewayPath,
  upstreamFailure,
  type AssistantServicePath,
} from './assistant-service'
import { SALES_ASSISTANT_PRIVATE_HEADERS, bffError } from './bff-http'

/** Hasta recibir las cabeceras del SSE; el turno en sí no tiene tope aquí. */
const CONNECT_TIMEOUT_MS = 30_000

const SSE_HEADERS = {
  ...SALES_ASSISTANT_PRIVATE_HEADERS,
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  'X-Accel-Buffering': 'no',
}

/** Evento v1 de cierre cuando el servicio corta el stream a mitad del turno. */
const UPSTREAM_CUT_EVENT = new TextEncoder().encode(
  'event: error\ndata: {}\n\n'
)

interface StreamRelayInput {
  path: AssistantServicePath
  template: AssistantServicePath
  body: unknown
  accessToken: string
  signal: AbortSignal
}

/**
 * Copia chunk a chunk (sin acumular) el cuerpo del servicio. Si el navegador
 * cancela, se aborta el upstream; si el servicio corta, se cierra con `error`.
 */
function relayBody(
  body: ReadableStream<Uint8Array>,
  upstream: AbortController,
  release: () => void,
  browser: AbortSignal
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read()
        if (!chunk.done) return controller.enqueue(chunk.value)
      } catch {
        if (!browser.aborted) controller.enqueue(UPSTREAM_CUT_EVENT)
      }
      release()
      controller.close()
    },
    async cancel() {
      release()
      upstream.abort()
      await reader.cancel().catch(() => undefined)
    },
  })
}

async function errorFrom(response: Response): Promise<Response> {
  const data: unknown = await response.json().catch(() => null)
  return upstreamFailure(
    new ServerApiError(response.status, response.statusText, data)
  )
}

function streamHeaders(accessToken: string): Headers {
  const { headers } = withTraceHeaders(undefined)
  headers.set('authorization', `Bearer ${accessToken}`)
  headers.set('content-type', 'application/json')
  headers.set('accept', 'text/event-stream')
  return headers
}

/** Proxy del SSE del chat: navegador → BFF → gateway → servicio, en streaming. */
export async function relayAssistantStream(
  input: StreamRelayInput,
  endpoint = buildServerGatewayUrl(assistantGatewayPath(input.path))
): Promise<Response> {
  const upstream = new AbortController()
  const abort = () => upstream.abort()
  const release = () => input.signal.removeEventListener('abort', abort)
  input.signal.addEventListener('abort', abort, { once: true })
  if (input.signal.aborted) upstream.abort()
  const timer = setTimeout(abort, CONNECT_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: streamHeaders(input.accessToken),
      body: JSON.stringify(input.body),
      signal: upstream.signal,
      cache: 'no-store',
      redirect: 'error',
    })
  } catch {
    release()
    return bffError(503, 'SERVICE_UNAVAILABLE')
  } finally {
    clearTimeout(timer)
  }
  const isSse = response.headers
    .get('content-type')
    ?.startsWith('text/event-stream')
  if (response.ok && isSse && response.body) {
    return new Response(
      relayBody(response.body, upstream, release, input.signal),
      {
        status: 200,
        headers: SSE_HEADERS,
      }
    )
  }
  release()
  if (!response.ok) return errorFrom(response)
  upstream.abort()
  return bffError(503, 'SERVICE_UNAVAILABLE')
}
