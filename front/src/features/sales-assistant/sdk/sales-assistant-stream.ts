import { SseParser, toStreamEvent } from '../lib/sse-parser'
import type { SalesAssistantStreamEvent } from '../types'
import {
  SalesAssistantClientError,
  salesAssistantFetch,
} from './sales-assistant-client'

const TERMINAL = new Set<SalesAssistantStreamEvent['type']>([
  'message_end',
  'provider_error',
  'error',
  'assistant_restarting',
])

/**
 * Turno del chat: `POST /api/sales-assistant/sessions/{id}/stream` con
 * fetch + ReadableStream (no EventSource). Produce los eventos v1 en orden.
 * Abortar `signal` (p. ej. al desmontar) corta el fetch y, en el BFF, el
 * upstream. Si el stream se cierra sin evento final, produce `error`.
 */
export async function* streamSalesAssistantTurn(
  sessionId: string,
  text: string,
  signal: AbortSignal,
  transport = salesAssistantFetch
): AsyncGenerator<SalesAssistantStreamEvent> {
  const response = await transport(
    `/sessions/${encodeURIComponent(sessionId)}/stream`,
    {
      method: 'POST',
      body: JSON.stringify({ text }),
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      signal,
    }
  )
  if (!response.body) throw new SalesAssistantClientError('INVALID_RESPONSE')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const parser = new SseParser()
  let finished = false
  try {
    while (!finished) {
      const chunk = await reader.read()
      if (chunk.done) break
      for (const frame of parser.push(
        decoder.decode(chunk.value, { stream: true })
      )) {
        const event = toStreamEvent(frame)
        if (!event) continue
        finished = TERMINAL.has(event.type)
        yield event
        if (finished) break
      }
    }
    if (!finished) yield { type: 'error' }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}
