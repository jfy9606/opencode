const DOUBAO_API_BASE = "https://www.doubao.com"

export class DoubaoWebClient {
  private cookie: string
  private userAgent: string
  private config: Record<string, string>

  constructor(creds: { cookie: string; userAgent?: string }) {
    this.cookie = creds.cookie || ""
    this.userAgent = creds.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
    this.config = {
      aid: "497858",
      device_platform: "web",
      language: "zh",
      pkg_type: "release_version",
      real_aid: "497858",
      region: "CN",
      samantha_web: "1",
      sys_region: "CN",
      use_olympus_account: "1",
      version_code: "20800",
    }
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "Agw-js-conv": "str",
      "User-Agent": this.userAgent,
      Referer: "https://www.doubao.com/chat/",
      Origin: "https://www.doubao.com",
      Cookie: this.cookie,
    }
  }

  private queryParams(): string {
    return new URLSearchParams(
      Object.fromEntries(Object.entries(this.config).filter(([, v]) => v !== undefined)),
    ).toString()
  }

  async init() {}

  async chatCompletions(params: {
    message: string
    model?: string
    signal?: AbortSignal
  }): Promise<ReadableStream<Uint8Array>> {
    const url = `${DOUBAO_API_BASE}/samantha/chat/completion?${this.queryParams()}`
    const body = JSON.stringify({
      messages: [{ content: JSON.stringify({ text: params.message }), content_type: 2001, attachments: [], references: [] }],
      completion_option: { is_regen: false, with_suggest: true, need_create_conversation: true, launch_stage: 1, is_replace: false, message_from: 0, event_id: "0" },
      conversation_id: "0",
      local_conversation_id: `local_${Date.now().toString().slice(-14)}`,
      local_message_id: crypto.randomUUID(),
    })

    const res = await fetch(url, { method: "POST", headers: this.headers(), body, signal: params.signal })
    if (!res.ok) throw new Error(`Doubao API error (${res.status}): ${await res.text()}`)
    return res.body! || (async function* () { yield "" })() as any
  }
}