import crypto from "node:crypto"

const XIAOMIMO_API_BASE = "https://aistudio.xiaomimimo.com"

const MODEL_MAP: Record<string, string> = {
  "xiaomimo-chat": "mimo-v2-flash-studio",
  "mimo-v2-pro": "mimo-v2-flash-studio",
}

export class XiaomiMimoWebClient {
  private cookie: string
  private bearer: string
  private userAgent: string
  private conversationId: string | null = null

  constructor(creds: { cookie: string; bearer?: string; userAgent?: string }) {
    this.cookie = creds.cookie || ""
    this.bearer = creds.bearer || ""
    this.userAgent = creds.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
    if (!this.bearer) {
      const m = this.cookie.match(/serviceToken="([^"]*)"/)
      if (m) this.bearer = m[1]
    }
  }

  async init() {}

  async chatCompletions(params: {
    message: string
    model?: string
    signal?: AbortSignal
  }): Promise<ReadableStream<Uint8Array>> {
    const botPhMatch = this.cookie.match(/xiaomichatbot_ph="([^"]*)"/)
    const botPh = botPhMatch?.[1] || ""
    const url = botPh
      ? `${XIAOMIMO_API_BASE}/open-apis/bot/chat?xiaomichatbot_ph=${encodeURIComponent(botPh)}`
      : `${XIAOMIMO_API_BASE}/open-apis/bot/chat`

    const modelInternal = MODEL_MAP[params.model || ""] || params.model || "mimo-v2-flash-studio"
    const msgId = crypto.randomUUID().replace(/-/g, "")
    const convId = this.conversationId || "0"

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream, */*",
        Cookie: this.cookie,
        "User-Agent": this.userAgent,
        ...(this.bearer ? { Authorization: `Bearer ${this.bearer}` } : {}),
        Referer: `${XIAOMIMO_API_BASE}/`,
        Origin: XIAOMIMO_API_BASE,
        "x-timezone": "Asia/Shanghai",
        bot_ph: botPh,
      },
      body: JSON.stringify({
        msgId,
        conversationId: convId,
        query: params.message,
        isEditedQuery: false,
        modelConfig: {
          enableThinking: false,
          webSearchStatus: "disabled",
          model: modelInternal,
          temperature: 0.8,
          topP: 0.95,
        },
        multiMedias: [],
      }),
      signal: params.signal,
    })

    if (!res.ok) throw new Error(`XiaomiMiMo API error (${res.status}): ${await res.text()}`)
    if (!res.body) throw new Error("XiaomiMiMo returned empty response")

    const clone = res.clone()
    clone.text().then(t => {
      const convMatch = t.match(/conversationId['":\s]+['"]?([a-f0-9]+)/)
      if (convMatch) this.conversationId = convMatch[1]
    }).catch(() => {})

    return res.body
  }
}