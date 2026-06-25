import { DoubaoWebClient } from "../clients/doubao-web-client.js"
import { XiaomiMimoWebClient } from "../clients/xiaomimo-web-client.js"

export type ParsedProviderChunk = {
  text?: string
  thinking?: string
  messageID?: string | number
}

async function* iterateSSEPayloads(stream: ReadableStream<Uint8Array>) {
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
        if (!line.startsWith("data:")) continue
        const data = line.slice(line.indexOf(":") + 1).trim()
        if (!data || data === "[DONE]") continue

        try {
          yield JSON.parse(data)
        } catch {}
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export function createDoubaoWebStream(credentials: unknown) {
  const client = new DoubaoWebClient(credentials as ConstructorParameters<typeof DoubaoWebClient>[0])

  return async function* (params: { message: string; model?: string; signal?: AbortSignal }) {
    await client.init()
    const stream = await client.chatCompletions(params)
    for await (const chunk of parseDoubaoProviderSSE(stream)) {
      if (chunk.text) yield chunk.text
    }
  }
}

export function createXiaomiMimoWebStream(credentials: unknown) {
  const client = new XiaomiMimoWebClient(credentials as ConstructorParameters<typeof XiaomiMimoWebClient>[0])

  return async function* (params: { message: string; model?: string; signal?: AbortSignal }) {
    await client.init()
    const stream = await client.chatCompletions(params)
    for await (const chunk of parseXiaomiMimoProviderSSE(stream)) {
      if (chunk.text) yield chunk.text
    }
  }
}

export async function* parseDeepSeekProviderSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<ParsedProviderChunk> {
  for await (const parsed of iterateSSEPayloads(stream)) {
    if (parsed.response_message_id) {
      yield { messageID: parsed.response_message_id }
    }
    if ((parsed.p?.includes("reasoning") || parsed.type === "thinking") && typeof parsed.v === "string") {
      yield { thinking: parsed.v }
      continue
    }
    if (parsed.type === "thinking" && typeof parsed.content === "string") {
      yield { thinking: parsed.content }
      continue
    }
    if (typeof parsed.v === "string" && (!parsed.p || parsed.p.includes("content") || parsed.p.includes("choices"))) {
      yield { text: parsed.v }
      continue
    }
    if (parsed.type === "text" && typeof parsed.content === "string") {
      yield { text: parsed.content }
      continue
    }
    if (Array.isArray(parsed.v)) {
      for (const frag of parsed.v) {
        if (frag.type === "THINKING" || frag.type === "reasoning") yield { thinking: frag.content || "" }
        else if (frag.content) yield { text: frag.content }
      }
      continue
    }
    if (parsed.choices?.[0]?.delta?.reasoning_content) yield { thinking: parsed.choices[0].delta.reasoning_content }
    if (parsed.choices?.[0]?.delta?.content) yield { text: parsed.choices[0].delta.content }
  }
}

export async function* parseDoubaoProviderSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<ParsedProviderChunk> {
  for await (const parsed of iterateSSEPayloads(stream)) {
    let delta = ""
    if (parsed.event_data) {
      let eventData = parsed.event_data
      if (typeof eventData === "string") {
        try {
          eventData = JSON.parse(eventData)
        } catch {
          eventData = {}
        }
      }
      if (parsed.event_type === 2001) {
        const msgContent = eventData?.message?.content
        if (typeof msgContent === "string") {
          try {
            const contentObj = JSON.parse(msgContent)
            delta = typeof contentObj.text === "string" ? contentObj.text : ""
          } catch {
            delta = msgContent
          }
        }
      }
      if (parsed.event_type === 2003) {
        delta = eventData.text || eventData.content || eventData.delta || ""
      }
    }
    if (!delta) delta = parsed.choices?.[0]?.delta?.content ?? parsed.v ?? parsed.text ?? parsed.content ?? parsed.delta ?? ""
    if (!delta) continue
    if (parsed.p?.includes("reasoning")) yield { thinking: delta }
    else yield { text: delta }
  }
}

export async function* parseXiaomiMimoProviderSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<ParsedProviderChunk> {
  let accumulated = ""
  let insideThink = false

  for await (const parsed of iterateSSEPayloads(stream)) {
    if (typeof parsed.content === "string") {
      let content = parsed.content.replace(/\x00/g, "")
      if (content.includes("<think")) insideThink = true
      if (insideThink) {
        const thinkEnd = content.indexOf("</think")
        if (thinkEnd === -1) continue
        content = content.slice(thinkEnd + 8)
        insideThink = false
      }
      if (typeof content === "string" && content) {
        if (content.length <= accumulated.length) continue
        const newDelta = content.startsWith(accumulated) ? content.slice(accumulated.length) : content
        accumulated = content.startsWith(accumulated) ? content : accumulated + content
        if (newDelta) yield { text: newDelta }
      }
      continue
    }

    const delta = parsed.choices?.[0]?.delta?.content ?? parsed.text ?? parsed.delta
    if (typeof delta !== "string" || !delta) continue
    if (delta.length <= accumulated.length) continue
    const newDelta = delta.slice(accumulated.length)
    accumulated = delta
    if (newDelta) yield { text: newDelta }
  }
}
