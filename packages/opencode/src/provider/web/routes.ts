import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { streamSSE } from "hono/streaming"
import { authGet, authSet } from "./auth"
import { WEB_PROVIDERS, loginWebProvider } from "./index"
import type { WebProviderType, WebAuthCredentials } from "./types"
import { DeepSeekWebClient } from "./clients/deepseek-web-client"
import { ClaudeWebClient } from "./clients/claude-web-client"
import { ChatGPTWebClient } from "./clients/chatgpt-web-client"
import { DoubaoWebClient } from "./clients/doubao-web-client"
import { QwenWebClient } from "./clients/qwen-web-client"
import { QwenCNWebClient } from "./clients/qwen-cn-web-client"
import { KimiWebClient } from "./clients/kimi-web-client"
import { GLMWebClient } from "./clients/glm-web-client"
import { GLMIntlWebClient } from "./clients/glm-intl-web-client"
import { PerplexityWebClient } from "./clients/perplexity-web-client"
import { XiaomiMimoWebClient } from "./clients/xiaomimo-web-client"
import { GeminiWebClient } from "./clients/gemini-web-client"
import { GrokWebClient } from "./clients/grok-web-client"
import { getDeepSeekConversationState, setDeepSeekParentMessageID, setDeepSeekSessionID } from "./deepseek-session-state"
import { type ParsedToolCall } from "./tool-calling/web-tool-parser"
import { buildWebPrompt } from "./tool-calling/web-message-prompt"
import { createFullToolCallChunks, createNonStreamChoice, createTextDeltaChunk, createToolCallArgumentsChunk, createToolCallStartChunk, resolveToolCallOutput } from "./tool-calling/web-tool-response"
import { consumeWebToolStreamChunk, createWebToolStreamState, flushWebToolStreamState } from "./tool-calling/web-tool-stream"
import { shouldInjectToolPrompt } from "./tool-calling/web-tool-prompt"
import { parseGenericWebSSE } from "./streams/generic-web-stream"
import { parseKimiConnectStream } from "./streams/kimi-web-stream"
import { parseDeepSeekProviderSSE, parseDoubaoProviderSSE, parseXiaomiMimoProviderSSE, type ParsedProviderChunk } from "./streams/special-web-parsers"
import { errors } from "./errors"
import { lazy } from "../../util/lazy"
import { log } from "./log"

