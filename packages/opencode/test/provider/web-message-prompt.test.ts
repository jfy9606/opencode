import { describe, expect, test } from "bun:test"
import { buildWebPrompt } from "../../src/provider/web/tool-calling/web-message-prompt"

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
]

describe("web message prompt", () => {
  test("serializes system and user content with file attachments", () => {
    const prompt = buildWebPrompt(
      [
        { role: "system", content: [{ type: "text", text: "Follow the spec." }] },
        {
          role: "user",
          content: [
            { type: "text", text: "Please inspect this file." },
            { type: "file", filename: "spec.md", mediaType: "text/markdown" },
          ],
        },
      ],
      [],
      "chatgpt-web",
    )

    expect(prompt).toBe("Follow the spec.\n\nPlease inspect this file.\n[File: spec.md (text/markdown)]")
  })

  test("serializes assistant tool calls and embedded tool outputs", () => {
    const prompt = buildWebPrompt(
      [
        {
          role: "assistant",
          content: [
            { type: "text", text: "I will inspect it." },
            { type: "tool-call", toolName: "read_file", input: { path: "spec.md" } },
            { type: "tool-output", tool: "read_file", state: "output-available", output: { text: "hello" } },
            { type: "tool-error", tool: "write_file", state: "output-error", errorText: "permission denied" },
          ],
          tool_calls: [
            {
              function: {
                name: "write_file",
                arguments: '{"path":"out.md"}',
              },
            },
          ],
        },
      ],
      [],
      "chatgpt-web",
    )

    expect(prompt).toContain('Tool read_file returned: {"text":"hello"}')
    expect(prompt).toContain("Tool write_file returned: [Error] permission denied")
    expect(prompt).toContain("Assistant:\nI will inspect it.")
    expect(prompt).toContain('{"tool":"read_file","parameters":{"path":"spec.md"}}')
    expect(prompt).toContain('{"tool":"write_file","parameters":{"path":"out.md"}}')
  })

  test("serializes tool role results", () => {
    const prompt = buildWebPrompt(
      [
        {
          role: "tool",
          name: "read_file",
          content: [{ type: "tool-result", text: "spec contents" }],
        },
        {
          role: "toolResult",
          name: "write_file",
          content: { ok: true },
        },
      ],
      [],
      "chatgpt-web",
    )

    expect(prompt).toBe('Tool read_file returned: spec contents\n\nTool write_file returned: {"ok":true}')
  })

  test("injects the tool prompt only when the last user message needs tools", () => {
    const injected = buildWebPrompt(
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "please read the file for me" },
      ],
      tools,
      "chatgpt-web",
    )
    const skipped = buildWebPrompt(
      [
        { role: "user", content: "please read the file for me" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "thanks" },
      ],
      tools,
      "chatgpt-web",
    )

    expect(injected).toStartWith("Tools:")
    expect(injected).toContain("No extra text.")
    expect(skipped).toBe("please read the file for me\n\nAssistant:\nhi\n\nthanks")
  })
})
