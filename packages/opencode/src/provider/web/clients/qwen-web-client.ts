import crypto from "node:crypto"

const QWEN_API_BASE = "https://chat.qwen.ai"

export class QwenWebClient {
  private cookie: string
  private userAgent: string

  constructor(creds: { cookie: string; userAgent?: string }) {
    this.cookie = creds.cookie || ""
    this.userAgent = creds.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
  }

  async init() {}

  async chatCompletions(params: {
    message: string
    model?: string
    signal?: AbortSignal
  }): Promise<ReadableStream<Uint8Array>> {
    const createRes = await fetch(`${QWEN_API_BASE}/api/v2/chats/new`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: this.cookie },
      body: "{}",
      signal: params.signal,
    })
    if (!createRes.ok) throw new Error(`Qwen chat creation failed (${createRes.status}): ${await createRes.text()}`)
    const chatData = await createRes.json()
    const chatId = chatData.data?.id ?? chatData.chat_id ?? chatData.id
    if (!chatId) throw new Error("Qwen: no chat_id in response")

    const fid = crypto.randomUUID()
    const res = await fetch(`${QWEN_API_BASE}/api/v2/chat/completions?chat_id=${chatId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", Cookie: this.cookie },
      body: JSON.stringify({
        stream: true,
        version: "2.1",
        incremental_output: true,
        chat_id: chatId,
        chat_mode: "normal",
        model: params.model || "qwen3.5-plus",
        parent_id: null,
        messages: [{ fid, parentId: null, childrenIds: [], role: "user", content: params.message, user_action: "chat", files: [], timestamp: Math.floor(Date.now() / 1000), models: [params.model || "qwen3.5-plus"], chat_type: "t2t", feature_config: { thinking_enabled: true, output_schema: "phase" } }],
      }),
      signal: params.signal,
    })
    if (!res.ok) throw new Error(`Qwen API error (${res.status}): ${await res.text()}`)
    return res.body! || (async function* () { yield "" })() as any
  }
}