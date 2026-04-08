const PERPLEXITY_API_BASE = "https://www.perplexity.ai"

export class PerplexityWebClient {
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
    const res = await fetch(`${PERPLEXITY_API_BASE}/api/ask`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: this.cookie,
        "User-Agent": this.userAgent,
        Accept: "text/event-stream",
        Referer: `${PERPLEXITY_API_BASE}/`,
        Origin: PERPLEXITY_API_BASE,
      },
      body: JSON.stringify({
        query: params.message,
        source: "default",
        mode: "concise",
        search_focus: "internet",
      }),
      signal: params.signal,
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => "")
      if (res.status === 403 || errText.includes("anti-bot")) {
        throw new Error("Perplexity API blocked (403 anti-bot). Perplexity may require browser-based interaction.")
      }
      throw new Error(`Perplexity API error (${res.status}): ${errText.slice(0, 300)}`)
    }
    if (!res.body) throw new Error("Perplexity returned empty response")
    return res.body
  }
}
