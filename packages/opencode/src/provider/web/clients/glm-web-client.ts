import crypto from "node:crypto"

const GLM_API_BASE = "https://chatglm.cn"
const SIGN_SECRET = "8a1317a7468aa3ad86e997d08f3f31cb"
const X_EXP_GROUPS = "na_android_config:exp:NA,na_4o_config:exp:4o_A,tts_config:exp:tts_config_a,na_glm4plus_config:exp:open,mainchat_server_app:exp:A,mobile_history_daycheck:exp:a,desktop_toolbar:exp:A,chat_drawing_server:exp:A,drawing_server_cogview:exp:cogview4,app_welcome_v2:exp:A,chat_drawing_streamv2:exp:A,mainchat_rm_fc:exp:add,mainchat_dr:exp:open,chat_auto_entrance:exp:A,drawing_server_hi_dream:control:A,homepage_square:exp:close,assistant_recommend_prompt:exp:3,app_home_regular_user:exp:A,memory_common:exp:enable,mainchat_moe:exp:300,assistant_greet_user:exp:greet_user,app_welcome_personalize:exp:A,assistant_model_exp_group:exp:glm4.5,ai_wallet:exp:ai_wallet_enable"

const ASSISTANT_IDS: Record<string, string> = {
  "glm-4-plus": "65940acff94777010aa6b796",
  "glm-4": "65940acff94777010aa6b796",
  "glm-4-think": "676411c38945bbc58a905d31",
}

function generateSign() {
  const e = Date.now().toString()
  const o = e.split("").map((c) => Number(c))
  const i = o.reduce((a, v) => a + v) - o[e.length - 2]
  const timestamp = e.slice(0, e.length - 2) + (i % 10) + e.slice(-1)
  const nonce = crypto.randomUUID().replace(/-/g, "")
  const sign = crypto.createHash("md5").update(`${timestamp}-${nonce}-${SIGN_SECRET}`).digest("hex")
  return { timestamp, nonce, sign }
}

export class GLMWebClient {
  private cookie: string
  private userAgent: string
  private deviceId: string

  constructor(creds: { cookie: string; userAgent?: string }) {
    this.cookie = creds.cookie || ""
    this.userAgent = creds.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
    this.deviceId = crypto.randomUUID().replace(/-/g, "")
  }

  async init() {}

  async chatCompletions(params: {
    message: string
    model?: string
    signal?: AbortSignal
  }): Promise<ReadableStream<Uint8Array>> {
    const accessToken = this.parseCookie("chatglm_token") || ""
    const { timestamp, nonce, sign } = generateSign()
    const requestId = crypto.randomUUID().replace(/-/g, "")

    const res = await fetch(`${GLM_API_BASE}/chatglm/backend-api/assistant/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "App-Name": "chatglm",
        "X-App-fr": "default",
        "X-Device-Brand": "",
        "X-Device-Model": "",
        Origin: GLM_API_BASE,
        "X-App-Platform": "pc",
        "X-App-Version": "0.0.1",
        "X-Device-Id": this.deviceId,
        "X-Exp-Groups": X_EXP_GROUPS,
        "X-Lang": "zh",
        "X-Nonce": nonce,
        "X-Request-Id": requestId,
        "X-Sign": sign,
        "X-Timestamp": timestamp,
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        Cookie: this.cookie,
      },
      body: JSON.stringify({
        assistant_id: ASSISTANT_IDS[params.model || ""] || ASSISTANT_IDS["glm-4-plus"],
        conversation_id: "",
        project_id: "",
        chat_type: "user_chat",
        meta_data: {
          cogview: { rm_label_watermark: false },
          is_test: false,
          input_question_type: "xxxx",
          channel: "",
          draft_id: "",
          chat_mode: "zero",
          is_networking: false,
          quote_log_id: "",
          platform: "pc",
        },
        messages: [{ role: "user", content: [{ type: "text", text: params.message }] }],
      }),
      signal: params.signal,
    })

    if (!res.ok) throw new Error(`GLM API error (${res.status}): ${await res.text()}`)
    return res.body! || (async function* () { yield "" })() as any
  }

  private parseCookie(name: string): string | undefined {
    for (const part of this.cookie.split(";")) {
      const [n, ...v] = part.trim().split("=")
      if (n === name) return v.join("=")
    }
  }
}