import { describe, expect, test } from "bun:test"
import { toolDefsJson } from "../../src/provider/web/tool-calling/web-tool-defs"
import { evaluateToolInjection, parseToolCallFromResponse } from "../../src/provider/web/tool-calling/web-stream-middleware"
import { shouldInjectToolPrompt } from "../../src/provider/web/tool-calling/web-tool-prompt"

const tools = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file from disk",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
      },
    },
  },
  {
    name: "write_file",
    description: "Write a file to disk",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
    },
  },
]

describe("web tool calling", () => {
  test("serializes dynamic tool definitions from OpenAI-style tools", () => {
    expect(toolDefsJson(tools)).toBe(
      JSON.stringify([
        {
          name: "read_file",
          description: "Read a file from disk",
          parameters: { path: "string" },
        },
        {
          name: "write_file",
          description: "Write a file to disk",
          parameters: { path: "string", content: "string" },
        },
      ]),
    )
  })

  test("injects a strict English tool prompt for chatgpt with dynamic tools", () => {
    const prompt = evaluateToolInjection("please read this file for me", "chatgpt-web", tools)

    expect(prompt).toContain('"name":"read_file"')
    expect(prompt).toContain("No extra text.")
  })

  test("injects a Chinese tool prompt for glm-intl when the message needs tools", () => {
    const prompt = evaluateToolInjection("请帮我读取这个文件", "glm-intl-web", tools)

    expect(prompt).toContain("工具:")
    expect(prompt).toContain('"name":"write_file"')
  })

  test("skips prompt injection for excluded providers and non-tool messages", () => {
    expect(evaluateToolInjection("search the web", "perplexity-web", tools)).toBeNull()
    expect(evaluateToolInjection("hello there", "chatgpt-web", tools)).toBeNull()
  })

  test("shares provider-level tool support policy", () => {
    expect(shouldInjectToolPrompt("perplexity-web")).toBe(false)
    expect(shouldInjectToolPrompt("glm-intl-web")).toBe(true)
  })

  test("parses fuzzy repaired tool calls from accumulated text", () => {
    expect(parseToolCallFromResponse('Result: {"tool":"read_file","parameters":{"path":"README.md"}')).toEqual({
      tool: "read_file",
      parameters: { path: "README.md" },
    })
  })
})
