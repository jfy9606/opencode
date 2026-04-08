import { spawn, execSync } from "node:child_process"
import type { WebAuthCredentials, WebLoginOptions, WebProviderType } from "./types.js"

const PROVIDER_URLS: Record<WebProviderType, string> = {
  "chatgpt-web": "https://chatgpt.com",
  "claude-web": "https://claude.ai",
  "deepseek-web": "https://chat.deepseek.com",
  "doubao-web": "https://www.doubao.com",
  "qwen-web": "https://chat.qwen.ai",
  "qwen-cn-web": "https://chat2.qianwen.com",
  "kimi-web": "https://www.kimi.com",
  "gemini-web": "https://gemini.google.com",
  "grok-web": "https://grok.com",
  "glm-web": "https://chatglm.cn",
  "glm-intl-web": "https://chat.z.ai",
  "perplexity-web": "https://www.perplexity.ai",
  "xiaomimo-web": "https://aistudio.xiaomimimo.com",
}

const PROVIDER_COOKIE_DOMAINS: Record<WebProviderType, string[]> = {
  "chatgpt-web": ["https://chatgpt.com", "https://chat.openai.com", "https://openai.com"],
  "claude-web": ["https://claude.ai"],
  "deepseek-web": ["https://chat.deepseek.com", "https://deepseek.com"],
  "doubao-web": ["https://www.doubao.com"],
  "qwen-web": ["https://chat.qwen.ai"],
  "qwen-cn-web": ["https://chat2.qianwen.com", "https://www.qianwen.com"],
  "kimi-web": ["https://www.kimi.com"],
  "gemini-web": ["https://gemini.google.com", "https://accounts.google.com"],
  "grok-web": ["https://grok.com", "https://x.com"],
  "glm-web": ["https://chatglm.cn"],
  "glm-intl-web": ["https://chat.z.ai"],
  "perplexity-web": ["https://www.perplexity.ai"],
  "xiaomimo-web": ["https://aistudio.xiaomimimo.com"],
}

function findChromePath(): string | null {
  const { existsSync } = require("node:fs") as { existsSync: (p: string) => boolean }
  const candidates: string[] = []

  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH)

  // Windows paths
  if (process.platform === "win32") {
    candidates.push(
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env["PROGRAMFILES(X86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      `${process.env.LOCALAPPDATA}\\Microsoft\\Edge\\Application\\msedge.exe`,
      "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    )
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    )
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
      "/usr/bin/microsoft-edge-stable",
      "/usr/bin/brave-browser",
    )
  }

  for (const c of candidates) {
    if (!c) continue
    try {
      if (existsSync(c)) return c
    } catch { continue }
  }
  return null
}

function userDataDir(): string {
  if (process.platform === "win32") return `${process.env.TEMP ?? "\\temp"}\\opencode-web-auth`
  return `/tmp/opencode-web-auth-chrome`
}

function killPort(port: number) {
  try {
    if (process.platform === "win32") {
      execSync(`for /f "tokens=5" %a in ('netstat -aon ^| findstr :${port} ^| findstr LISTENING') do taskkill /PID %a /F >nul 2>&1`, {
        stdio: "pipe",
        timeout: 3000,
      })
    } else {
      execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, {
        stdio: "pipe",
        timeout: 3000,
      })
    }
  } catch { /* ignore */ }
}

