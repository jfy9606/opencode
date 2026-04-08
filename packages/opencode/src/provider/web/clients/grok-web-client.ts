const GROK_BASE = "https://grok.com"

export class GrokWebClient {
  private cookie: string
  private userAgent: string
  private conversationId: string | null = null

  constructor(creds: { cookie: string; userAgent?: string }) {
    this.cookie = creds.cookie || ""
    this.userAgent = creds.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  }

  async init() {
    try {
      const res = await fetch(`${GROK_BASE}/rest/app-chat/conversations?limit=1`, {
        headers: this.headers(),
      })
      if (res.ok) {
        const data = await res.json() as any
        this.conversationId = data?.conversations?.[0]?.conversationId ?? null
      }
    } catch { /* ignore */ }
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Cookie: this.cookie,
      "User-Agent": this.userAgent,
    }
  }

  async chatCompletions(opts: { message: string; model: string; signal?: AbortSignal }): Promise<ReadableStream<Uint8Array>> {
    let convId = this.conversationId

    if (!convId) {
      try {
        const listRes = await fetch(`${GROK_BASE}/rest/app-chat/conversations`, {
          headers: this.headers(),
        })
        if (listRes.ok) {
          const list = await listRes.json() as any
          convId = list?.conversations?.[0]?.conversationId ?? null
        }
      } catch { /* ignore */ }
    }

    if (!convId) {
      const createRes = await fetch(`${GROK_BASE}/rest/app-chat/conversations`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({}),
      })
      if (createRes.ok) {
        const createData = await createRes.json() as any
        convId = createData?.conversationId ?? createData?.id ?? null
      }
    }

    if (!convId) throw new Error("Grok: could not obtain conversation ID")

    this.conversationId = convId

    const body = {
      message: opts.message,
      parentResponseId: crypto.randomUUID?.() ?? Math.random().toString(36).slice(2),
      disableSearch: false,
      enableImageGeneration: true,
      imageAttachments: [],
      returnImageBytes: false,
      returnRawGrokInXaiRequest: false,
      fileAttachments: [],
      enableImageStreaming: true,
      imageGenerationCount: 2,
      forceConcise: false,
      toolOverrides: {},
      enableSideBySide: true,
      sendFinalMetadata: true,
      isReasoning: false,
      metadata: { request_metadata: { mode: "auto" } },
      disableTextFollowUps: false,
      disableArtifact: false,
      isFromGrokFiles: false,
      disableMemory: false,
      forceSideBySide: false,
      modelMode: "MODEL_MODE_AUTO",
      isAsyncChat: false,
      skipCancelCurrentInflightRequests: false,
      isRegenRequest: false,
      disableSelfHarmShortCircuit: false,
      deviceEnvInfo: {
        darkModeEnabled: false,
        devicePixelRatio: 1,
        screenWidth: 2560,
        screenHeight: 1440,
        viewportWidth: 1440,
        viewportHeight: 719,
      },
    }

    const res = await fetch(`${GROK_BASE}/rest/app-chat/conversations/${convId}/responses`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: opts.signal,
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => "")
      throw new Error(`Grok API error: ${res.status} ${res.statusText} - ${errText.slice(0, 300)}`)
    }
    if (!res.body) throw new Error("Grok returned empty response")

    return res.body
  }
}
