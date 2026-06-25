import { evaluateToolInjection } from "./web-stream-middleware"
import { shouldInjectToolPrompt } from "./web-tool-prompt"

export function buildWebPrompt(messages: unknown[], tools: unknown[], providerID: string) {
  const parts = messages.flatMap((message) => serializePromptMessage(message))
  const joined = parts.join("\n\n")
  if (!tools.length || !shouldInjectToolPrompt(providerID)) return joined

  const userText = getLastUserText(messages)
  const toolPrompt = userText ? evaluateToolInjection(userText, providerID, tools) : null
  return toolPrompt ? toolPrompt + "\n\n" + joined : joined
}

function serializePromptMessage(message: unknown) {
  if (!message || typeof message !== "object") return []
  const record = message as Record<string, unknown>

  if (record.role === "system") {
    const text = textFromContent(record.content)
    return text ? [text] : []
  }

  if (record.role === "assistant") {
    return serializeAssistantMessage(record)
  }

  if (record.role === "tool" || record.role === "toolResult") {
    return serializeToolMessage(record)
  }

  if (record.role === "user") {
    const text = textFromUserContent(record.content)
    return text ? [text] : []
  }

  return []
}

function serializeAssistantMessage(message: Record<string, unknown>) {
  const texts: string[] = []
  const calls: string[] = []
  const toolResults: string[] = []

  if (typeof message.content === "string" && message.content) {
    texts.push(message.content)
  }

  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (!part || typeof part !== "object") continue
      const record = part as Record<string, unknown>

      if (record.type === "text" && typeof record.text === "string") {
        texts.push(record.text)
        continue
      }

      if (record.type === "tool-call" && typeof record.toolName === "string") {
        calls.push(stringifyToolCall(record.toolName, record.input))
        continue
      }

      if (typeof record.type === "string" && record.type.startsWith("tool-")) {
        const toolResult = toolResultFromPart(record)
        if (toolResult) toolResults.push(toolResult)
      }
    }
  }

  if (Array.isArray(message.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      if (!toolCall || typeof toolCall !== "object") continue
      const record = toolCall as Record<string, unknown>
      const fn = record.function
      if (!fn || typeof fn !== "object") continue
      const tool = fn as Record<string, unknown>
      if (typeof tool.name !== "string") continue
      calls.push(stringifyToolCall(tool.name, tool.arguments))
    }
  }

  const result = [...toolResults]
  if (texts.length || calls.length) {
    result.push("Assistant:\n" + texts.join("") + (calls.length ? "\n" + calls.join("\n") : ""))
  }
  return result
}

function serializeToolMessage(message: Record<string, unknown>) {
  const toolName = typeof message.name === "string" && message.name ? message.name : "unknown"
  const resultText = toolResultText(message.content)
  return [serializeToolResult(toolName, resultText)]
}

function toolResultFromPart(part: Record<string, unknown>) {
  const state = part.state
  if (state !== "output-available" && state !== "output-error") return

  const result =
    state === "output-error"
      ? "[Error] " + (typeof part.errorText === "string" ? part.errorText : "")
      : stringifyUnknown(part.output)

  const toolName = typeof part.tool === "string" && part.tool ? part.tool : "unknown"
  return serializeToolResult(toolName, result)
}

function toolResultText(content: unknown) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return stringifyUnknown(content)

  const toolResult = content.find((part) => {
    if (!part || typeof part !== "object") return false
    return (part as Record<string, unknown>).type === "tool-result"
  })
  if (!toolResult || typeof toolResult !== "object") return stringifyUnknown(content)

  const record = toolResult as Record<string, unknown>
  if (typeof record.text === "string") return record.text
  return stringifyUnknown(content)
}

function textFromContent(content: unknown) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return []
      const record = part as Record<string, unknown>
      return record.type === "text" && typeof record.text === "string" ? [record.text] : []
    })
    .join("\n")
}

function textFromUserContent(content: unknown) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return []
      const record = part as Record<string, unknown>
      if (record.type === "text" && typeof record.text === "string") return [record.text]
      if (record.type !== "file") return []

      const filename = typeof record.filename === "string" && record.filename ? record.filename : "attachment"
      const mediaType = typeof record.mediaType === "string" && record.mediaType ? record.mediaType : "unknown"
      return [`[File: ${filename} (${mediaType})]`]
    })
    .join("\n")
}

function getLastUserText(messages: unknown[]) {
  const lastUser = [...messages].reverse().find((message) => {
    if (!message || typeof message !== "object") return false
    return (message as Record<string, unknown>).role === "user"
  })
  if (!lastUser || typeof lastUser !== "object") return ""
  return textFromContent((lastUser as Record<string, unknown>).content)
}

function stringifyToolCall(name: string, input: unknown) {
  const parameters = typeof input === "string" ? input : stringifyUnknown(input ?? {})
  return `\`\`\`tool_json\n{"tool":"${name}","parameters":${parameters}}\n\`\`\``
}

function serializeToolResult(toolName: string, result: string) {
  return `Tool ${toolName} returned: ${result}`
}

function stringifyUnknown(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value ?? "")
}
