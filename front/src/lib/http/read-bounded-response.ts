/** Read a response with a hard byte limit, including chunked/misreported bodies. */
export async function readBoundedResponse(
  response: Response,
  maxBytes: number
): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  let size = 0
  const chunks: Uint8Array[] = []
  try {
    if (Number(response.headers.get('content-length')) > maxBytes)
      throw new Error('RESPONSE_TOO_LARGE')
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) throw new Error('RESPONSE_TOO_LARGE')
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
}
