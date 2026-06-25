import type { WebProviderType } from "../types.js"
import { GeminiWebClient } from "../clients/gemini-web-client.js"
import { GLMIntlWebClient } from "../clients/glm-intl-web-client.js"
import { GLMWebClient } from "../clients/glm-web-client.js"
import { GrokWebClient } from "../clients/grok-web-client.js"
import { PerplexityWebClient } from "../clients/perplexity-web-client.js"
import { QwenCNWebClient } from "../clients/qwen-cn-web-client.js"
import { QwenWebClient } from "../clients/qwen-web-client.js"
import { createChatGPTWebStream } from "./chatgpt-web-stream.js"
import { createDeepSeekWebStream } from "./deepseek-web-stream.js"
import { createClaudeWebStream } from "./claude-web-stream.js"
import { createGenericWebStream } from "./generic-web-stream.js"
import { createKimiWebStream } from "./kimi-web-stream.js"
import { createDoubaoWebStream, createXiaomiMimoWebStream } from "./special-web-parsers.js"

type StreamCreator = (credentials: unknown) => (params: {
  message: string
  model?: string
  signal?: AbortSignal
}) => AsyncGenerator<string> | Promise<AsyncGenerator<string>>

const factories: Record<WebProviderType, StreamCreator> = {
  "chatgpt-web": (creds) => createChatGPTWebStream(creds as Parameters<typeof createChatGPTWebStream>[0]),
  "claude-web": (creds) => createClaudeWebStream(creds as Parameters<typeof createClaudeWebStream>[0]),
  "deepseek-web": (creds) => createDeepSeekWebStream(creds as Parameters<typeof createDeepSeekWebStream>[0]),
  "doubao-web": createDoubaoWebStream,
  "qwen-web": createGenericWebStream(
    (creds) => new QwenWebClient(creds as ConstructorParameters<typeof QwenWebClient>[0]),
  ),
  "qwen-cn-web": createGenericWebStream(
    (creds) => new QwenCNWebClient(creds as ConstructorParameters<typeof QwenCNWebClient>[0]),
  ),
  "kimi-web": createKimiWebStream,
  "gemini-web": createGenericWebStream(
    (creds) => new GeminiWebClient(creds as ConstructorParameters<typeof GeminiWebClient>[0]),
  ),
  "grok-web": createGenericWebStream(
    (creds) => new GrokWebClient(creds as ConstructorParameters<typeof GrokWebClient>[0]),
  ),
  "glm-web": createGenericWebStream(
    (creds) => new GLMWebClient(creds as ConstructorParameters<typeof GLMWebClient>[0]),
  ),
  "glm-intl-web": createGenericWebStream(
    (creds) => new GLMIntlWebClient(creds as ConstructorParameters<typeof GLMIntlWebClient>[0]),
  ),
  "perplexity-web": createGenericWebStream(
    (creds) => new PerplexityWebClient(creds as ConstructorParameters<typeof PerplexityWebClient>[0]),
  ),
  "xiaomimo-web": createXiaomiMimoWebStream,
}

export function getWebStreamFactory(type: WebProviderType): StreamCreator {
  return factories[type] ?? factories["deepseek-web"]
}

export function listSupportedProviders(): WebProviderType[] {
  return Object.keys(factories) as WebProviderType[]
}
