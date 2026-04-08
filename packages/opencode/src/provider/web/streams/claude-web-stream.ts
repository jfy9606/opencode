import { ClaudeWebClient } from "../clients/claude-web-client.js"
import type { WebAuthCredentials } from "../types.js"

export function createClaudeWebStream(credentials: WebAuthCredentials | string) {
  const client = new ClaudeWebClient(credentials)

  return async (params: { message: string; model?: string; signal?: AbortSignal }) => {
    await client.init()
    const body = await client.chatCompletions(params)
    return parseClaudeSSE(body)
  }
}

async function* parseClaudeSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        if (!line.startsWith("data: ") && !line.startsWith("event: ")) continue

        if (line.startsWith("event: completion")) continue
        if (line.startsWith("data: ")) {
          const data = line.slice(6).trim()
          if (!data || data === "[DONE]") continue

          try {
            const parsed = JSON.parse(data)
            if (parsed.completion) yield parsed.completion
            else if (parsed.delta?.text) yield parsed.delta.text
          } catch { /* skip */ }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
