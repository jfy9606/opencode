export interface WebToolStreamState {
  tagBuffer: string
  inToolCall: boolean
  toolIndex: number
}

export type WebToolStreamEvent =
  | {
      type: "text"
      text: string
    }
  | {
      type: "tool-args"
      text: string
      toolIndex: number
    }
  | {
      type: "tool-start"
      toolName: string
      toolCallID: string
      toolIndex: number
    }

const TOOL_START_REGEX = /<tool_call\s*(?:id=['"]?([^'"]+)['"]?\s*)?name=['"]?([^'"]+)['"]?\s*>/i
const TOOL_END_REGEX = /<\/tool_call\s*>/i

export function createWebToolStreamState(): WebToolStreamState {
  return {
    tagBuffer: "",
    inToolCall: false,
    toolIndex: 0,
  }
}

export function consumeWebToolStreamChunk(
  state: WebToolStreamState,
  text: string,
  now = Date.now(),
) {
  let next = {
    ...state,
    tagBuffer: state.tagBuffer + text,
  }
  const events: WebToolStreamEvent[] = []

  while (true) {
    const boundary = findFirstBoundary(next.tagBuffer)
    if (!boundary) break

    const before = next.tagBuffer.slice(0, boundary.idx)
    next = {
      ...next,
      tagBuffer: next.tagBuffer.slice(boundary.idx + boundary.len),
    }
    pushBufferedText(events, before, next.inToolCall, next.toolIndex)

    if (boundary.type === "end") {
      next = {
        ...next,
        inToolCall: false,
      }
      continue
    }

    const toolIndex = next.toolIndex + 1
    events.push({
      type: "tool-start",
      toolName: boundary.name,
      toolCallID: boundary.id || `call_${now}_${toolIndex}`,
      toolIndex,
    })
    next = {
      ...next,
      inToolCall: true,
      toolIndex,
    }
  }

  const lastAngle = next.tagBuffer.lastIndexOf("<")
  if (lastAngle > 0) {
    const safe = next.tagBuffer.slice(0, lastAngle)
    pushBufferedText(events, safe, next.inToolCall, next.toolIndex)
    next = {
      ...next,
      tagBuffer: next.tagBuffer.slice(lastAngle),
    }
  }
  if (lastAngle === -1) {
    pushBufferedText(events, next.tagBuffer, next.inToolCall, next.toolIndex)
    next = {
      ...next,
      tagBuffer: "",
    }
  }

  return {
    state: next,
    events,
  }
}

export function flushWebToolStreamState(state: WebToolStreamState) {
  const events: WebToolStreamEvent[] = []
  pushBufferedText(events, state.tagBuffer, state.inToolCall, state.toolIndex)
  return {
    state: {
      ...state,
      tagBuffer: "",
    },
    events,
  }
}

function findFirstBoundary(tagBuffer: string) {
  const startMatch = tagBuffer.match(TOOL_START_REGEX)
  const endMatch = tagBuffer.match(TOOL_END_REGEX)
  const boundaries = [
    startMatch
      ? {
          type: "start" as const,
          idx: startMatch.index ?? 0,
          len: startMatch[0].length,
          id: startMatch[1],
          name: startMatch[2],
        }
      : undefined,
    endMatch
      ? {
          type: "end" as const,
          idx: endMatch.index ?? 0,
          len: endMatch[0].length,
        }
      : undefined,
  ].filter((value) => value !== undefined)

  if (!boundaries.length) return
  boundaries.sort((a, b) => a.idx - b.idx)
  return boundaries[0]
}

function pushBufferedText(
  events: WebToolStreamEvent[],
  text: string,
  inToolCall: boolean,
  toolIndex: number,
) {
  if (!text) return
  if (inToolCall) {
    events.push({
      type: "tool-args",
      text,
      toolIndex,
    })
    return
  }

  events.push({
    type: "text",
    text,
  })
}
