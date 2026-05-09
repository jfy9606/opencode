import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { streamSSE } from "hono/streaming"
import { Auth } from "../../auth"
import { ProviderID } from "../../provider/schema"
import { WEB_PROVIDERS, loginWebProvider } from "../../provider/web/index"
import type { WebProviderType, WebAuthCredentials } from "../../provider/web/types"
import { DeepSeekWebClient } from "../../provider/web/clients/deepseek-web-client"
import { ClaudeWebClient } from "../../provider/web/clients/claude-web-client"
import { ChatGPTWebClient } from "../../provider/web/clients/chatgpt-web-client"
import { DoubaoWebClient } from "../../provider/web/clients/doubao-web-client"
import { QwenWebClient } from "../../provider/web/clients/qwen-web-client"
import { QwenCNWebClient } from "../../provider/web/clients/qwen-cn-web-client"
import { KimiWebClient } from "../../provider/web/clients/kimi-web-client"
import { GLMWebClient } from "../../provider/web/clients/glm-web-client"
import { GLMIntlWebClient } from "../../provider/web/clients/glm-intl-web-client"
import { PerplexityWebClient } from "../../provider/web/clients/perplexity-web-client"
import { XiaomiMimoWebClient } from "../../provider/web/clients/xiaomimo-web-client"
import { GeminiWebClient } from "../../provider/web/clients/gemini-web-client"
import { GrokWebClient } from "../../provider/web/clients/grok-web-client"
import { errors } from "../error"
import { lazy } from "../../util/lazy"
import { Log } from "../../util/log"

const log = Log.create({ service: "server" })

