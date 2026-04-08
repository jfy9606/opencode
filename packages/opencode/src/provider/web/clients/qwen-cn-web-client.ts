const QWEN_CN_API_BASE = "https://chat2.qianwen.com"

export class QwenCNWebClient {
  private cookie: string
  private userAgent: string
  private xsrfToken: string
  private deviceId: string

  constructor(creds: { cookie: string; userAgent?: string }) {
    this.cookie = creds.cookie || ""
    this.userAgent = creds.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
    this.xsrfToken = this.parseCookie("XSRF-TOKEN") || ""
    this.deviceId = this.parseCookie("b-user-id") || crypto.randomUUID().replace(/-/g, "")
  }

  async init() {}

  async chatCompletions(params: {
    message: string
    model?: string
    sceneParam?: string
    signal?: AbortSignal
  }): Promise<ReadableStream<Uint8Array>> {
    const timestamp = Date.now()
    const nonce = Math.random().toString(36).slice(2)
    const sessionId = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("")

    const url = `${QWEN_CN_API_BASE}/api/v2/chat?biz_id=ai_qwen&chat_client=h5&device=pc&fr=pc&pr=qwen&nonce=${nonce}&timestamp=${timestamp}&ut=${this.deviceId}`

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream, text/plain, */*",
        Referer: `${QWEN_CN_API_BASE}/`,
        Origin: QWEN_CN_API_BASE,
        Cookie: this.cookie,
        "x-xsrf-token": this.xsrfToken,
        "x-deviceid": this.deviceId,
        "x-platform": "pc_tongyi",
        "x-req-from": "pc_web",
        "User-Agent": this.userAgent,
      },
      body: JSON.stringify({
        model: params.model || "Qwen3.5-Plus",
        messages: [{ content: params.message, mime_type: "text/plain", meta_data: { ori_query: params.message } }],
        session_id: sessionId,
        parent_req_id: "0",
        deep_search: "0",
        req_id: "req-" + Math.random().toString(36).slice(2),
        scene: "chat",
        sub_scene: "chat",
        temporary: false,
        from: "default",
        scene_param: params.sceneParam ?? "first_turn",
        chat_client: "h5",
        client_tm: timestamp.toString(),
        protocol_version: "v2",
        biz_id: "ai_qwen",
      }),
      signal: params.signal,
    })

    if (!res.ok) throw new Error(`Qwen CN API error (${res.status}): ${await res.text()}`)
    if (!res.body) throw new Error("Qwen CN returned empty response")
    return res.body
  }

  private parseCookie(name: string): string | undefined {
    for (const part of this.cookie.split(";")) {
      const [n, ...v] = part.trim().split("=")
      if (n === name) return v.join("=")
    }
  }
}