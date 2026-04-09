import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { streamSSE } from "hono/streaming"
import { Config } from "../../config/config"
import { Provider } from "../../provider/provider"
import { ModelsDev } from "../../provider/models"
import { ProviderAuth } from "../../provider/auth"
import { Auth } from "../../auth"
import { ProviderID } from "../../provider/schema"
import { WEB_PROVIDERS, ZERO_COST, loginWebProvider } from "../../provider/web/index"
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
import { mapValues } from "remeda"
import { errors } from "../error"
import { lazy } from "../../util/lazy"
import { Log } from "../../util/log"

const log = Log.create({ service: "server" })

export const ProviderRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List providers",
        description: "Get a list of all available AI providers, including both available and connected ones.",
        operationId: "provider.list",
        responses: {
          200: {
            description: "List of providers",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    all: Provider.Info.array(),
                    default: z.record(z.string(), z.string()),
                    connected: z.array(z.string()),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const config = await Config.get()
        const disabled = new Set(config.disabled_providers ?? [])
        const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined

        const allProviders = await ModelsDev.get()
        const filteredProviders: Record<string, (typeof allProviders)[string]> = {}
        for (const [key, value] of Object.entries(allProviders)) {
          if ((enabled ? enabled.has(key) : true) && !disabled.has(key)) {
            filteredProviders[key] = value
          }
        }

        const connected = await Provider.list()
        const providers = Object.assign(
          mapValues(filteredProviders, (x) => Provider.fromModelsDevProvider(x)),
          connected,
        )

        for (const [id, wp] of Object.entries(WEB_PROVIDERS)) {
          if (id in providers) continue
          if (disabled.has(id)) continue
          providers[id] = {
            id,
            name: wp.name,
            source: "custom" as const,
            env: [],
            options: {},
            models: Object.fromEntries(
              wp.models.map((m) => [
                m.id,
                {
                  id: m.id,
                  name: m.name,
                  api: { id: m.id, url: `/provider/${id}`, npm: "@ai-sdk/openai-compatible" },
                  cost: ZERO_COST,
                  limit: { context: m.contextWindow, output: m.maxTokens },
                  status: "active",
                  options: {},
                  headers: {},
                  release_date: "",
                  variants: {},
                  capabilities: {
                    temperature: !m.reasoning,
                    reasoning: m.reasoning,
                    attachment: m.input.includes("image"),
                    toolcall: true,
                    input: {
                      text: m.input.includes("text"),
                      image: m.input.includes("image"),
                      video: false,
                      pdf: false,
                    },
                    output: { text: true, audio: false, image: false, video: false, pdf: false },
                    interleaved: false,
                  },
                },
              ]),
            ),
          } as unknown as (typeof providers)[string]
        }

        const connectedKeys = Object.keys(connected)
        const allAuth = await Auth.all()
        for (const id of Object.keys(WEB_PROVIDERS)) {
          if (connectedKeys.includes(id)) continue
          if (allAuth[id]) connectedKeys.push(id)
        }

        return c.json({
          all: Object.values(providers),
          default: mapValues(providers, (item) => Provider.sort(Object.values(item.models))[0].id),
          connected: connectedKeys,
        })
      },
    )
    .get(
      "/auth",
      describeRoute({
        summary: "Get provider auth methods",
        description: "Retrieve available authentication methods for all AI providers.",
        operationId: "provider.auth",
        responses: {
          200: {
            description: "Provider auth methods",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), z.array(ProviderAuth.Method))),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await ProviderAuth.methods())
      },
    )
    .post(
      "/:providerID/oauth/authorize",
      describeRoute({
        summary: "OAuth authorize",
        description: "Initiate OAuth authorization for a specific AI provider to get an authorization URL.",
        operationId: "provider.oauth.authorize",
        responses: {
          200: {
            description: "Authorization URL and method",
            content: {
              "application/json": {
                schema: resolver(ProviderAuth.Authorization.optional()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          providerID: ProviderID.zod.meta({ description: "Provider ID" }),
        }),
      ),
      validator(
        "json",
        z.object({
          method: z.number().meta({ description: "Auth method index" }),
          inputs: z.record(z.string(), z.string()).optional().meta({ description: "Prompt inputs" }),
        }),
      ),
      async (c) => {
        const providerID = c.req.valid("param").providerID
        const { method, inputs } = c.req.valid("json")
        const result = await ProviderAuth.authorize({
          providerID,
          method,
          inputs,
        })
        return c.json(result)
      },
    )
    .post(
      "/:providerID/oauth/callback",
      describeRoute({
        summary: "OAuth callback",
        description: "Handle the OAuth callback from a provider after user authorization.",
        operationId: "provider.oauth.callback",
        responses: {
          200: {
            description: "OAuth callback processed successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          providerID: ProviderID.zod.meta({ description: "Provider ID" }),
        }),
      ),
      validator(
        "json",
        z.object({
          method: z.number().meta({ description: "Auth method index" }),
          code: z.string().optional().meta({ description: "OAuth authorization code" }),
        }),
      ),
      async (c) => {
        const providerID = c.req.valid("param").providerID
        const { method, code } = c.req.valid("json")
        await ProviderAuth.callback({
          providerID,
          method,
          code,
        })
        return c.json(true)
      },
    )
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

        const prompt = buildWebPrompt(messages, tools)

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

function buildWebPrompt(messages: any[], tools: any[]): string {
  const parts: string[] = []
  let hasSystem = false
  let toolSection = ""

  if (tools.length > 0) {
    const toolDefs: string[] = []
    for (const t of tools) {
      const fn = t.function ?? t
      let def = "### " + fn.name + "\n"
      if (fn.description) def += fn.description + "\n"
      if (fn.parameters?.properties && Object.keys(fn.parameters.properties).length > 0) {
        def += "Parameters (JSON schema):\n```json\n" + JSON.stringify(fn.parameters, null, 2) + "\n```\n"
      }
      toolDefs.push(def)
    }
    toolSection = "\n## Available Tools\n\nYou have access to the following tools. When you need to use one, respond with this exact XML format:\n\n<tool_call id=\"call_N\" name=\"TOOL_NAME\">\n{\"param1\": \"value1\", \"param2\": \"value2\"}\n\n" + toolDefs.join("\n") + "After using a tool, wait for the <tool_call> before continuing.\n"
  }

  for (const msg of messages) {
    if (msg.role === "system") {
      hasSystem = true
      let sys = typeof msg.content === "string" ? msg.content : ""
      if (Array.isArray(msg.content)) {
        sys = msg.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n")
      }
      if (toolSection) sys += "\n\n" + toolSection
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
            calls.push("<tool_call id=\"" + tc.toolCallId + "\" name=\"" + tc.toolName + "\">" + (typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input)) + "</tool_call>")
          } else if ((part as any).type?.startsWith("tool-")) {
            const tp = part as any
            if (tp.state === "output-available" || tp.state === "output-error") {
              const outText = tp.state === "output-error"
                ? "[Error] " + (tp.errorText ?? "")
                : (typeof tp.output === "string" ? tp.output : JSON.stringify(tp.output ?? ""))
              parts.push("<tool_response id=\"" + tp.toolCallId + "\" name=\"" + tp.tool + "\">\n" + outText + "\n\n")
            }
          }
        }
      }

      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          calls.push("<tool_call id=\"" + tc.id + "\" name=\"" + tc.function.name + "\">" + tc.function.arguments)
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

      const toolId = msg.tool_call_id || msg.toolCallId || msg.name || "unknown"
      const toolName = msg.name || ""
      parts.push("<tool_response id=\"" + toolId + "\" name=\"" + toolName + "\">\n" + resultText + "\n\n")
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

  if (!hasSystem && toolSection) parts.unshift(toolSection)

  return parts.join("\n\n")
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
  const hasTools = _tools && _tools.length > 0
  let inToolCall = false
  let toolIndex = 0

  const flushText = (text: string) => {
    if (!text) return
    onText(text)
    controller.enqueue(encoder.encode(sseChunk({ id, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })))
  }

  const emitToolStart = (name: string, tid: string) => {
    controller.enqueue(encoder.encode(sseChunk({
      id, choices: [{
        index: 0, delta: {
          tool_calls: [{ index: toolIndex, id: tid, type: "function", function: { name, arguments: "" } }]
        }, finish_reason: null
      }]
    })))
  }

  const emitToolDelta = (delta: string) => {
    controller.enqueue(encoder.encode(sseChunk({
      id, choices: [{
        index: 0, delta: {
          tool_calls: [{ index: toolIndex, delta: { arguments: delta } }]
        }, finish_reason: null
      }]
    })))
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
  if (tools?.length && fullText.includes("<tool_call")) {
    const tcRegex = /<tool_call\s+(?:id=['"]?([^'"]*)['"]?\s+)?name=['"]?([^'"]+)['"]?\s*([\s\S]*?)<\/tool_call>/gi
    let match: RegExpExecArray | null
    let idx = 0
    while ((match = tcRegex.exec(fullText)) !== null) {
      const argsRaw = match[3]?.trim() ?? "{}"
      let args = argsRaw
      if (args.startsWith("```json")) args = args.slice(7).trim()
      if (args.endsWith("```")) args = args.slice(0, -3).trim()
      choices.push({
        index: idx++,
        message: { role: "assistant", content: null, tool_calls: [{ id: match[1] || `call_${idx}`, type: "function", function: { name: match[2], arguments: args } }] },
        finish_reason: "tool_calls",
      })
    }
    if (choices.length === 0) {
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
