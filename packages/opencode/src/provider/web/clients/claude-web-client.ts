import crypto from "node:crypto"

const CLAUDE_BASE_URL = "https://claude.ai"

export class ClaudeWebClient {
  private cookie: string
  private userAgent: string
  private orgId = ""
  private deviceId: string

  constructor(creds: { cookie: string; userAgent?: string }) {
    this.cookie = creds.cookie || ""
    this.userAgent = creds.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
    this.deviceId = this.extractDeviceId() || crypto.randomUUID()
  }

  private extractDeviceId(): string | undefined {
    for (const part of this.cookie.split(";")) {
      const [n, ...v] = part.trim().split("=")
      if (n === "anthropic-device-id") return v.join("=")
    }
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Cookie: this.cookie,
      "User-Agent": this.userAgent,
      Accept: "text/event-stream",
      Referer: "https://claude.ai/",
      Origin: "https://claude.ai",
      "anthropic-client-platform": "web_claude_ai",
      "anthropic-device-id": this.deviceId,
    }
  }

  async init() {
    try {
      const res = await fetch(`${CLAUDE_BASE_URL}/api/organizations`, { headers: this.headers() })
      if (res.ok) {
        const orgs = await res.json()
        if (orgs?.[0]?.uuid) this.orgId = orgs[0].uuid
      }
    } catch { /* non-critical */ }
  }

  async createConversation(): Promise<string> {
    const url = this.orgId
      ? `${CLAUDE_BASE_URL}/api/organizations/${this.orgId}/chat_conversations`
      : `${CLAUDE_BASE_URL}/api/chat_conversations`
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ name: `Conversation ${new Date().toISOString()}`, uuid: crypto.randomUUID() }),
    })
    if (!res.ok) throw new Error(`Claude conversation creation failed (${res.status}): ${await res.text()}`)
    const data = await res.json()
    return data.uuid
  }

  async chatCompletions(params: {
    message: string
    model?: string
    signal?: AbortSignal
  }): Promise<ReadableStream<Uint8Array>> {
    if (!this.orgId) await this.init()

    const convId = await this.createConversation()
    const url = this.orgId
      ? `${CLAUDE_BASE_URL}/api/organizations/${this.orgId}/chat_conversations/${convId}/completion`
      : `${CLAUDE_BASE_URL}/api/chat_conversations/${convId}/completion`

    const body = JSON.stringify({
      prompt: params.message,
      parent_message_uuid: "00000000-0000-4000-8000-000000000000",
      model: params.model || "claude-sonnet-4-6",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      rendering_mode: "messages",
      attachments: [],
      files: [],
      locale: "en-US",
      personalized_styles: [],
      sync_sources: [],
      tools: [],
    })

    const res = await fetch(url, { method: "POST", headers: this.headers(), body, signal: params.signal })
    if (!res.ok) throw new Error(`Claude API error (${res.status}): ${await res.text()}`)
    return res.body! || (async function* () { yield "" })() as any
  }
}