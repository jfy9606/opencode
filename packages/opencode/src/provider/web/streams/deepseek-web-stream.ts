import { DeepSeekWebClient } from "../clients/deepseek-web-client.js"
import type { WebAuthCredentials } from "../types.js"

const sessionMap = new Map<string, string>()
const parentMap = new Map<string, string | number>()

export function createDeepSeekWebStream(credentials: WebAuthCredentials) {
  const client = new DeepSeekWebClient(credentials)

  return async function*(params: { message: string; model?: string; signal?: AbortSignal }) {
    await client.init()
    const sessionKey = params.model || "default"
    let sessionId = sessionMap.get(sessionKey)
    let parentId = parentMap.get(sessionKey)

    if (!sessionId) {
      const session = await client.createChatSession()
      sessionId = session.chat_session_id
      sessionMap.set(sessionKey, sessionId)
      parentId = undefined
    }

    const body = await client.chatCompletions({
      sessionId,
      parentMessageId: parentId,
      message: params.message,
      model: params.model,
      signal: params.signal,
    })

    const result = parseDeepSeekSSE(body)
    for await (const event of result) {
      if (event.type === "id" && typeof event.id !== "undefined") {
        parentMap.set(sessionKey, event.id)
      }
      if (event.type === "text") yield event.text
    }
  }
}

type DeepSeekEvent =
  | { type: "id"; id: string | number }
  | { type: "text"; text: string }

async function* parseDeepSeekSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<DeepSeekEvent> {
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
          if (parsed.response_message_id) yield { type: "id", id: parsed.response_message_id }

          if (
            (parsed.p?.includes("reasoning") || parsed.type === "thinking") &&
            typeof parsed.v === "string"
          ) continue

          let text = ""
          if (typeof parsed.v === "string" && (!parsed.p || parsed.p.includes("content"))) text = parsed.v
          else if (parsed.type === "text" && typeof parsed.content === "string") text = parsed.content
          else if (parsed.choices?.[0]?.delta?.content) text = parsed.choices[0].delta.content

          if (text) yield { type: "text", text }
        } catch { /* skip */ }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
