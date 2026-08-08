import { ChatGPTWebClient } from "../clients/chatgpt-web-client.js"
import type { WebAuthCredentials } from "../types.js"

export function createChatGPTWebStream(credentials: WebAuthCredentials) {
  const client = new ChatGPTWebClient(credentials)

  return async (params: { message: string; model?: string; signal?: AbortSignal }) => {
    await client.init()
    const body = await client.chatCompletions(params)
    return parseChatGPTSSE(body)
  }
}

async function* parseChatGPTSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
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
        if (!line.startsWith("data: ")) continue
        const data = line.slice(6).trim()
        if (!data || data === "[DONE]") continue

        try {
          const parsed = JSON.parse(data)
          const content = parsed.message?.content?.parts?.[0]
          if (typeof content === "string" && content) yield content
          if (parsed.message?.metadata?.finish_details?.type === "stop") return
        } catch { /* skip malformed */ }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