export const WebProviderRoutes = lazy(() =>
  new Hono()
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
          providerID: ProviderID.zod.meta({ description: "Provider ID (e.g. gemini-web)" }),
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

            await Auth.set(providerID, { type: "api", key: JSON.stringify(creds) })

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
        providerID: ProviderID.zod.meta({ description: "Web Provider ID (e.g. gemini-web)" }),
      })),
      async (c) => {
        const providerID = c.req.valid("param").providerID

        if (!(providerID in WEB_PROVIDERS)) {
          return c.json({ error: { message: `Unknown web provider: ${providerID}`, type: "invalid_request_error" } }, 400)
        }

        const auth = await Auth.get(providerID)
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

function buildToolDefs(tools: any[]): string {
  const defs: Array<{ name: string; description: string; parameters: Record<string, string> }> = []
  for (const t of tools) {
    const fn = t.function ?? t
    const params: Record<string, string> = {}
    if (fn.parameters?.properties) {
      for (const [k, v] of Object.entries(fn.parameters.properties)) {
        params[k] = (v as any).type ?? "string"
      }
    }
    defs.push({ name: fn.name, description: fn.description ?? "", parameters: params })
  }
  return JSON.stringify(defs)
}

const TOOL_EXAMPLE = `Example: to add 1 to number 5, return:
\`\`\`tool_json
{"tool":"plus_one","parameters":{"number":"5"}}
\`\`\`
(plus_one is just an example, not a real tool)`

function getToolPrompt(tools: any[], providerID: string): string {
  const defs = buildToolDefs(tools)
  const cnModels = new Set(["deepseek-web", "doubao-web", "qwen-cn-web", "kimi-web", "glm-web", "glm-intl-web", "xiaomimo-web"])
  const strictModels = new Set(["chatgpt-web"])

  if (cnModels.has(providerID)) {
    return `工具: ${defs}

示例: 要给数字5加1，返回:
\`\`\`tool_json
{"tool":"plus_one","parameters":{"number":"5"}}
\`\`\`
(plus_one仅为示例，非真实工具)

你的真实工具见上方列表。需要时只回复tool_json块。不需要则直接回答。

`
  }

  if (strictModels.has(providerID)) {
    return `Tools: ${defs}

${TOOL_EXAMPLE}

Your actual tools are listed above. To use one, reply ONLY with the tool_json block. No extra text.
No tool needed? Answer directly.

`
  }

  return `Tools: ${defs}

${TOOL_EXAMPLE}

Your actual tools are listed above. To use one, reply ONLY with the tool_json block.
No tool needed? Answer directly.

`
}

const TOOL_KEYWORDS = [
  "文件", "file", "read", "write", "创建", "写入", "读取", "打开", "保存",
  "desktop", "目录", "directory", "folder", "文件夹",
  "执行", "运行", "命令", "command", "run", "exec", "terminal", "终端", "shell",
  "搜索", "search", "查找", "查询", "fetch", "抓取", "网页", "url", "http",
  "下载", "download", "安装", "install", "更新", "update",
  "帮我", "help me", "查看", "check", "look", "看看", "show",
]

function needsTools(message: string): boolean {
  const lower = message.toLowerCase()
  return TOOL_KEYWORDS.some((kw) => lower.includes(kw))
}

const EXCLUDED_FROM_TOOLS = new Set(["perplexity-web"])

function buildWebPrompt(messages: any[], tools: any[], providerID: string): string {
  const parts: string[] = []
  let hasSystem = false

  const hasTools = tools.length > 0 && !EXCLUDED_FROM_TOOLS.has(providerID)
  const toolPrompt = hasTools ? getToolPrompt(tools, providerID) : ""

  for (const msg of messages) {
    if (msg.role === "system") {
      hasSystem = true
      let sys = typeof msg.content === "string" ? msg.content : ""
      if (Array.isArray(msg.content)) {
        sys = msg.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n")
      }
      parts.push(sys)
      continue
    }

    if (msg.role === "assistant") {
      const texts: string[] = []
      const calls: string[] = []

      if (typeof msg.content === "string" && msg.content) texts.push(msg.content)
      else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if ((part as any).type === "text" && part.text) texts.push(part.text)
          else if ((part as any).type === "tool-call") {
            const tc = part as any
            calls.push(`\`\`\`tool_json\n{"tool":"${tc.toolName}","parameters":${typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input ?? {})}}\n\`\`\``)
          } else if ((part as any).type?.startsWith("tool-")) {
            const tp = part as any
            if (tp.state === "output-available" || tp.state === "output-error") {
              const outText = tp.state === "output-error"
                ? "[Error] " + (tp.errorText ?? "")
                : (typeof tp.output === "string" ? tp.output : JSON.stringify(tp.output ?? ""))
              parts.push(`Tool ${tp.tool ?? "unknown"} returned: ${outText}`)
            }
          }
        }
      }

      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          calls.push(`\`\`\`tool_json\n{"tool":"${tc.function.name}","parameters":${tc.function.arguments}}\n\`\`\``)
        }
      }
      if (texts.length || calls.length) {
        parts.push("Assistant:\n" + texts.join("") + (calls.length ? "\n" + calls.join("\n") : ""))
      }
      continue
    }

    if (msg.role === "tool" || msg.role === "toolResult") {
      let resultText = ""
      if (typeof msg.content === "string") resultText = msg.content
      else if (Array.isArray(msg.content)) {
        const tr = msg.content.find((p: any) => p.type === "tool-result")
        resultText = tr?.text ?? JSON.stringify(msg.content)
      } else resultText = JSON.stringify(msg.content)

      const toolName = msg.name || ""
      parts.push(`Tool ${toolName || "unknown"} returned: ${resultText}`)
      continue
    }

    if (msg.role === "user") {
      let text = ""
      if (typeof msg.content === "string") text = msg.content
      else if (Array.isArray(msg.content)) {
        const segments: string[] = []
        for (const part of msg.content) {
          if ((part as any).type === "text" && part.text) segments.push(part.text)
          else if ((part as any).type === "file") {
            const fp = part as any
            segments.push("[File: " + (fp.filename ?? "attachment") + " (" + (fp.mediaType ?? "unknown") + ")]")
          }
        }
        text = segments.join("\n")
      }
      if (text) parts.push(text)
    }
  }

  const joined = parts.join("\n\n")
  if (!hasTools) return joined

  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user")
  const userText = lastUserMsg
    ? (typeof lastUserMsg.content === "string" ? lastUserMsg.content :
       Array.isArray(lastUserMsg.content) ? lastUserMsg.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("") : "")
    : ""

  if (userText && needsTools(userText)) {
    return toolPrompt + "\n\n" + joined
  }

  return joined
}


