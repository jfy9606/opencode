import { extractToolCall, type ParsedToolCall } from "./web-tool-parser"

export function resolveToolCallOutput(text: string, canUseTools: boolean) {
  if (!canUseTools) return null
  return extractToolCall(text)
}

export function createTextDeltaChunk(id: string, text: string) {
  return {
    id,
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  }
}

export function createToolCallStartChunk(
  id: string,
  toolIndex: number,
  toolName: string,
  toolCallID: string,
) {
  return {
    id,
    choices: [{
      index: 0,
      delta: {
        role: "assistant",
        tool_calls: [{
          index: toolIndex,
          id: toolCallID,
          type: "function",
          function: { name: toolName, arguments: "" },
        }],
      },
      finish_reason: null,
    }],
  }
}

export function createToolCallArgumentsChunk(id: string, toolIndex: number, delta: string) {
  return {
    id,
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{ index: toolIndex, delta: { arguments: delta } }],
      },
      finish_reason: null,
    }],
  }
}

export function createNonStreamChoice(text: string, canUseTools: boolean, now = Date.now()) {
  const toolCall = resolveToolCallOutput(text, canUseTools)
  if (!toolCall) {
    return {
      index: 0,
      message: { role: "assistant", content: text },
      finish_reason: "stop",
    }
  }

  return {
    index: 0,
    message: {
      role: "assistant",
      content: null,
      tool_calls: [createToolCall(toolCall, `call_${now}`)],
    },
    finish_reason: "tool_calls",
  }
}

export function createFullToolCallChunks(id: string, toolIndex: number, toolCall: ParsedToolCall, now = Date.now()) {
  const callID = `call_${now}_${toolIndex}`
  return [
    createToolCallStartChunk(id, toolIndex, toolCall.tool, callID),
    createToolCallArgumentsChunk(id, toolIndex, JSON.stringify(toolCall.parameters)),
  ]
}

function createToolCall(toolCall: ParsedToolCall, id: string) {
  return {
    id,
    type: "function",
    function: {
      name: toolCall.tool,
      arguments: JSON.stringify(toolCall.parameters),
    },
  }
}
