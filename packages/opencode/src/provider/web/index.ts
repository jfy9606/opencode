import type { WebAuthCredentials, WebProviderType } from "./types.js"
import { loginWebProvider } from "./browser.js"

export interface WebProviderModel {
  id: string
  name: string
  reasoning: boolean
  input: string[]
  contextWindow: number
  maxTokens: number
}

export const WEB_PROVIDERS: Record<
  WebProviderType,
  {
    name: string
    baseUrl: string
    models: WebProviderModel[]
    apiEndpoint: string
  }
> = {
  "chatgpt-web": {
    name: "ChatGPT (Web)",
    baseUrl: "https://chatgpt.com",
    apiEndpoint: "/backend-api/conversation",
    models: [
      {
        id: "gpt-4",
        name: "GPT-4 (Web)",
        reasoning: false,
        input: ["text", "image"],
        contextWindow: 128_000,
        maxTokens: 4096,
      },
      {
        id: "gpt-4-turbo",
        name: "GPT-4 Turbo (Web)",
        reasoning: false,
        input: ["text", "image"],
        contextWindow: 128_000,
        maxTokens: 4096,
      },
      {
        id: "gpt-3.5-turbo",
        name: "GPT-3.5 Turbo (Web)",
        reasoning: false,
        input: ["text"],
        contextWindow: 16_000,
        maxTokens: 4096,
      },
    ],
  },
  "claude-web": {
    name: "Claude (Web)",
    baseUrl: "https://claude.ai",
    apiEndpoint: "/api/organizations/",
    models: [
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6 (Web)",
        reasoning: false,
        input: ["text", "image"],
        contextWindow: 200_000,
        maxTokens: 8192,
      },
      {
        id: "claude-opus-4-6",
        name: "Claude Opus 4.6 (Web)",
        reasoning: false,
        input: ["text", "image"],
        contextWindow: 200_000,
        maxTokens: 16_384,
      },
      {
        id: "claude-haiku-4-6",
        name: "Claude Haiku 4.6 (Web)",
        reasoning: false,
        input: ["text", "image"],
        contextWindow: 200_000,
        maxTokens: 8192,
      },
    ],
  },
  "deepseek-web": {
    name: "DeepSeek (Web)",
    baseUrl: "https://chat.deepseek.com",
    apiEndpoint: "/api/chat/completion",
    models: [
      {
        id: "deepseek-chat",
        name: "DeepSeek V3 (Web)",
        reasoning: false,
        input: ["text"],
        contextWindow: 64_000,
        maxTokens: 8192,
      },
      {
        id: "deepseek-reasoner",
        name: "DeepSeek R1 (Web)",
        reasoning: true,
        input: ["text"],
        contextWindow: 64_000,
        maxTokens: 8192,
      },
    ],
  },
  "doubao-web": {
    name: "Doubao (Web)",
    baseUrl: "https://www.doubao.com",
    apiEndpoint: "/api/chat",
    models: [
      {
        id: "doubao-seed-2.0",
        name: "Doubao-Seed 2.0 (Web)",
        reasoning: true,
        input: ["text"],
        contextWindow: 64_000,
        maxTokens: 8192,
      },
      {
        id: "doubao-pro",
        name: "Doubao Pro (Web)",
        reasoning: false,
        input: ["text"],
        contextWindow: 64_000,
        maxTokens: 8192,
      },
    ],
  },
  "qwen-web": {
    name: "Qwen (Web)",
    baseUrl: "https://chat.qwen.ai",
    apiEndpoint: "/api/v1/chat/completions",
    models: [
      {
        id: "qwen3.5-plus",
        name: "Qwen 3.5 Plus (Web)",
        reasoning: false,
        input: ["text"],
        contextWindow: 32_000,
        maxTokens: 8192,
      },
      {
        id: "qwen3.5-turbo",
        name: "Qwen 3.5 Turbo (Web)",
        reasoning: false,
        input: ["text"],
        contextWindow: 32_000,
        maxTokens: 8192,
      },
    ],
  },
  "kimi-web": {
    name: "Kimi (Web)",
    baseUrl: "https://www.kimi.com",
    apiEndpoint: "/api/chat",
    models: [
      {
        id: "moonshot-v1-8k",
        name: "Moonshot v1 8K (Web)",
        reasoning: false,
        input: ["text"],
        contextWindow: 8000,
        maxTokens: 4096,
      },
      {
        id: "moonshot-v1-32k",
        name: "Moonshot v1 32K (Web)",
        reasoning: false,
        input: ["text"],
        contextWindow: 32_000,
        maxTokens: 4096,
      },
      {
        id: "moonshot-v1-128k",
        name: "Moonshot v1 128K (Web)",
        reasoning: false,
        input: ["text"],
        contextWindow: 128_000,
        maxTokens: 4096,
      },
    ],
  },
  "gemini-web": {
    name: "Gemini (Web)",
    baseUrl: "https://gemini.google.com",
    apiEndpoint: "/_api/google/gemini/v1/chat",
    models: [
      {
        id: "gemini-3.1-flash",
        name: "Gemini 3.1 Flash (Web)",
        reasoning: false,
        input: ["text", "image"],
        contextWindow: 1_048_576,
        maxTokens: 65_536,
      },
      {
        id: "gemini-3.1-pro",
        name: "Gemini 3.1 Pro (Web)",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1_048_576,
        maxTokens: 65_536,
      },
      {
        id: "gemini-3.1-thinking",
        name: "Gemini 3.1 Thinking (Web)",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 2_000_000,
        maxTokens: 65_536,
      },
    ],
  },
  "grok-web": {
    name: "Grok (Web)",
    baseUrl: "https://grok.com",
    apiEndpoint: "/rest/app-chat/conversations/new",
    models: [
      {
        id: "grok-1",
        name: "Grok 1 (Web)",
        reasoning: false,
        input: ["text"],
        contextWindow: 32_000,
        maxTokens: 4096,
      },
      {
        id: "grok-2",
        name: "Grok 2 (Web)",
        reasoning: false,
        input: ["text"],
        contextWindow: 32_000,
        maxTokens: 4096,
      },
    ],
  },
  "glm-web": {
    name: "GLM (Web)",
    baseUrl: "https://chatglm.cn",
    apiEndpoint: "/chat/completion",
    models: [
      {
        id: "glm-4-plus",
        name: "GLM-4 Plus (Web)",
        reasoning: false,
        input: ["text"],
        contextWindow: 128_000,
        maxTokens: 4096,
      },
      {
        id: "glm-4-think",
        name: "GLM-4 Think (Web)",
        reasoning: true,
        input: ["text"],
        contextWindow: 128_000,
        maxTokens: 4096,
      },
    ],
  },
  "qwen-cn-web": {
    name: "Qwen CN (Web)",
    baseUrl: "https://chat2.qianwen.com",
    apiEndpoint: "/api/v2/chat",
    models: [
      {
        id: "Qwen3.5-Plus",
        name: "Qwen 3.5 Plus 国内版 (Web)",
        reasoning: false,
        input: ["text"],
        contextWindow: 128_000,
        maxTokens: 4096,
      },
      {
        id: "Qwen3.5-Turbo",
        name: "Qwen 3.5 Turbo 国内版 (Web)",
        reasoning: false,
        input: ["text"],
        contextWindow: 32_000,
        maxTokens: 4096,
      },
    ],
  },
  "glm-intl-web": {
    name: "GLM Intl (Web)",
    baseUrl: "https://chat.z.ai",
    apiEndpoint: "/chatglm/backend-api/assistant/stream",
    models: [
      {
        id: "glm-4-plus",
        name: "GLM-4 Plus Intl (Web)",
        reasoning: false,
        input: ["text"],
        contextWindow: 128_000,
        maxTokens: 4096,
      },
      {
        id: "glm-4-zero",
        name: "GLM-4 Zero Intl (Web)",
        reasoning: true,
        input: ["text"],
        contextWindow: 128_000,
        maxTokens: 4096,
      },
    ],
  },
  "perplexity-web": {
    name: "Perplexity (Web)",
    baseUrl: "https://www.perplexity.ai",
    apiEndpoint: "/api/ask",
    models: [
      {
        id: "perplexity-web",
        name: "Perplexity Sonar (Web)",
        reasoning: false,
        input: ["text"],
        contextWindow: 128_000,
        maxTokens: 4096,
      },
      {
        id: "perplexity-pro",
        name: "Perplexity Pro (Web)",
        reasoning: false,
        input: ["text"],
        contextWindow: 128_000,
        maxTokens: 8192,
      },
    ],
  },
  "xiaomimo-web": {
    name: "MiMo (Web)",
    baseUrl: "https://aistudio.xiaomimimo.com",
    apiEndpoint: "/open-apis/bot/chat",
    models: [
      {
        id: "xiaomimo-chat",
        name: "MiMo Chat (Web)",
        reasoning: false,
        input: ["text"],
        contextWindow: 128_000,
        maxTokens: 4096,
      },
      {
        id: "mimo-v2-pro",
        name: "MiMo V2 Pro (Web)",
        reasoning: true,
        input: ["text"],
        contextWindow: 128_000,
        maxTokens: 8192,
      },
    ],
  },
}

export const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

export function createWebFetch(credentials: WebAuthCredentials, providerType: WebProviderType) {
  const provider = WEB_PROVIDERS[providerType]

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url

    const headers = new Headers(init?.headers)
    if (!headers.has("cookie")) {
      headers.set("cookie", credentials.cookie)
    }
    if (!headers.has("user-agent")) {
      headers.set("user-agent", credentials.userAgent)
    }

    if (providerType === "chatgpt-web" && url.includes("/backend-api/")) {
      headers.set("authorization", `Bearer ${credentials.accessToken}`)
      headers.set("content-type", "application/json")
      headers.set("accept", "text/event-stream")
    }

    return fetch(input, { ...init, headers })
  }
}

export async function authenticate(
  type: WebProviderType,
  opts: { onProgress?: (msg: string) => void; openUrl?: (url: string) => Promise<boolean> } = {},
): Promise<WebAuthCredentials> {
  return loginWebProvider(type, {
    onProgress: opts.onProgress ?? console.log,
    openUrl: opts.openUrl ?? (async () => true),
  })
}

export { loginWebProvider }
export type { WebAuthCredentials, WebLoginOptions, WebProviderType } from "./types.js"

export * from "./clients/index.js"
export * from "./streams/index.js"