function extractUserText(messages: any[]): string {
  const parts: string[] = []
  for (const msg of messages) {
    if (msg.role === "system") continue
    if (typeof msg.content === "string") parts.push(msg.content)
    else if (Array.isArray(msg.content)) {
      for (const part of msg.content) if (part.type === "text" && part.text) parts.push(part.text)
    }
  }
  return parts.join("\n")
}

interface ParsedToolCall { tool: string; parameters: Record<string, unknown> }

const FENCED_TOOL_REGEX = /```tool_json\s*\n?\s*(\{[\s\S]*?\})\}?\s*\n?\s*```/
const BARE_TOOL_REGEX = /\{\s*"tool"\s*:\s*"([^"]+)"\s*,\s*"parameters"\s*:\s*(\{[\s\S]*?\})\s*\}/
const XML_TOOL_REGEX = /<tool_call[^>]*>([\s\S]*?)<\/tool_call>/

function extractToolCall(text: string): ParsedToolCall | null {
  const fenced = FENCED_TOOL_REGEX.exec(text)
  if (fenced) return parseToolJson(fenced[1])

  const bare = BARE_TOOL_REGEX.exec(text)
  if (bare) {
    try { return { tool: bare[1], parameters: JSON.parse(bare[2]) } }
    catch { return null }
  }

  const xml = XML_TOOL_REGEX.exec(text)
  if (xml) return parseToolJson(xml[1])

  const fuzzy = text.match(/\{\s*"tool"\s*:\s*"([^"]+)"\s*,\s*"parameters"\s*:\s*\{([^}]*)\}/)
  if (fuzzy) {
    const repaired = `{"tool":"${fuzzy[1]}","parameters":{${fuzzy[2]}}}`
    const result = parseToolJson(repaired)
    if (result) return result
  }

  return null
}

