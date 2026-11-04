import {
  salesAssistantStreamEventSchema,
  type SalesAssistantStreamEvent,
} from '../types'

export interface SseFrame {
  event: string | null
  data: string
}

const KNOWN_EVENTS = new Set<string>(
  salesAssistantStreamEventSchema.options.map(option => option.shape.type.value)
)

/** Parser incremental de `text/event-stream` (solo `event:` y `data:`). */
export class SseParser {
  private buffer = ''

  push(text: string): SseFrame[] {
    this.buffer += text.replace(/\r\n?/g, '\n')
    const frames: SseFrame[] = []
    let end: number
    while ((end = this.buffer.indexOf('\n\n')) !== -1) {
      const frame = parseFrame(this.buffer.slice(0, end))
      this.buffer = this.buffer.slice(end + 2)
      if (frame) frames.push(frame)
    }
    return frames
  }
}

function parseFrame(block: string): SseFrame | null {
  let event: string | null = null
  const data: string[] = []
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
  }
  return event === null && data.length === 0
    ? null
    : { event, data: data.join('\n') }
}

function parseData(data: string): unknown {
  if (!data.trim()) return {}
  try {
    return JSON.parse(data)
  } catch {
    return null
  }
}

/**
 * Frame SSE → evento v1. `type` viaja en `event:` y el resto en `data:`.
 * Desconocido → `null` (se ignora); conocido pero roto → `{type:'error'}`.
 */
export function toStreamEvent(
  frame: SseFrame
): SalesAssistantStreamEvent | null {
  if (!frame.event || !KNOWN_EVENTS.has(frame.event)) return null
  const data = parseData(frame.data)
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return { type: 'error' }
  if ('type' in data && data.type !== frame.event) return { type: 'error' }
  const parsed = salesAssistantStreamEventSchema.safeParse({
    ...data,
    type: frame.event,
  })
  return parsed.success ? parsed.data : { type: 'error' }
}
