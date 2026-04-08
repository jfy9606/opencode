export interface WebAuthCredentials {
  accessToken: string
  cookie: string
  userAgent: string
  bearer?: string
}

export type WebProviderType =
  | "chatgpt-web"
  | "claude-web"
  | "deepseek-web"
  | "doubao-web"
  | "qwen-web"
  | "qwen-cn-web"
  | "kimi-web"
  | "gemini-web"
  | "grok-web"
  | "glm-web"
  | "glm-intl-web"
  | "perplexity-web"
  | "xiaomimo-web"

export interface WebAuthProviderConfig {
  type: WebProviderType
  credentials?: WebAuthCredentials
}

export interface WebLoginOptions {
  onProgress: (msg: string) => void
  openUrl: (url: string) => Promise<boolean>
}

export interface WebChatOptions {
  message: string
  conversationId?: string
  parentMessageId?: string
  model?: string
  signal?: AbortSignal
}
