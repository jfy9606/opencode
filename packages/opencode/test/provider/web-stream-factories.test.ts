import { describe, expect, test } from "bun:test"
import { parseGenericWebSSE } from "../../src/provider/web/streams/generic-web-stream"
import { parseKimiConnectStream } from "../../src/provider/web/streams/kimi-web-stream"
import { parseDeepSeekProviderSSE, parseDoubaoProviderSSE, parseXiaomiMimoProviderSSE, type ParsedProviderChunk } from "../../src/provider/web/streams/special-web-parsers"
import { listSupportedProviders } from "../../src/provider/web/streams/web-stream-factories"

function streamFromText(chunks: string[]) {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

function createKimiFrame(payload: unknown) {
  const encoded = new TextEncoder().encode(JSON.stringify(payload))
  const frame = new Uint8Array(encoded.length + 5)
  frame[0] = 0
  new DataView(frame.buffer).setUint32(1, encoded.length, false)
  frame.set(encoded, 5)
  return frame
}

function streamFromFrames(frames: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(frame)
      controller.close()
    },
  })
}

async function collect(stream: AsyncIterable<string>) {
  const result: string[] = []
  for await (const item of stream) result.push(item)
  return result
}

async function collectChunks(stream: AsyncIterable<ParsedProviderChunk>) {
  const result: ParsedProviderChunk[] = []
  for await (const item of stream) result.push(item)
  return result
}

describe("web stream factories", () => {
  test("lists every built-in web provider with a stream factory", () => {
    expect(listSupportedProviders()).toEqual([
      "chatgpt-web",
      "claude-web",
      "deepseek-web",
      "doubao-web",
      "qwen-web",
      "qwen-cn-web",
      "kimi-web",
      "gemini-web",
      "grok-web",
      "glm-web",
      "glm-intl-web",
      "perplexity-web",
      "xiaomimo-web",
    ])
  })

  test("parses generic SSE streams with mixed cumulative and delta chunks", async () => {
    const output = await collect(
      parseGenericWebSSE(
        streamFromText([
          'data: {"text":"Hello"}\n',
          'data: {"text":"Hello world"}\n',
          'data: {"choices":[{"delta":{"content":"!"}}]}\n\n',
        ]),
      ),
    )

    expect(output).toEqual(["Hello", " world", "!"])
  })

  test("parses Kimi connect frames into text deltas", async () => {
    const output = await collect(
      parseKimiConnectStream(
        streamFromFrames([
          createKimiFrame({ text: "Kimi" }),
          createKimiFrame({ text: "Kimi reply" }),
        ]),
      ),
    )

    expect(output).toEqual(["Kimi", " reply"])
  })

  test("parses Doubao event_data payloads into text deltas", async () => {
    const output = await collectChunks(
      parseDoubaoProviderSSE(
        streamFromText([
          'data: {"event_type":2001,"event_data":"{\\"message\\":{\\"content\\":\\"{\\\\\\"text\\\\\\":\\\\\\"Hello from Doubao\\\\\\"}\\"}}"}\n',
          'data: {"event_type":2003,"event_data":{"text":"!"}}\n\n',
        ]),
      ),
    )

    expect(output).toEqual([{ text: "Hello from Doubao" }, { text: "!" }])
  })

  test("parses DeepSeek response message IDs alongside text deltas", async () => {
    const output = await collectChunks(
      parseDeepSeekProviderSSE(
        streamFromText([
          'data: {"response_message_id":"msg_1","v":"Hello"}\n',
          'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        ]),
      ),
    )

    expect(output).toEqual([{ messageID: "msg_1" }, { text: "Hello" }, { text: " world" }])
  })

  test("strips XiaomiMiMo think tags before yielding text", async () => {
    const output = await collectChunks(
      parseXiaomiMimoProviderSSE(
        streamFromText([
          'data: {"content":"<think>internal plan</think>Hello"}\n',
          'data: {"choices":[{"delta":{"content":"Hello world"}}]}\n\n',
        ]),
      ),
    )

    expect(output).toEqual([{ text: "Hello" }, { text: " world" }])
  })
})
