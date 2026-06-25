import { KimiWebClient } from "../clients/kimi-web-client.js"
import { extractGenericWebTexts } from "./generic-web-stream.js"

function normalizeText(text: string) {
  return text.replace(/\r/g, "").trim()
}

function nextDeltaText(previous: string, current: string) {
  const normalized = normalizeText(current)
  if (!normalized) {
    return { delta: "", state: previous }
  }
  if (!previous) {
    return { delta: normalized, state: normalized }
  }
  if (normalized === previous) {
    return { delta: "", state: previous }
  }
  if (normalized.startsWith(previous)) {
    return {
      delta: normalized.slice(previous.length),
      state: normalized,
    }
  }
  return {
    delta: normalized,
    state: previous + normalized,
  }
}

export function createKimiWebStream(credentials: unknown) {
  const client = new KimiWebClient(credentials as ConstructorParameters<typeof KimiWebClient>[0])

  return async function* (params: { message: string; model?: string; signal?: AbortSignal }) {
    await client.init()
    const stream = await client.chatCompletions(params)
    yield* parseKimiConnectStream(stream)
  }
}

export async function* parseKimiConnectStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = new Uint8Array(0)
  let previous = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue

      const merged = new Uint8Array(buffer.length + value.length)
      merged.set(buffer)
      merged.set(value, buffer.length)
      buffer = merged

      while (buffer.length >= 5) {
        const size = new DataView(buffer.buffer, buffer.byteOffset + 1, 4).getUint32(0, false)
        if (buffer.length < size + 5) break

        const payload = buffer.slice(5, size + 5)
        buffer = buffer.slice(size + 5)

        try {
          const parsed = JSON.parse(decoder.decode(payload))
          for (const text of extractGenericWebTexts(parsed)) {
            const next = nextDeltaText(previous, text)
            previous = next.state
            if (next.delta) yield next.delta
          }
        } catch {}
      }
    }
  } finally {
    reader.releaseLock()
  }
}
