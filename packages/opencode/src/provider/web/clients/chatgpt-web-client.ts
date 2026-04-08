import crypto from "node:crypto"

const CHATGPT_API_URL = "https://chatgpt.com"

export class ChatGPTWebClient {
  private cookie: string
  private userAgent: string
  private deviceId: string

  constructor(creds: { cookie: string; accessToken?: string; userAgent?: string }) {
    this.cookie = creds.cookie || ""
    this.userAgent = creds.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
    this.deviceId = this.extractDeviceId() || crypto.randomUUID()
  }

  private extractDeviceId(): string | undefined {
    for (const part of this.cookie.split(";")) {
      const [n, ...v] = part.trim().split("=")
      if (n === "oai-device-id") return v.join("=")
    }
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "oai-device-id": this.deviceId,
      "oai-language": "en-US",
      Referer: "https://chatgpt.com/",
      Origin: CHATGPT_API_URL,
      "User-Agent": this.userAgent,
      Cookie: this.cookie,
    }
  }

  async init() {}

  async chatCompletions(params: {
    message: string
    model?: string
    signal?: AbortSignal
  }): Promise<ReadableStream<Uint8Array>> {
    const messageId = crypto.randomUUID()
    const conversationId = crypto.randomUUID()
    const parentId = crypto.randomUUID()

    const body = JSON.stringify({
      action: "next",
      messages: [{
        id: messageId,
        author: { role: "user" },
        content: { content_type: "text", parts: [params.message] },
      }],
      parent_message_id: parentId,
      model: params.model || "auto",
      timezone_offset_min: new Date().getTimezoneOffset(),
      suggestions: [],
      history_and_training_disabled: true,
      conversation_mode: { kind: "primary_assistant" },
      force_paragen: false,
      force_rate_limit: false,
      websocket_request_id: crypto.randomUUID(),
    })

    const res = await fetch(`${CHATGPT_API_URL}/backend-api/conversation`, {
      method: "POST",
      headers: this.headers(),
      body,
      signal: params.signal,
    })

    if (!res.ok) throw new Error(`ChatGPT API error (${res.status}): ${await res.text()}`)
    return res.body! || (async function* () { yield "" })() as any
  }
}