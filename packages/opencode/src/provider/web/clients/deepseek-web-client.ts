import crypto from "node:crypto"

const DEEPSEEK_API_URL = "https://chat.deepseek.com"

interface DeepSeekPowChallenge {
  algorithm: string
  challenge: string
  difficulty: number
  salt: string
  signature: string
  expire_at?: number
}

interface DeepSeekChatSession {
  biz_id: string
  chat_session_id: string
  title: string
  id?: string
}

export class DeepSeekWebClient {
  private cookie: string
  private bearer: string
  private userAgent: string

  constructor(creds: { cookie: string; bearer?: string; userAgent?: string }) {
    this.cookie = creds.cookie || ""
    this.bearer = creds.bearer || ""
    this.userAgent =
      creds.userAgent ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
  }

  private fetchHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      Cookie: this.cookie,
      "User-Agent": this.userAgent,
      "Content-Type": "application/json",
      Accept: "*/*",
      Referer: "https://chat.deepseek.com/",
      Origin: "https://chat.deepseek.com",
      "x-client-platform": "web",
      "x-client-version": "1.7.0",
      "x-app-version": "20241129.1",
      "x-client-locale": "zh_CN",
      "x-client-timezone-offset": "28800",
    }
    if (this.bearer) h["Authorization"] = `Bearer ${this.bearer}`
    return h
  }

  async init() {
    try {
      const res = await fetch(`${DEEPSEEK_API_URL}/api/v0/client/settings?did=&scope=banner`, {
        headers: this.fetchHeaders(),
      })
      if (!res.ok) console.warn(`[DeepSeekWeb] Settings check: ${res.status}`)
    } catch { /* non-critical */ }
  }

  private async createPowChallenge(targetPath: string): Promise<DeepSeekPowChallenge> {
    const res = await fetch(`${DEEPSEEK_API_URL}/api/v0/chat/create_pow_challenge`, {
      method: "POST",
      headers: this.fetchHeaders(),
      body: JSON.stringify({ target_path: targetPath }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`PoW challenge failed (${res.status}): ${text.slice(0, 300)}`)
    }
    const data = await res.json()
    const challenge = data.data?.biz_data?.challenge || data.data?.challenge || data.challenge
    if (!challenge) throw new Error("PoW challenge missing in response")
    return challenge
  }

  private async solvePow(challenge: DeepSeekPowChallenge): Promise<number> {
    const { algorithm, challenge: target, salt, difficulty } = challenge

    if (algorithm === "sha256") {
      const start = Date.now()
      let nonce = 0
      while (true) {
        const hash = crypto.createHash("sha256").update(salt + target + nonce).digest("hex")
        let zeroBits = 0
        for (const char of hash) {
          const val = parseInt(char, 16)
          if (val === 0) zeroBits += 4
          else { zeroBits += Math.clz32(val) - 28; break }
        }
        const targetDifficulty = difficulty > 1000 ? Math.floor(Math.log2(difficulty)) : difficulty
        if (zeroBits >= targetDifficulty) {
          console.log(`[DeepSeekWeb] SHA256 PoW solved in ${Date.now() - start}ms, nonce=${nonce}`)
          return nonce
        }
        nonce++
        if (nonce > 2000000) throw new Error("SHA256 PoW timeout")
      }
    }

    if (algorithm === "DeepSeekHashV1") {
      throw new Error(`DeepSeekHashV1 PoW not yet implemented (need WASM). Got algorithm=${algorithm}, try again or use different model`)
    }

    throw new Error(`Unsupported PoW algorithm: ${algorithm}`)
  }

  async createChatSession(): Promise<{ chat_session_id: string }> {
    const res = await fetch(`${DEEPSEEK_API_URL}/api/v0/chat_session/create`, {
      method: "POST",
      headers: this.fetchHeaders(),
      body: JSON.stringify({}),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`DeepSeek session error (${res.status}): ${text.slice(0, 500)} | cookie=${this.cookie.slice(0, 100)}... | bearer=${this.bearer.slice(0, 30)}...`)
    }
    const data = await res.json()
    const sessionId = data.data?.biz_data?.id || data.data?.biz_data?.chat_session_id || ""
    return { chat_session_id: sessionId }
  }

  async chatCompletions(params: {
    sessionId: string
    parentMessageId?: string | number | null
    message: string
    model?: string
    signal?: AbortSignal
  }): Promise<ReadableStream<Uint8Array>> {
    const targetPath = "/api/v0/chat/completion"
    const challenge = await this.createPowChallenge(targetPath)
    const answer = await this.solvePow(challenge)
    const powResponse = Buffer.from(
      JSON.stringify({ ...challenge, answer, target_path: targetPath }),
    ).toString("base64")

    const isReasoning = params.model?.includes("reasoner") || params.model?.includes("r1")

    const res = await fetch(`${DEEPSEEK_API_URL}${targetPath}`, {
      method: "POST",
      headers: { ...this.fetchHeaders(), "x-ds-pow-response": powResponse },
      body: JSON.stringify({
        chat_session_id: params.sessionId,
        parent_message_id: params.parentMessageId ?? null,
        prompt: params.message,
        ref_file_ids: [],
        thinking_enabled: !params.model?.includes("deepseek-chat") || isReasoning,
        search_enabled: true,
        preempt: false,
      }),
      signal: params.signal,
    })

    if (!res.ok) {
      const text = await res.text().catch(() => "")
      const hasBearer = !!this.bearer
      const bearerLen = this.bearer?.length || 0
      throw new Error(
        `DeepSeek API error (${res.status}): ${text.slice(0, 500)}\n` +
        `cookie=${this.cookie.slice(0, 80)}... | bearer=${hasBearer ? `${bearerLen} chars` : "MISSING (need to re-login!)"}`,
      )
    }

    if (!res.body) throw new Error("DeepSeek returned empty response body")

    return res.body!
  }
}