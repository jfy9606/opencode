import { describe, expect, test } from "bun:test"
import {
  consumeWebToolStreamChunk,
  createWebToolStreamState,
  flushWebToolStreamState,
} from "../../src/provider/web/tool-calling/web-tool-stream"

describe("web tool stream", () => {
  test("passes through plain text outside tool calls", () => {
    const result = consumeWebToolStreamChunk(createWebToolStreamState(), "hello world", 123)

    expect(result.events).toEqual([{ type: "text", text: "hello world" }])
    expect(result.state).toEqual({
      tagBuffer: "",
      inToolCall: false,
      toolIndex: 0,
    })
  })

  test("parses split tool_call tags across chunks", () => {
    const first = consumeWebToolStreamChunk(
      createWebToolStreamState(),
      "before <tool_call name='read_file'>",
      123,
    )
    const second = consumeWebToolStreamChunk(first.state, '{"path":"READ', 123)
    const third = consumeWebToolStreamChunk(second.state, 'ME.md"}</tool_call> after', 123)

    expect(first.events).toEqual([
      { type: "text", text: "before " },
      { type: "tool-start", toolName: "read_file", toolCallID: "call_123_1", toolIndex: 1 },
    ])
    expect(second.events).toEqual([{ type: "tool-args", text: '{"path":"READ', toolIndex: 1 }])
    expect(third.events).toEqual([
      { type: "tool-args", text: 'ME.md"}', toolIndex: 1 },
      { type: "text", text: " after" },
    ])
    expect(third.state).toEqual({
      tagBuffer: "",
      inToolCall: false,
      toolIndex: 1,
    })
  })

  test("handles a tag boundary that starts mid-token", () => {
    const first = consumeWebToolStreamChunk(createWebToolStreamState(), "<tool", 123)
    const second = consumeWebToolStreamChunk(first.state, "_call id='abc' name='write_file'>", 123)

    expect(first.events).toEqual([])
    expect(second.events).toEqual([
      { type: "tool-start", toolName: "write_file", toolCallID: "abc", toolIndex: 1 },
    ])
  })

  test("handles multiple tool-call boundaries in one chunk", () => {
    const result = consumeWebToolStreamChunk(
      createWebToolStreamState(),
      "a<tool_call name='read_file'>{}</tool_call>b<tool_call name='write_file'>{\"x\":1}</tool_call>c",
      123,
    )

    expect(result.events).toEqual([
      { type: "text", text: "a" },
      { type: "tool-start", toolName: "read_file", toolCallID: "call_123_1", toolIndex: 1 },
      { type: "tool-args", text: "{}", toolIndex: 1 },
      { type: "text", text: "b" },
      { type: "tool-start", toolName: "write_file", toolCallID: "call_123_2", toolIndex: 2 },
      { type: "tool-args", text: '{"x":1}', toolIndex: 2 },
      { type: "text", text: "c" },
    ])
  })

  test("flushes trailing buffered tool arguments", () => {
    const consumed = consumeWebToolStreamChunk(
      createWebToolStreamState(),
      "<tool_call name='read_file'>{\"path\":\"README.md\"}",
      123,
    )
    const flushed = flushWebToolStreamState(consumed.state)

    expect(consumed.events).toEqual([
      { type: "tool-start", toolName: "read_file", toolCallID: "call_123_1", toolIndex: 1 },
      { type: "tool-args", text: '{"path":"README.md"}', toolIndex: 1 },
    ])
    expect(flushed.events).toEqual([])
    expect(flushed.state).toEqual({
      tagBuffer: "",
      inToolCall: true,
      toolIndex: 1,
    })
  })
})
