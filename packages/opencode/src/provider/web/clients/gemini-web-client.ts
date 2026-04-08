import { spawn, execSync } from "node:child_process"

const GEMINI_BASE = "https://gemini.google.com"

function findChrome(): string | null {
  const { existsSync } = require("node:fs") as { existsSync: (p: string) => boolean }
  const cands: string[] = []
  if (process.env.CHROME_PATH) cands.push(process.env.CHROME_PATH)
  if (process.platform === "win32") {
    cands.push(
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env["PROGRAMFILES(X86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      `${process.env.LOCALAPPDATA}\\Microsoft\\Edge\\Application\\msedge.exe`,
    )
  } else if (process.platform === "darwin") {
    cands.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    )
  } else {
    cands.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
      "/usr/bin/microsoft-edge-stable",
    )
  }
  for (const c of cands) {
    if (!c) continue
    try { if (existsSync(c)) return c } catch { continue }
  }
  return null
}

function tmpDir(): string {
  if (process.platform === "win32") return `${process.env.TEMP ?? "\\temp"}\\opencode-gemini`
  return "/tmp/opencode-gemini-chrome"
}

function killPort(port: number) {
  try {
    if (process.platform === "win32") {
      execSync(`for /f "tokens=5" %a in ('netstat -aon ^| findstr :${port} ^| findstr LISTENING') do taskkill /PID %a /F >nul 2>&1`, { stdio: "pipe", timeout: 3000 })
    } else {
      execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, { stdio: "pipe", timeout: 3000 })
    }
  } catch { /* ignore */ }
}

interface CdpCookie { name: string; value: string; domain: string; path: string }

function cdpSend(ws: WebSocket, method: string, params: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9)
    ws.send(JSON.stringify({ id, method, params }))
    const onMsg = (ev: MessageEvent) => {
      const data = JSON.parse(ev.data as string)
      if (data.id === id) {
        ws.removeEventListener("message", onMsg)
        if (data.error) reject(new Error(data.error.message ?? JSON.stringify(data.error)))
        else resolve(data.result)
      }
    }
    ws.addEventListener("message", onMsg)
    setTimeout(() => { ws.removeEventListener("message", onMsg); reject(new Error(`CDP ${method} timed out`)) }, 30000)
  })
}

async function waitForCdp(cdpUrl: string, timeoutMs = 15000): Promise<string> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(5000) })
      if (res.ok) {
        const info = await res.json() as any
        if (info.webSocketDebuggerUrl) return info.webSocketDebuggerUrl
      }
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error("Chrome debugger not ready")
}

