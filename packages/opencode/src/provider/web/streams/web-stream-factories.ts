import type { WebProviderType } from "../types.js"
import { createChatGPTWebStream } from "./chatgpt-web-stream.js"
import { createDeepSeekWebStream } from "./deepseek-web-stream.js"
import { createClaudeWebStream } from "./claude-web-stream.js"

type StreamCreator = (credentials: unknown) => (params: {
  message: string
  model?: string
  signal?: AbortSignal
}) => AsyncGenerator<string>

const factories: Record<WebProviderType, StreamCreator> = {
  "chatgpt-web": (creds) => createChatGPTWebStream(creds as Parameters<typeof createChatGPTWebStream>[0]),
  "claude-web": (creds) => createClaudeWebStream(creds as Parameters<typeof createClaudeWebStream>[0]),
  "deepseek-web": (creds) => createDeepSeekWebStream(creds as Parameters<typeof createDeepSeekWebStream>[0]),
  "doubao-web": (creds) => createDeepSeekWebStream(creds),
  "qwen-web": (creds) => createDeepSeekWebStream(creds),
  "kimi-web": (creds) => createDeepSeekWebStream(creds),
  "gemini-web": (creds) => createDeepSeekWebStream(creds),
  "grok-web": (creds) => createDeepSeekWebStream(creds),
  "glm-web": (creds) => createDeepSeekWebStream(creds),
}

export function getWebStreamFactory(type: WebProviderType): StreamCreator {
  return factories[type] ?? factories["deepseek-web"]
}

export function listSupportedProviders(): WebProviderType[] {
  return Object.keys(factories) as WebProviderType[]
}