export const WebProviderRoutes = lazy(() =>
  new Hono()
    .basePath("/provider")
    .post(
      "/:providerID/web-auth",
      describeRoute({
        summary: "Web Provider authentication",
        description: "Launch browser and capture session credentials for Web Providers (Zero-Token). Streams progress via SSE.",
        operationId: "provider.webAuth",
        responses: {
          200: {
            description: "Web auth progress stream",
            content: {
              "text/event-stream": {
                schema: resolver(
                  z.object({
                    status: z.enum(["launching", "waiting", "capturing", "success", "error"]),
                    message: z.string(),
                    credentials: z
                      .object({
                        accessToken: z.string(),
                        cookie: z.string(),
                        userAgent: z.string(),
                      })
                      .optional(),
                  }),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          providerID: z.string().describe("Provider ID (e.g. gemini-web)"),
        }),
      ),
      async (c) => {
        const providerID = c.req.valid("param").providerID

        if (!(providerID in WEB_PROVIDERS)) {
          return c.json({ status: "error", message: `Unknown web provider: ${providerID}` }, 400)
        }

        const type = providerID as WebProviderType

        c.header("Cache-Control", "no-cache, no-transform")
        c.header("X-Accel-Buffering", "no")
        c.header("X-Content-Type-Options", "nosniff")

        return streamSSE(c, async (stream) => {
          const send = async (status: string, message: string, creds?: object) => {
            await stream.writeSSE({ data: JSON.stringify({ status, message, ... (creds ? { credentials: creds } : {}) }) })
          }

          try {
            await send("launching", "Launching browser...")

            const creds = await loginWebProvider(type, {
              onProgress: async (msg) => {
                if (msg.includes("login") || msg.includes("Please") || msg.includes("Polling") || msg.includes("Detected") || msg.includes("[Debug]")) {
                  await send("waiting", msg)
                } else if (msg.includes("Connecting") || msg.includes("Capturing") || msg.includes("capturing")) {
                  await send("capturing", msg)
                } else {
                  await send("launching", msg)
                }
              },
              openUrl: async () => true,
            })

            await send("capturing", "Capturing session credentials...")

            await authSet(providerID, { type: "api", key: JSON.stringify(creds) })

            await send("success", "Authentication successful!", creds)
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            log.error(`[WebAuth] ${type} failed: ${msg}`)
            await send("error", msg)
          }
        })
      },
    )
    .post(
      "/:providerID/chat/completions",
      describeRoute({
        summary: "Web Provider chat completions (proxy)",
        description: "Proxy endpoint that translates OpenAI-compatible requests to each Web Provider's native API format.",
        operationId: "provider.webChat",
        responses: {
          200: { description: "Chat completion response (SSE or JSON)" },
          ...errors(400, 401),
        },
      }),
      validator("param", z.object({
        providerID: z.string().describe("Web Provider ID (e.g. gemini-web)"),
      })),
      async (c) => {
        const providerID = c.req.valid("param").providerID

        if (!(providerID in WEB_PROVIDERS)) {
          return c.json({ error: { message: `Unknown web provider: ${providerID}`, type: "invalid_request_error" } }, 400)
        }

        const auth = await authGet(providerID)
        if (!auth || auth.type !== "api" || !auth.key) {
          return c.json({ error: { message: "Not authenticated. Please connect this provider first.", type: "authentication_error" } }, 401)
        }

        let creds: WebAuthCredentials
        try { creds = JSON.parse(auth.key) as WebAuthCredentials }
        catch { return c.json({ error: { message: "Invalid credentials", type: "authentication_error" } }, 401) }

        log.info(`[WebChat] ${providerID} creds: bearer=${creds.bearer?.slice(0, 30) || "none"}... cookie=${creds.cookie?.slice(0, 100)}... ua=${creds.userAgent?.slice(0, 50)}...`)

        const body = await c.req.json() as any
        const model = body.model ?? ""
        const stream = body.stream ?? true
        const messages = body.messages ?? []
        const tools = body.tools ?? []

        log.info(`[WebChat] ${providerID} model=${model} stream=${stream} msgs=${messages.length} tools=${tools.length}`)

        const prompt = buildWebPrompt(messages, tools, providerID)

        try {
          if (stream) {
            return proxyStream(c, providerID as WebProviderType, creds, prompt, model, tools)
          }
          const result = await proxyNonStream(providerID as WebProviderType, creds, prompt, model, tools)
          return c.json(result)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          log.error(`[WebChat] ${providerID} error: ${msg}`)
          return c.json({ error: { message: msg, type: "server_error" } }, 500)
        }
      },
    ),
  )

async function proxyStream(
  c: any,
  type: WebProviderType,
  creds: WebAuthCredentials,
  prompt: string,
  model: string,
  tools: any[],
) {
  c.header("Content-Type", "text/event-stream")
  c.header("Cache-Control", "no-cache, no-transform")
  c.header("X-Accel-Buffering", "no")
  c.header("Connection", "keep-alive")

  const encoder = new TextEncoder()
  const id = "chatcmpl-" + Date.now()
  const hasTools = tools && tools.length > 0

  const stream = new ReadableStream({
    async start(controller) {
      let content = ""
      let finished = false

      const safeEnqueue = (data: string) => {
        try { controller.enqueue(encoder.encode(data)) } catch { /* closed */ }
      }

      const safeFinish = (reason: string = "stop") => {
        if (finished) return
        finished = true
        try {
          safeEnqueue(sseChunk({ id, choices: [{ index: 0, delta: {}, finish_reason: reason }], usage: { prompt_tokens: Math.floor(prompt.length / 4), completion_tokens: Math.floor(content.length / 4), total_tokens: Math.floor((prompt.length + content.length) / 4) } }))
        } finally {
          try { controller.close() } catch { /* already closed */ }
        }
      }

      safeEnqueue(sseChunk({ id, object: { role: "assistant", content: "" }, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }))

      try {
        log.info(`[WebChat] ${type} calling provider, prompt length=${prompt.length}, model=${model}`)

        const body = await callProvider(type, creds, prompt, model)
        if (!body) throw new Error(type + " returned empty response body")

        log.info(`[WebChat] ${type} response received, starting parse...`)

        if (hasTools) {
          await proxyStreamWithTools(controller, encoder, id, type, creds, model, body, tools, (t) => { content += t })
        } else {
          let textCount = 0
          for await (const chunk of parseProviderSSE(type, body)) {
            trackProviderState(type, creds, model, chunk)
            if (chunk.thinking) {
              safeEnqueue(sseChunk({ id, choices: [{ index: 0, delta: { content: chunk.thinking }, finish_reason: null }] }))
            }
            if (chunk.text) {
              content += chunk.text
              textCount++
              safeEnqueue(sseChunk({ id, choices: [{ index: 0, delta: { content: chunk.text }, finish_reason: null }] }))
            }
          }
          log.info(`[WebChat] ${type} parsed ${textCount} text chunks, total content length=${content.length}`)
        }

        if (!content) {
          safeEnqueue(sseChunk({ id, choices: [{ index: 0, delta: { content: "(No response from " + type + ". The session may have expired - please reconnect.)" }, finish_reason: null }] }))
        }

        safeFinish("stop")
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        log.error(`[WebChat] ${type} stream error: ${msg}`)

        safeEnqueue(sseChunk({ id, choices: [{ index: 0, delta: { content: "[Error] " + msg }, finish_reason: null }] }))
        safeFinish("stop")
      }
    },
  })

  return c.newResponse(stream, 200, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  })
}

async function proxyStreamWithTools(
  controller: ReadableStreamDefaultController<any>,
  encoder: TextEncoder,
  id: string,
  type: WebProviderType,
  creds: Pick<WebAuthCredentials, "bearer" | "cookie">,
  model: string | undefined,
  body: ReadableStream<Uint8Array>,
  _tools: any[],
  onText: (t: string) => void,
) {
  let accumulatedText = ""
  const hasTools = _tools && _tools.length > 0
  let toolState = createWebToolStreamState()
  let toolCallEmitted = false

  const flushText = (text: string) => {
    if (!text) return
    onText(text)
    controller.enqueue(encoder.encode(sseChunk(createTextDeltaChunk(id, text))))
  }

  const emitToolStart = (name: string, tid: string) => {
    if (toolCallEmitted) return
    toolCallEmitted = true
    controller.enqueue(encoder.encode(sseChunk(createToolCallStartChunk(id, toolState.toolIndex, name, tid))))
  }

  const emitToolDelta = (delta: string) => {
    if (!toolCallEmitted) return
    controller.enqueue(encoder.encode(sseChunk(createToolCallArgumentsChunk(id, toolState.toolIndex, delta))))
  }

  const emitFullToolCall = (tc: ParsedToolCall) => {
    if (toolCallEmitted) return
    toolCallEmitted = true
    for (const chunk of createFullToolCallChunks(id, toolState.toolIndex, tc)) {
      controller.enqueue(encoder.encode(sseChunk(chunk)))
    }
  }

  for await (const chunk of parseProviderSSE(type, body)) {
    trackProviderState(type, creds, model, chunk)
    const text = chunk.text
    if (!text) continue
    accumulatedText += text
    if (hasTools) {
      const result = consumeWebToolStreamChunk(toolState, text)
      toolState = result.state
      for (const event of result.events) {
        if (event.type === "text") flushText(event.text)
        if (event.type === "tool-args") emitToolDelta(event.text)
        if (event.type === "tool-start") {
          toolState = { ...toolState, toolIndex: event.toolIndex }
          emitToolStart(event.toolName, event.toolCallID)
        }
      }
    } else {
      flushText(text)
    }
  }

  const flushed = flushWebToolStreamState(toolState)
  toolState = flushed.state
  for (const event of flushed.events) {
    if (event.type === "text") flushText(event.text)
    if (event.type === "tool-args") emitToolDelta(event.text)
  }

  if (hasTools && !toolCallEmitted && accumulatedText.length > 10) {
    const tc = resolveToolCallOutput(accumulatedText, true)
    if (tc) {
      log.info(`[WebChat] ${type} found tool call via extractToolCall: ${tc.tool}`)
      emitFullToolCall(tc)
    }
  }
}

async function proxyNonStream(
  type: WebProviderType,
  creds: WebAuthCredentials,
  prompt: string,
  model: string,
  tools: any[],
) {
  const body = await callProvider(type, creds, prompt, model)
  if (!body) throw new Error("Empty response from provider")

  const texts: string[] = []
  for await (const chunk of parseProviderSSE(type, body)) {
    trackProviderState(type, creds, model, chunk)
    if (chunk.text) texts.push(chunk.text)
    if (chunk.thinking) texts.push(chunk.thinking)
  }
  const fullText = texts.join("")

  const canUseTools = tools?.length > 0 && shouldInjectToolPrompt(type)
  const toolCall = resolveToolCallOutput(fullText, canUseTools)
  if (toolCall) {
    log.info(`[WebChat] ${type} non-stream tool call found: ${toolCall.tool}`)
  }
  const choices = [createNonStreamChoice(fullText, canUseTools)]

  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices,
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }
}

async function callProvider(
  type: WebProviderType,
  creds: WebAuthCredentials,
  message: string,
  model: string,
): Promise<ReadableStream<Uint8Array>> {
  switch (type) {
    case "deepseek-web": {
      const client = new DeepSeekWebClient({ cookie: creds.cookie, bearer: creds.bearer, userAgent: creds.userAgent })
      await client.init()
      const state = getDeepSeekConversationState(creds, model)
      const sessionID = state.sessionID ?? await createDeepSeekSession(client, creds, model)
      return client.chatCompletions({
        sessionId: sessionID,
        parentMessageId: state.parentMessageID,
        message,
        model,
      })
    }
    case "doubao-web": {
      const client = new DoubaoWebClient({ cookie: creds.cookie, userAgent: creds.userAgent })
      await client.init()
      return client.chatCompletions({ message, model })
    }
    case "qwen-web": {
      const client = new QwenWebClient({ cookie: creds.cookie, userAgent: creds.userAgent })
      await client.init()
      return client.chatCompletions({ message, model })
    }
    case "kimi-web": {
      const client = new KimiWebClient({ cookie: creds.cookie, userAgent: creds.userAgent })
      await client.init()
      return client.chatCompletions({ message, model })
    }
    case "glm-web": {
      const client = new GLMWebClient({ cookie: creds.cookie, userAgent: creds.userAgent })
      await client.init()
      return client.chatCompletions({ message, model })
    }
    case "glm-intl-web": {
      const client = new GLMIntlWebClient({ cookie: creds.cookie, userAgent: creds.userAgent })
      await client.init()
      return client.chatCompletions({ message, model })
    }
    case "qwen-cn-web": {
      const client = new QwenCNWebClient({ cookie: creds.cookie, userAgent: creds.userAgent })
      await client.init()
      return client.chatCompletions({ message, model })
    }
    case "perplexity-web": {
      const client = new PerplexityWebClient({ cookie: creds.cookie, userAgent: creds.userAgent })
      await client.init()
      return client.chatCompletions({ message, model })
    }
    case "xiaomimo-web": {
      const client = new XiaomiMimoWebClient({ cookie: creds.cookie, bearer: creds.bearer, userAgent: creds.userAgent })
      await client.init()
      return client.chatCompletions({ message, model })
    }
    case "claude-web": {
      const client = new ClaudeWebClient({ cookie: creds.cookie, userAgent: creds.userAgent })
      await client.init()
      return client.chatCompletions({ message, model })
    }
    case "chatgpt-web": {
      const client = new ChatGPTWebClient({ cookie: creds.cookie, accessToken: creds.accessToken, userAgent: creds.userAgent })
      await client.init()
      return client.chatCompletions({ message, model })
    }
    case "gemini-web": {
      const client = new GeminiWebClient({ cookie: creds.cookie, userAgent: creds.userAgent })
      await client.init()
      return client.chatCompletions({ message, model })
    }
    case "grok-web": {
      const client = new GrokWebClient({ cookie: creds.cookie, userAgent: creds.userAgent })
      await client.init()
      return client.chatCompletions({ message, model })
    }
    default:
      throw new Error(`Unsupported web provider for chat: ${type}`)
  }
}

async function createDeepSeekSession(
  client: DeepSeekWebClient,
  creds: Pick<WebAuthCredentials, "bearer" | "cookie">,
  model?: string,
) {
  const session = await client.createChatSession()
  setDeepSeekSessionID(creds, model, session.chat_session_id)
  return session.chat_session_id
}

function trackProviderState(
  type: WebProviderType,
  creds: Pick<WebAuthCredentials, "bearer" | "cookie">,
  model: string | undefined,
  chunk: ParsedProviderChunk,
) {
  if (type !== "deepseek-web") return
  if (typeof chunk.messageID === "undefined") return
  setDeepSeekParentMessageID(creds, model, chunk.messageID)
}

async function* parseProviderSSE(type: WebProviderType, stream: ReadableStream<Uint8Array>): AsyncGenerator<ParsedProviderChunk> {
  if (type === "deepseek-web") {
    yield* parseDeepSeekProviderSSE(stream)
    return
  }

  if (type === "doubao-web") {
    yield* parseDoubaoProviderSSE(stream)
    return
  }

  if (type === "xiaomimo-web") {
    yield* parseXiaomiMimoProviderSSE(stream)
    return
  }

  if (
    type === "qwen-web" ||
    type === "qwen-cn-web" ||
    type === "glm-web" ||
    type === "glm-intl-web" ||
    type === "gemini-web" ||
    type === "grok-web" ||
    type === "perplexity-web"
  ) {
    for await (const text of parseGenericWebSSE(stream)) {
      yield { text }
    }
    return
  }

  if (type === "kimi-web") {
    for await (const text of parseKimiConnectStream(stream)) {
      yield { text }
    }
    return
  }

  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let chatgptAccumulated = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        if (trimmed.startsWith("event:")) continue

        let data = ""
        if (trimmed.startsWith("data:")) {
          const colonIdx = trimmed.indexOf(":")
          data = trimmed.slice(colonIdx + 1).trim()
        } else {
          continue
        }
        if (!data || data === "[DONE]") continue

        try {
          const parsed = JSON.parse(data)

          switch (type) {
            case "claude-web": {
              if (parsed.completion) yield { text: parsed.completion }
              else if (parsed.delta?.text) yield { text: parsed.delta.text }
              else if (parsed.type === "content_block_delta" && parsed.delta?.text) yield { text: parsed.delta.text }
              break
            }
            case "chatgpt-web": {
              const rawPart = parsed.message?.content?.parts?.[0]
              const content = typeof rawPart === "string"
                ? rawPart
                : typeof rawPart === "object" && rawPart !== null && "text" in rawPart
                  ? (rawPart as any).text
                  : undefined
              if (typeof content === "string" && content) {
                const delta = content.slice(chatgptAccumulated.length)
                if (delta) {
                  chatgptAccumulated = content
                  yield { text: delta }
                }
              }
              break
            }
          }
        } catch { /* skip */ }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

function sseChunk(data: any): string {
  return `data: ${JSON.stringify(data)}\n\n`
}
