type StreamableClient = {
  init(): Promise<void>
  chatCompletions(params: {
    message: string
    model?: string
    signal?: AbortSignal
  }): Promise<ReadableStream<Uint8Array>>
}

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

function pushText(result: string[], seen: Set<string>, value: unknown) {
  if (typeof value !== "string") return
  const normalized = normalizeText(value)
  if (!normalized || seen.has(normalized)) return
  seen.add(normalized)
  result.push(normalized)
}

export function extractGenericWebTexts(value: unknown): string[] {
  if (!value || typeof value !== "object") return []

  const result: string[] = []
  const seen = new Set<string>()
  const record = value as Record<string, any>

  pushText(result, seen, record.text)
  pushText(result, seen, record.completion)
  pushText(result, seen, record.answer)
  pushText(result, seen, record.response)
  pushText(result, seen, record.content)
  pushText(result, seen, record.delta?.text)
  pushText(result, seen, record.delta?.content)
  pushText(result, seen, record.message?.content?.parts?.[0])
  pushText(result, seen, record.message?.content)
  pushText(result, seen, record.choices?.[0]?.delta?.content)
  pushText(result, seen, record.choices?.[0]?.message?.content)

  if (Array.isArray(record.content)) {
    for (const item of record.content) {
      if (typeof item === "string") pushText(result, seen, item)
      if (item && typeof item === "object") {
        const part = item as Record<string, unknown>
        pushText(result, seen, part.text)
        pushText(result, seen, part.content)
      }
    }
  }

  return result
}

export async function* parseGenericWebSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let previous = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith("event:")) continue

        const payload = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed
        if (!payload || payload === "[DONE]") continue

        try {
          const parsed = JSON.parse(payload)
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

export function createGenericWebStream<C extends StreamableClient>(
  createClient: (credentials: unknown) => C,
) {
  return function (credentials: unknown) {
    const client = createClient(credentials)

    return async function* (params: { message: string; model?: string; signal?: AbortSignal }) {
      await client.init()
      const body = await client.chatCompletions(params)
      yield* parseGenericWebSSE(body)
    }
  }
}