function parseToolJson(raw: string): ParsedToolCall | null {
  try {
    let cleaned = raw.trim()
    const opens = (cleaned.match(/\{/g) || []).length
    const closes = (cleaned.match(/\}/g) || []).length
    if (opens > closes) cleaned += "}".repeat(opens - closes)
    const obj = JSON.parse(cleaned)
    if (obj.tool && typeof obj.tool === "string") return { tool: obj.tool, parameters: obj.parameters ?? {} }
    if (obj.name && typeof obj.name === "string") return { tool: obj.name, parameters: obj.arguments ?? {} }
    return null
  } catch { return null }
}

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
          await proxyStreamWithTools(controller, encoder, id, type, body, tools, (t) => { content += t })
        } else {
          let textCount = 0
          for await (const chunk of parseProviderSSE(type, body)) {
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
  body: ReadableStream<Uint8Array>,
  _tools: any[],
  onText: (t: string) => void,
) {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ""
  let tagBuffer = ""
  let accumulatedText = ""
  const hasTools = _tools && _tools.length > 0
  let inToolCall = false
  let toolIndex = 0
  let toolCallEmitted = false
  let currentTid = ""

  const flushText = (text: string) => {
    if (!text) return
    onText(text)
    controller.enqueue(encoder.encode(sseChunk({ id, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })))
  }

  const emitToolStart = (name: string, tid: string) => {
    if (toolCallEmitted) return
    toolCallEmitted = true
    currentTid = tid
    controller.enqueue(encoder.encode(sseChunk({
      id, choices: [{
        index: 0, delta: {
          role: "assistant",
          tool_calls: [{ index: toolIndex, id: tid, type: "function", function: { name, arguments: "" } }]
        }, finish_reason: null
      }]
    })))
  }

  const emitToolDelta = (delta: string) => {
    if (!toolCallEmitted) return
    controller.enqueue(encoder.encode(sseChunk({
      id, choices: [{
        index: 0, delta: {
          tool_calls: [{ index: toolIndex, delta: { arguments: delta } }]
        }, finish_reason: null
      }]
    })))
  }

  const emitFullToolCall = (tc: ParsedToolCall) => {
    if (toolCallEmitted) return
    const tid = `call_${Date.now()}_${toolIndex}`
    emitToolStart(tc.tool, tid)
    emitToolDelta(JSON.stringify(tc.parameters))
  }

  const checkTags = () => {
    const startMatch = tagBuffer.match(/<tool_call\s*(?:id=['"]?([^'"]+)['"]?\s*)?name=['"]?([^'"]+)['"]?\s*>/i)
    const endMatch = tagBuffer.match(/<\/tool_call\s*>/i)
    const indices: Array<{ type: string; idx: number; len: number; id?: string; name?: string }> = []
    if (startMatch) indices.push({ type: "start", idx: startMatch.index!, len: startMatch[0].length, id: startMatch[1], name: startMatch[2] })
    if (endMatch) indices.push({ type: "end", idx: endMatch.index!, len: endMatch[0].length })
    if (indices.length === 0) return

    indices.sort((a, b) => a.idx - b.idx)
    const first = indices[0]
    const before = tagBuffer.slice(0, first.idx)
    tagBuffer = tagBuffer.slice(first.idx + first.len)

    if (before) {
      if (inToolCall) emitToolDelta(before)
      else flushText(before)
    }

    if (first.type === "start") {
      inToolCall = true
      toolIndex++
      const tid = first.id || `call_${Date.now()}_${toolIndex}`
      emitToolStart(first.name!, tid)
    } else {
      inToolCall = false
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue
        const data = line.slice(6).trim()
        if (!data || data === "[DONE]") continue
        try {
          const parsed = JSON.parse(data)
          const text = extractTextFromEvent(type, parsed)
          if (text) {
            accumulatedText += text
            if (hasTools) {
              tagBuffer += text
              checkTags()
              const lastAngle = tagBuffer.lastIndexOf("<")
              if (lastAngle <= 0) {
                const safe = lastAngle === 0 ? "" : tagBuffer.slice(0, lastAngle)
                if (inToolCall) emitToolDelta(safe)
                else flushText(safe)
                tagBuffer = lastAngle === 0 ? "<" : tagBuffer.slice(lastAngle)
              }
            } else {
              flushText(text)
            }
          }
        } catch { /* skip */ }
      }
    }

    if (tagBuffer) {
      if (inToolCall) emitToolDelta(tagBuffer)
      else flushText(tagBuffer)
    }

    if (hasTools && !toolCallEmitted && accumulatedText.length > 10) {
      const tc = extractToolCall(accumulatedText)
      if (tc) {
        log.info(`[WebChat] ${type} found tool call via extractToolCall: ${tc.tool}`)
        emitFullToolCall(tc)
      }
    }
  } finally {
    reader.releaseLock()
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
    if (chunk.text) texts.push(chunk.text)
    if (chunk.thinking) texts.push(chunk.thinking)
  }
  const fullText = texts.join("")

  const choices: any[] = []
  if (tools?.length && !EXCLUDED_FROM_TOOLS.has(type)) {
    const tc = extractToolCall(fullText)
    if (tc) {
      log.info(`[WebChat] ${type} non-stream tool call found: ${tc.tool}`)
      choices.push({
        index: 0,
        message: { role: "assistant", content: null, tool_calls: [{ id: `call_${Date.now()}`, type: "function", function: { name: tc.tool, arguments: JSON.stringify(tc.parameters) } }] },
        finish_reason: "tool_calls",
      })
    } else {
      choices.push({ index: 0, message: { role: "assistant", content: fullText }, finish_reason: "stop" })
    }
  } else {
    choices.push({ index: 0, message: { role: "assistant", content: fullText }, finish_reason: "stop" })
  }

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
  tools?: any,
): Promise<ReadableStream<Uint8Array>> {
  switch (type) {
    case "deepseek-web": {
      const client = new DeepSeekWebClient({ cookie: creds.cookie, bearer: creds.bearer, userAgent: creds.userAgent })
      await client.init()
      const session = await client.createChatSession()
      return client.chatCompletions({ sessionId: session.chat_session_id, message, model })
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

function extractTextFromEvent(type: WebProviderType, parsed: any): string {
  switch (type) {
    case "deepseek-web":
    case "doubao-web":
    case "qwen-web":
    case "kimi-web":
    case "glm-web": {
      if (parsed.choices?.[0]?.delta?.content) return parsed.choices[0].delta.content
      else if (parsed.v && !parsed.p?.includes("reasoning")) return parsed.v
      else if (parsed.content) return parsed.content
      break
    }
    case "claude-web": {
      if (parsed.completion) return parsed.completion
      else if (parsed.delta?.text) return parsed.delta.text
      break
    }
    case "chatgpt-web": {
      const c = parsed.message?.content?.parts?.[0]
      if (typeof c === "string") return c
      break
    }
    case "gemini-web": {
      if (parsed.text) return parsed.text
      if (parsed.candidates?.[0]?.content?.parts?.[0]?.text) return parsed.candidates[0].content.parts[0].text
      break
    }
    case "grok-web": {
      if (parsed.contentDelta) return parsed.contentDelta
      if (parsed.text) return parsed.text
      if (parsed.candidates?.[0]?.content?.parts?.[0]?.text) return parsed.candidates[0].content.parts[0].text
      break
    }
  }
  return ""
}

async function* parseProviderSSE(type: WebProviderType, stream: ReadableStream<Uint8Array>): AsyncGenerator<{ text?: string; thinking?: string }> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let chatgptAccumulated = ""
  let grokAccumulated = ""
  let qwenCnAccumulated = ""
  let glmAccumulated = ""
  let mimoAccumulated = ""
  let mimoInsideThink = false

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
        } else if (type === "grok-web") {
          data = trimmed
        } else {
          continue
        }
        if (!data || data === "[DONE]") continue

        try {
          const parsed = JSON.parse(data)

          switch (type) {
            case "deepseek-web": {
              if ((parsed.p?.includes("reasoning") || parsed.type === "thinking") && typeof parsed.v === "string") {
                yield { thinking: parsed.v }
              } else if (parsed.type === "thinking" && typeof parsed.content === "string") {
                yield { thinking: parsed.content }
              } else if (typeof parsed.v === "string" && (!parsed.p || parsed.p.includes("content") || parsed.p.includes("choices"))) {
                yield { text: parsed.v }
              } else if (parsed.type === "text" && typeof parsed.content === "string") {
                yield { text: parsed.content }
              } else if (Array.isArray(parsed.v)) {
                for (const frag of parsed.v) {
                  if (frag.type === "THINKING" || frag.type === "reasoning") yield { thinking: frag.content || "" }
                  else if (frag.content) yield { text: frag.content }
                }
              } else if (parsed.choices?.[0]) {
                if (parsed.choices[0].delta?.reasoning_content) yield { thinking: parsed.choices[0].delta.reasoning_content }
                if (parsed.choices[0].delta?.content) yield { text: parsed.choices[0].delta.content }
              }
              break
            }
            case "doubao-web": {
              let delta = ""
              if (parsed.event_data) {
                let eventData = parsed.event_data
                if (typeof eventData === "string") {
                  try { eventData = JSON.parse(eventData) } catch { eventData = {} }
                }
                if (parsed.event_type === 2001) {
                  const msgContent = eventData?.message?.content
                  if (typeof msgContent === "string") {
                    try {
                      const contentObj = JSON.parse(msgContent)
                      delta = typeof contentObj.text === "string" ? contentObj.text : ""
                    } catch { delta = msgContent }
                  }
                } else if (parsed.event_type === 2003) {
                  delta = eventData.text || eventData.content || eventData.delta || ""
                }
              }
              if (!delta) delta = parsed.choices?.[0]?.delta?.content ?? parsed.v ?? parsed.text ?? parsed.content ?? parsed.delta ?? ""
              if (delta) {
                if (parsed.p?.includes("reasoning")) yield { thinking: delta }
                else yield { text: delta }
              }
              break
            }
            case "qwen-web": {
              const delta = parsed.choices?.[0]?.delta
              if (delta?.reasoning_content) yield { thinking: delta.reasoning_content }
              if (delta?.content) yield { text: delta.content }
              else if (parsed.text) yield { text: parsed.text }
              else if (parsed.content) yield { text: parsed.content }
              break
            }
            case "qwen-cn-web": {
              let delta = ""
              if (parsed.data?.messages && Array.isArray(parsed.data.messages)) {
                for (let i = parsed.data.messages.length - 1; i >= 0; i--) {
                  const msg = parsed.data.messages[i]
                  if (msg.content && typeof msg.content === "string") {
                    delta = msg.content
                    break
                  }
                }
              }
              if (!delta) {
                const d = parsed.choices?.[0]?.delta
                if (d?.reasoning_content) { yield { thinking: d.reasoning_content } }
                if (d?.content) delta = d.content
              }
              if (!delta) delta = parsed.data?.text ?? parsed.data?.content ?? parsed.communication?.text ?? parsed.text ?? parsed.content ?? ""
              if (typeof delta === "string" && delta) {
                if (delta.length > qwenCnAccumulated.length && delta.startsWith(qwenCnAccumulated)) {
                  const newPart = delta.slice(qwenCnAccumulated.length)
                  qwenCnAccumulated = delta
                  if (newPart) yield { text: newPart }
                } else if (delta !== qwenCnAccumulated) {
                  qwenCnAccumulated = delta
                  yield { text: delta }
                }
              }
              break
            }
            case "kimi-web": {
              if (parsed.type === "thinking" && typeof parsed.content === "string") yield { thinking: parsed.content }
              else if (parsed.text) yield { text: parsed.text }
              else if (parsed.content && typeof parsed.content === "string") yield { text: parsed.content }
              else if (parsed.choices?.[0]?.delta?.content) yield { text: parsed.choices[0].delta.content }
              break
            }
            case "glm-web":
            case "glm-intl-web": {
              let delta = ""
              if (parsed.parts && Array.isArray(parsed.parts)) {
                for (const part of parsed.parts) {
                  if (part?.content && Array.isArray(part.content)) {
                    for (const c of part.content) {
                      if (c?.type === "text" && typeof c.text === "string") { delta = c.text; break }
                    }
                  }
                  if (delta) break
                }
              }
              if (!delta) delta = parsed.text || parsed.content || parsed.delta || parsed.message || ""
              if (typeof delta === "string" && delta) {
                if (delta.length > glmAccumulated.length) {
                  const newDelta = delta.slice(glmAccumulated.length)
                  glmAccumulated = delta
                  if (newDelta) yield { text: newDelta }
                }
              }
              break
            }
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
            case "gemini-web": {
              if (parsed.text) yield { text: parsed.text }
              else if (parsed.candidates?.[0]?.content?.parts?.[0]?.text) yield { text: parsed.candidates[0].content.parts[0].text }
              break
            }
            case "grok-web": {
              const raw = parsed.contentDelta ?? parsed.textDelta ?? parsed.text ?? parsed.content ?? parsed.delta
              if (typeof raw === "string" && raw) {
                if (raw.length > grokAccumulated.length && raw.startsWith(grokAccumulated)) {
                  const newDelta = raw.slice(grokAccumulated.length)
                  grokAccumulated = raw
                  if (newDelta) yield { text: newDelta }
                } else if (raw !== grokAccumulated) {
                  grokAccumulated = raw
                  yield { text: raw }
                }
              } else if (parsed.candidates?.[0]?.content?.parts?.[0]?.text) {
                yield { text: parsed.candidates[0].content.parts[0].text }
              }
              break
            }
            case "perplexity-web": {
              if (parsed.text) yield { text: parsed.text }
              else if (parsed.content) yield { text: typeof parsed.content === "string" ? parsed.content : JSON.stringify(parsed.content) }
              else if (parsed.choices?.[0]?.delta?.content) yield { text: parsed.choices[0].delta.content }
              break
            }
            case "xiaomimo-web": {
              if (parsed.content && typeof parsed.content === "string") {
                let content = parsed.content
                if (content.includes("<think")) mimoInsideThink = true
                if (mimoInsideThink) {
                  const thinkEnd = content.indexOf("</think")
                  if (thinkEnd !== -1) {
                    content = content.slice(thinkEnd + 8)
                    mimoInsideThink = false
                  } else {
                    break
                  }
                }
                content = content.replace(/\x00/g, "")
                if (content) yield { text: content }
                break
              }
              const delta = parsed.choices?.[0]?.delta?.content ?? parsed.text ?? parsed.delta
              if (typeof delta === "string" && delta) {
                if (delta.length > mimoAccumulated.length) {
                  const newDelta = delta.slice(mimoAccumulated.length)
                  mimoAccumulated = delta
                  if (newDelta) yield { text: newDelta }
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
