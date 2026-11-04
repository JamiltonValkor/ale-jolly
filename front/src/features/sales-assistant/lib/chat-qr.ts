/**
 * Bloques `whatsapp-qr` en las respuestas de Ale (vincular WhatsApp por QR, skill
 * saleads-connect-channel). Solo se aceptan códigos de vinculación de WhatsApp: el
 * chat nunca dibuja un QR arbitrario que el agente pudiera inventar.
 */
export type ChatSegment =
  | { kind: 'text'; text: string }
  | { kind: 'whatsapp-qr'; payload: string }

const BLOCK = /```whatsapp-qr[ \t]*\r?\n([^\n`]+)\r?\n```/g
const WHATSAPP_LINK =
  /^https:\/\/wa\.me\/settings\/linked_devices#[A-Za-z0-9@,+/=._:-]{10,1000}$/

export function isWhatsAppLinkPayload(value: string): boolean {
  return WHATSAPP_LINK.test(value)
}

export function splitChatQr(text: string): ChatSegment[] {
  const segments: ChatSegment[] = []
  let last = 0
  for (const match of text.matchAll(BLOCK)) {
    const payload = match[1]!.trim()
    if (!isWhatsAppLinkPayload(payload)) continue
    const before = text.slice(last, match.index)
    if (before.trim())
      segments.push({ kind: 'text', text: before.replace(/\n+$/, '') })
    segments.push({ kind: 'whatsapp-qr', payload })
    last = match.index! + match[0].length
  }
  const rest = text.slice(last)
  if (rest.trim() || !segments.length)
    segments.push({ kind: 'text', text: rest.replace(/^\n+/, '') })
  return segments
}
