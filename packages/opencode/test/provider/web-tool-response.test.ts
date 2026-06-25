import { describe, expect, test } from "bun:test"
import {
  createFullToolCallChunks,
  createNonStreamChoice,
  createTextDeltaChunk,
  createToolCallArgumentsChunk,
  createToolCallStartChunk,
  resolveToolCallOutput,
} from "../../src/provider/web/tool-calling/web-tool-response"

describe("web tool response", () => {
  test("skips tool extraction when tool calling is disabled", () => {
    expect(resolveToolCallOutput('{"tool":"read_file","parameters":{"path":"README.md"}}', false)).toBeNull()
  })

  test("builds a plain non-stream choice when no tool call is present", () => {
    expect(createNonStreamChoice("hello", true, 123)).toEqual({
      index: 0,
      message: { role: "assistant", content: "hello" },
      finish_reason: "stop",
    })
  })

  test("builds a non-stream tool_call choice from extracted JSON", () => {
    expect(
      createNonStreamChoice('{"tool":"read_file","parameters":{"path":"README.md"}}', true, 123),
    ).toEqual({
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_123",
          type: "function",
          function: {
            name: "read_file",
            arguments: '{"path":"README.md"}',
          },
        }],
      },
      finish_reason: "tool_calls",
    })
  })

  test("builds stream chunks for text and tool calls", () => {
    expect(createTextDeltaChunk("chatcmpl-1", "hello")).toEqual({
      id: "chatcmpl-1",
      choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
    })
    expect(createToolCallStartChunk("chatcmpl-1", 0, "read_file", "call_1")).toEqual({
      id: "chatcmpl-1",
      choices: [{
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [{
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: "" },
          }],
        },
        finish_reason: null,
      }],
    })
    expect(createToolCallArgumentsChunk("chatcmpl-1", 0, '{"path":"README.md"}')).toEqual({
      id: "chatcmpl-1",
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{ index: 0, delta: { arguments: '{"path":"README.md"}' } }],
        },
        finish_reason: null,
      }],
    })
  })

  test("builds full stream tool_call chunks from parsed tool calls", () => {
    expect(
      createFullToolCallChunks(
        "chatcmpl-1",
        1,
        { tool: "write_file", parameters: { path: "out.md", content: "hi" } },
        456,
      ),
    ).toEqual([
      {
        id: "chatcmpl-1",
        choices: [{
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [{
              index: 1,
              id: "call_456_1",
              type: "function",
              function: { name: "write_file", arguments: "" },
            }],
          },
          finish_reason: null,
        }],
      },
      {
        id: "chatcmpl-1",
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 1,
              delta: { arguments: '{"path":"out.md","content":"hi"}' },
            }],
          },
          finish_reason: null,
        }],
      },
    ])
  })
})