async function findPageWs(cdpUrl: string, urlMatch: string): Promise<string> {
  for (let i = 0; i < 10; i++) {
    try {
      const res = await fetch(`${cdpUrl}/json/list`, { signal: AbortSignal.timeout(3000) })
      if (!res.ok) continue
      const targets = await res.json() as any[]
      const page = targets.find(t => t.type === "page" && t.url.includes(urlMatch))
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error("Page target not found")
}

export class GeminiWebClient {
  private cookie: string
  private userAgent: string
  private cdpPort = 0

  constructor(creds: { cookie: string; userAgent?: string }) {
    this.cookie = creds.cookie || ""
    this.userAgent = creds.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  }

  async init() {}

  async chatCompletions(opts: { message: string; model: string; signal?: AbortSignal }): Promise<ReadableStream<Uint8Array>> {
    const chromePath = findChrome()
    if (!chromePath) throw new Error("No browser found for Gemini DOM simulation")

    const port = 9330 + Math.floor(Math.random() * 100)
    this.cdpPort = port
    killPort(port)

    const proc = spawn(chromePath, [
      `${GEMINI_BASE}/app`,
      `--remote-debugging-port=${port}`,
      "--no-first-run", "--no-default-browser-check", "--disable-default-apps",
      "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
      "--disable-infobars", "--disable-background-networking",
      "--window-position=0,0", "--window-size=1280,800",
      `--user-data-dir=${tmpDir()}`, "--profile-directory=gemini-chat",
    ], { stdio: "ignore", detached: true, windowsHide: true })
    proc.unref()

    const cdpUrl = `http://127.0.0.1:${port}`
    let ws: WebSocket
    try {
      const browserWs = await waitForCdp(cdpUrl, 20000)
      const browserWsConn = new WebSocket(browserWs)
      await new Promise<void>((res, rej) => {
        browserWsConn.addEventListener("open", () => res())
        browserWsConn.addEventListener("error", e => rej(new Error(`Browser WS error: ${e.type}`)))
        setTimeout(() => rej(new Error("Browser WS timeout")), 10000)
      })

      const cookies: CdpCookie[] = this.cookie.split(";")
        .filter(c => c.trim().includes("="))
        .map(c => {
          const [name, ...vals] = c.trim().split("=")
          return { name: name.trim(), value: vals.join("=").trim(), domain: ".google.com", path: "/" }
        })
        .filter(c => c.name.length > 0)

      if (cookies.length > 0) {
        await cdpSend(browserWsConn, "Network.setCookie", { cookie: cookies[0] })
        for (const c of cookies) {
          await cdpSend(browserWsConn, "Network.setCookie", { cookie: c })
        }
      }
      browserWsConn.close()

      await new Promise(r => setTimeout(r, 2000))

      const pageWsUrl = await findPageWs(cdpUrl, "gemini.google.com")
      ws = new WebSocket(pageWsUrl)
      await new Promise<void>((res, rej) => {
        ws.addEventListener("open", () => res())
        ws.addEventListener("error", e => rej(new Error(`Page WS error: ${e.type}`)))
        setTimeout(() => rej(new Error("Page WS timeout")), 10000)
      })
    } catch (e) {
      killPort(port)
      throw new Error(`Gemini Chrome setup failed: ${e instanceof Error ? e.message : String(e)}`)
    }

    try {
      await cdpSend(ws, "Page.enable")
      await cdpSend(ws, "Runtime.enable")

      const navResult = await cdpSend(ws, "Runtime.evaluate", {
        expression: `window.location.href`,
        returnByValue: true,
      })
      const currentUrl = navResult?.result?.value || ""
      if (!currentUrl.includes("gemini.google.com")) {
        await cdpSend(ws, "Page.navigate", { url: `${GEMINI_BASE}/app` })
        await new Promise(r => setTimeout(r, 3000))
      }

      const inputResult = await cdpSend(ws, "Runtime.evaluate", {
        expression: `
          (function() {
            const selectors = [
              'textarea[placeholder*="Gemini"]',
              'textarea[placeholder*="问问"]',
              'textarea[aria-label*="prompt"]',
              'textarea',
              'div[role="textbox"]',
              '[contenteditable="true"]',
            ];
            for (const sel of selectors) {
              const el = document.querySelector(sel);
              if (el) return sel;
            }
            return '';
          })()
        `,
        returnByValue: true,
      })
      const selector = inputResult?.result?.value || "textarea"
      if (!selector) throw new Error("Gemini input not found")

      await cdpSend(ws, "Runtime.evaluate", {
        expression: `
          (function() {
            const el = document.querySelector('${selector}');
            if (!el) return false;
            el.focus();
            el.click();
            return true;
          })()
        `,
        returnByValue: true,
      })
      await new Promise(r => setTimeout(r, 300))

      const escapedMsg = opts.message.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, "\\n")
      await cdpSend(ws, "Input.dispatchKeyEvent", { type: "keyDown", text: "" })
      await cdpSend(ws, "Runtime.evaluate", {
        expression: `
          (function() {
            const el = document.querySelector('${selector}');
            if (!el) return false;
            if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
              el.value = '${escapedMsg}';
              el.dispatchEvent(new Event('input', { bubbles: true }));
            } else if (el.contentEditable === 'true') {
              el.textContent = '${escapedMsg}';
              el.dispatchEvent(new Event('input', { bubbles: true }));
            }
            return true;
          })()
        `,
        returnByValue: true,
      })
      await new Promise(r => setTimeout(r, 300))

      await cdpSend(ws, "Input.dispatchKeyEvent", {
        type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13,
      })
      await cdpSend(ws, "Input.dispatchKeyEvent", {
        type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13,
      })

      const maxWait = 120000
      const pollInterval = 2000
      let lastText = ""
      let stableCount = 0
      const deadline = Date.now() + maxWait

      while (Date.now() < deadline) {
        if (opts.signal?.aborted) throw new Error("Gemini request cancelled")
        await new Promise(r => setTimeout(r, pollInterval))

        const pollResult = await cdpSend(ws, "Runtime.evaluate", {
          expression: `
            (function() {
              const clean = t => t.replace(/[\\u200B-\\u200D\\uFEFF]/g, '').trim();
              const getText = el => clean((el).innerText || '');
              const isExcluded = el => {
                const sidebar = document.querySelector('[aria-label*="对话"], [class*="sidebar"], nav');
                const inputEl = document.querySelector('[contenteditable="true"], textarea');
                const inputRoot = inputEl?.closest('form') || inputEl?.closest("[class*='input']") || inputEl?.parentElement?.parentElement;
                return sidebar?.contains(el) || inputRoot?.contains(el);
              };
              const noisePatterns = ["Ask Gemini","问问 Gemini","Enter a prompt","输入提示","需要我为你做些什么","发起新对话","我的内容","设置和帮助","制作图片","创作音乐","帮我学习","随便写点什么","给我的一天注入活力","升级到 Google AI Plus","正在加载","复制","分享","修改","朗读"];
              const isNoise = t => t.length < 20 || noisePatterns.some(p => t.includes(p));
              const stripUI = t => t.replace(/\\n?\\s*(复制|分享|修改|朗读|Copy|Share|Edit|Read aloud|thumb_up|thumb_down|more_vert)[\\s\\n]*/gi, '').replace(/\\s+$/, '');
              const main = document.querySelector('main') || document.querySelector('[role="main"]') || document.querySelector('[class*="chat"]') || document.body;
              const scoped = main === document.body ? document : main;
              let text = '';
              const modelSelectors = [
                'model-response message-content',
                '[data-message-author="model"] .message-content',
                '[data-message-author="model"]',
                '[data-sender="model"]',
                '[class*="model-response"] [class*="markdown"]',
                '[class*="model-response"]',
                '[class*="response-content"] [class*="markdown"]',
                '[class*="response-content"]',
              ];
              for (const sel of modelSelectors) {
                const els = scoped.querySelectorAll(sel);
                for (let i = els.length - 1; i >= 0; i--) {
                  if (isExcluded(els[i])) continue;
                  const t = getText(els[i]);
                  if (t.length >= 30 && !isNoise(t)) { text = stripUI(t); break; }
                }
                if (text) break;
              }
              if (!text) {
                const fallbacks = ['[class*="markdown"]', 'article'];
                for (const sel of fallbacks) {
                  const els = scoped.querySelectorAll(sel);
                  for (let i = els.length - 1; i >= 0; i--) {
                    if (isExcluded(els[i])) continue;
                    const t = getText(els[i]);
                    if (t.length >= 30 && !isNoise(t)) { text = stripUI(t); break; }
                  }
                  if (text) break;
                }
              }
              const stopBtn = document.querySelector('[aria-label*="Stop"], [aria-label*="stop"], [aria-label*="停止"]');
              return { text, isStreaming: !!stopBtn };
            })()
          `,
          returnByValue: true,
        })

        const result = pollResult?.result?.value
        if (result?.text && result.text.length >= 40) {
          if (result.text !== lastText) {
            lastText = result.text
            stableCount = 0
          } else {
            stableCount++
            if (!result.isStreaming && stableCount >= 2) break
          }
        }
      }

      try { await cdpSend(ws, "Page.close"); ws.close() } catch { /* best effort */ }
      killPort(port)

      if (!lastText) throw new Error("Gemini DOM: no response detected")

      const sseLine = `data: ${JSON.stringify({ text: lastText })}\n\n`
      const encoder = new TextEncoder()
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(sseLine))
          controller.close()
        },
      })
    } catch (e) {
      try { ws.close() } catch { /* ignore */ }
      killPort(port)
      throw e
    }
  }
}