async function launchChrome(cdpPort: number, url: string): Promise<number> {
  const chromePath = findChromePath()
  if (!chromePath) throw new Error(`Browser not found. Please install Chrome/Edge or set CHROME_PATH env. (platform: ${process.platform})`)

  killPort(cdpPort)

  const isWin = process.platform === "win32"

  const args = [
    url,
    `--remote-debugging-port=${cdpPort}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-default-apps",
    ...(isWin ? [] : ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]),
    "--disable-infobars",
    "--disable-background-networking",
    "--window-position=0,0",
    "--window-size=1280,800",
    `--user-data-dir=${userDataDir()}`,
    "--profile-directory=web-auth",
  ]

  const proc = spawn(chromePath, args, {
    stdio: "ignore",
    detached: true,
    windowsHide: false,
  })

  proc.unref()
  return proc.pid ?? 0
}

interface CdpVersionInfo {
  webSocketDebuggerUrl?: string
  UserAgent?: string
}

async function cdpFetchVersion(cdpUrl: string, timeoutMs: number = 15000): Promise<CdpVersionInfo> {
  const start = Date.now()
  let lastErr: string = ""
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(cdpUrl + "/json/version", { signal: AbortSignal.timeout(5000) })
      if (res.ok) return (await res.json()) as CdpVersionInfo
      lastErr = `HTTP ${res.status}`
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`Chrome debugger not ready at ${cdpUrl}: ${lastErr}`)
}

interface CdpCookie {
  name: string
  value: string
  domain: string
}

function cdpSend<T>(ws: WebSocket, method: string, params: Record<string, unknown> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9)
    const msg = JSON.stringify({ id, method, params })
    const onMessage = (ev: MessageEvent) => {
      const data = JSON.parse(ev.data as string)
      if (data.id === id) {
        ws.removeEventListener("message", onMessage)
        if (data.error) reject(new Error(data.error.message ?? JSON.stringify(data.error)))
        else resolve(data.result as T)
      }
    }
    ws.addEventListener("message", onMessage)
    setTimeout(() => {
      ws.removeEventListener("message", onMessage)
      reject(new Error(`CDP command ${method} timed out`))
    }, 15000)
    ws.send(msg)
  })
}

function extractToken(cookies: CdpCookie[], type: WebProviderType): string {
  switch (type) {
    case "chatgpt-web": {
      const s = cookies.find((c) =>
        c.name === "__Secure-next-auth.session-token" ||
        c.name.startsWith("__Secure-next-auth.session-token"),
      )
      if (s) return s.value
      const t0 = cookies.find((c) => c.name === "__Secure-next-auth.session-token.0")
      const t1 = cookies.find((c) => c.name === "__Secure-next-auth.session-token.1")
      if (t0 && t1) return t0.value + t1.value
      break
    }
    case "claude-web": {
      const s = cookies.find((c) => c.name === "sessionKey")
      if (s) return s.value
      break
    }
    case "gemini-web": {
      const s = cookies.find((c) => ["__Secure-1PSID", "__Secure-PSID", "SID"].includes(c.name))
      if (s) return s.value
      break
    }
    case "grok-web": {
      const s = cookies.find((c) => ["sso", "ct0", "auth_token"].includes(c.name))
      if (s) return s.value
      break
    }
    case "deepseek-web": {
      const s = cookies.find((c) =>
        ["ds_session_id", "ds_session", "sessionid", "sessionId", "chat_session_id", "smidV2", "token", "access_token"].includes(c.name.toLowerCase()),
      )
      if (s) return s.value
      break
    }
    case "doubao-web": {
      const s = cookies.find((c) =>
        ["sessionid", "sessionId", "passport_csrf_token", "token", "access_token"].includes(c.name.toLowerCase()),
      )
      if (s) return s.value
      break
    }
    case "qwen-web": {
      const s = cookies.find((c) =>
        ["login_token", "token", "sessionid", "sessionId", "access_token"].includes(c.name.toLowerCase()),
      )
      if (s) return s.value
      break
    }
    case "kimi-web": {
      const s = cookies.find((c) =>
        ["sessionid", "sessionId", "token", "access_token"].includes(c.name.toLowerCase()),
      )
      if (s) return s.value
      break
    }
    case "glm-web": {
      const s = cookies.find((c) =>
        ["chatglm_refresh_token", "chatglm_token", "token", "access_token", "sessionid"].includes(c.name),
      )
      if (s) return s.value
      break
    }
    case "qwen-cn-web": {
      const s = cookies.find((c) =>
        ["tongyi_sso_ticket", "login_aliyunid_ticket", "XSRF-TOKEN", "token", "access_token"].includes(c.name),
      )
      if (s) return s.value
      break
    }
    case "glm-intl-web": {
      const s = cookies.find((c) =>
        ["chatglm_refresh_token", "chatglm_token", "refresh_token", "auth_token", "access_token", "token"].includes(c.name),
      )
      if (s) return s.value
      break
    }
    case "perplexity-web": {
      const s = cookies.find((c) =>
        ["__Secure-next-auth.session-token", "next-auth.session-token", "pplx-session", "intercom_session"].includes(c.name),
      )
      if (s) return s.value
      break
    }
    case "xiaomimo-web": {
      const s = cookies.find((c) =>
        ["serviceToken", "token", "sessionid", "access_token"].includes(c.name),
      )
      if (s) return s.value
      break
    }
    default: {
      const s = cookies.find((c) =>
        ["session", "token", "access_token", "sessionid"].includes(c.name.toLowerCase()),
      )
      if (s) return s.value
      break
    }
  }
  return ""
}

function hasAuthCookies(cookies: CdpCookie[]): boolean {
  if (!cookies || cookies.length === 0) return false
  const wafOrSystem = (n: string) =>
    n.startsWith("HWWAFSES") || n.startsWith(".") || n.includes("thumbcache") || n === "cf_clearance" || n.startsWith("__cf_bm")
  const filtered = cookies.filter((c) => !wafOrSystem(c.name))
  if (filtered.length === 0) return false
  const authNames = new Set([
    "sessionid", "session", "token", "access_token", "sessionkey",
    "sessionid.0", "sid", "psid", "ct0", "auth_token", "sso",
    "login_token", "passport_csrf_token", "ds_session", "ds_session_id",
    "chat_session_id", "smidv2", "chatglm_refresh_token", "chatglm_token",
    "tongyi_sso_ticket", "login_aliyunid_ticket", "xsrf-token",
    "refresh_token", "auth_token", "intercom_session",
    "serviceToken", "next-auth.session-token",
  ])
  return filtered.some((c) => authNames.has(c.name.toLowerCase()))
}

export async function loginWebProvider(
  type: WebProviderType,
  opts: WebLoginOptions,
): Promise<WebAuthCredentials> {
  const url = PROVIDER_URLS[type]
  const domains = PROVIDER_COOKIE_DOMAINS[type]

  const chromePath = findChromePath()
  if (!chromePath) throw new Error(`No browser found on this system (platform: ${process.platform}). Install Chrome/Edge or set CHROME_PATH.`)

  opts.onProgress(`Launching ${chromePath.split(/[/\\]/).pop()}...`)

  let cdpPort = 9222
  let cdpInfo: CdpVersionInfo | null = null
  let lastError = ""

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      cdpPort = 9222 + attempt
      const pid = await launchChrome(cdpPort, url)
      console.log(`[WebAuth] Chrome launched (pid=${pid}, port=${cdpPort}), waiting for debugger...`)
      cdpInfo = await cdpFetchVersion(`http://127.0.0.1:${cdpPort}`, 15000)
      if (cdpInfo?.webSocketDebuggerUrl) {
        console.log(`[WebAuth] Connected to debugger, UA: ${cdpInfo.UserAgent?.slice(0, 60)}...`)
        break
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      console.log(`[WebAuth] Attempt ${attempt + 1} failed: ${lastError}`)
      killPort(cdpPort)
    }
  }

  if (!cdpInfo?.webSocketDebuggerUrl) {
    throw new Error(`Failed to connect to Chrome debugger after 3 attempts. Last error: ${lastError}`)
  }

  const userAgent = cdpInfo.UserAgent ?? ""
  opts.onProgress(`Please login to ${url} in the opened browser window...`)

  const cdpUrl = `http://127.0.0.1:${cdpPort}`

  interface CdpTarget {
    id: string
    type: string
    title: string
    url: string
    webSocketDebuggerUrl?: string
  }

  async function fetchPageWs(): Promise<string> {
    for (let i = 0; i < 10; i++) {
      try {
        const res = await fetch(`${cdpUrl}/json/list`, { signal: AbortSignal.timeout(3000) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const targets = (await res.json()) as CdpTarget[]
        const page = targets.find((t) => t.type === "page" && t.url.includes(url))
        if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error("Page target not found in Chrome debugger")
  }

  let ws: WebSocket
  try {
    const pageWsUrl = await fetchPageWs()
    console.log(`[WebAuth] Connecting to page-level CDP...`)
    ws = new WebSocket(pageWsUrl)
  } catch (e) {
    throw new Error(`Failed to connect to Chrome page: ${e instanceof Error ? e.message : String(e)}`)
  }

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve())
    ws.addEventListener("error", (ev) => reject(new Error(`WebSocket error: ${ev.type}`)))
    setTimeout(() => reject(new Error("WebSocket connection timed out")), 15000)
  })

  await cdpSend(ws, "Network.enable")

  return new Promise<WebAuthCredentials>((resolve, reject) => {
    let resolved = false

    let capturedBearer = ""
    ws.addEventListener("message", async (event) => {
      if (resolved) return
      try {
        const msg = JSON.parse(event.data as string)
        if (msg.method === "Network.requestWillBeSent") {
          const reqUrl = msg.params?.request?.url || ""
          const headers = msg.params?.request?.headers || {}
          if (
            (type === "deepseek-web" || type === "doubao-web" || type === "glm-web" ||
             type === "glm-intl-web" || type === "kimi-web" || type === "qwen-web" ||
             type === "qwen-cn-web" || type === "xiaomimo-web") &&
            (reqUrl.includes("/api/v0/") || reqUrl.includes("/api/") || reqUrl.includes("/open-apis/"))
          ) {
            const auth = headers["Authorization"] || headers["authorization"]
            if (auth?.startsWith("Bearer ") && !capturedBearer) {
              capturedBearer = auth.slice(7)
              console.log(`[WebAuth] Captured Bearer from ${reqUrl.slice(0, 60)}, len=${capturedBearer.length}`)
              // tryResolve will be called from the interval too
            }
          }
        }
      } catch { /* ignore */ }
    })

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true
        clearInterval(checkInterval)
        killPort(cdpPort)
        reject(new Error("Login timed out (5 minutes). No session detected."))
      }
    }, 300_000)

    let pollCount = 0
    const tryResolve = async () => {
      if (resolved) return
      pollCount++
      try {
        const { cookies } = await cdpSend<{ cookies: CdpCookie[] }>(ws, "Network.getCookies", { urls: domains })

        if (!cookies || cookies.length === 0) {
          opts.onProgress(`Polling... (#${pollCount}, no cookies yet for ${domains.join(", ")})`)
          return
        }

        const wafOrSystem = (n: string) =>
          n.startsWith("HWWAFSES") || n.startsWith(".") || n.includes("thumbcache") || n === "cf_clearance" || n.startsWith("__cf_bm")
        const realCookies = cookies.filter((c) => !wafOrSystem(c.name))
        const cookieNames = realCookies.map((c) => c.name)
        const extracted = extractToken(cookies, type)
        const hasAuth = hasAuthCookies(cookies)

        opts.onProgress(`Detected ${realCookies.length} cookies: [${cookieNames.join(", ")}]${extracted ? " ✓ token found" : ""}${!extracted && hasAuth ? " ✓ auth cookies detected" : ""}${capturedBearer ? " ✓ Bearer captured" : ""}`)

        let token = extracted
        if (!token && hasAuth) {
          token = cookieNames.join(", ")
        }
        if (token && !resolved) {
          resolved = true
          clearTimeout(timeout)
          clearInterval(checkInterval)
          const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ")
          console.log(`[WebAuth] Captured credentials for ${type}, token length: ${token.length}`)
          try {
            await cdpSend(ws, "Page.close")
            ws.close()
          } catch { /* best effort */ }
          killPort(cdpPort)
          resolve({ accessToken: token, cookie: cookieString, userAgent, bearer: capturedBearer || undefined })
        }
      } catch (e) {
        if (!resolved) console.error(`[WebAuth] Cookie poll error: ${e}`)
      }
    }

    const checkInterval = setInterval(tryResolve, 3000)

    ws.addEventListener("close", () => {
      clearInterval(checkInterval)
      if (!resolved) {
        resolved = true
        reject(new Error("Browser window was closed before login could be captured."))
      }
    })

    ws.addEventListener("error", (ev) => {
      clearInterval(checkInterval)
      if (!resolved) {
        resolved = true
        reject(new Error(`WebSocket error during login: ${ev.type}`))
      }
    })
  })
}
