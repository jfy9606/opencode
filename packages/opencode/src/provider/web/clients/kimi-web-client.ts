const KIMI_API_BASE = "https://www.kimi.com"

export class KimiWebClient {
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
    const kimiAuth = this.parseCookie("kimi-auth")
    if (!kimiAuth) throw new Error("Kimi: kimi-auth cookie not found")

    const scenario = params.model?.includes("search") ? "SCENARIO_SEARCH" : params.model?.includes("research") ? "SCENARIO_RESEARCH" : params.model?.includes("k1") ? "SCENARIO_K1" : "SCENARIO_K2"
    const req = {
      scenario,
      message: {
        role: "user",
        blocks: [{ message_id: "", text: { content: params.message } }],
        scenario,
      },
      options: { thinking: false },
    }
    const enc = new TextEncoder().encode(JSON.stringify(req))
    const buf = new ArrayBuffer(5 + enc.byteLength)
    const dv = new DataView(buf)
    dv.setUint8(0, 0x00)
    dv.setUint32(1, enc.byteLength, false)
    new Uint8Array(buf, 5).set(enc)

    const res = await fetch(`${KIMI_API_BASE}/apiv2/kimi.gateway.chat.v1.ChatService/Chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/connect+json",
        "Connect-Protocol-Version": "1",
        Accept: "*/*",
        Origin: KIMI_API_BASE,
        Referer: `${KIMI_API_BASE}/`,
        "X-Language": "zh-CN",
        "X-Msh-Platform": "web",
        Authorization: `Bearer ${kimiAuth}`,
        Cookie: this.cookie,
      },
      body: buf,
      signal: params.signal,
    })

    if (!res.ok) throw new Error(`Kimi API error (${res.status}): ${await res.text()}`)
    if (!res.body) throw new Error("Kimi returned empty body")
    return res.body!
  }

  private parseCookie(name: string): string | undefined {
    for (const part of this.cookie.split(";")) {
      const [n, ...v] = part.trim().split("=")
      if (n === name) return v.join("=")
    }
  }
}