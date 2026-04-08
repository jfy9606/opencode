import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Tag } from "@opencode-ai/ui/tag"
import { showToast } from "@opencode-ai/ui/toast"
import {
  createEffect,
  createMemo,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import type { WebProviderType } from "@/components/web-provider-config"

const PROVIDER_INFO: Record<WebProviderType, { name: string; url: string; color: string }> = {
  "chatgpt-web": { name: "ChatGPT", url: "https://chatgpt.com", color: "#10a37f" },
  "claude-web": { name: "Claude", url: "https://claude.ai", color: "#d97757" },
  "deepseek-web": { name: "DeepSeek", url: "https://chat.deepseek.com", color: "#4b6bfb" },
  "doubao-web": { name: "Doubao", url: "https://www.doubao.com", color: "#ff6a00" },
  "qwen-web": { name: "Qwen", url: "https://chat.qwen.ai", color: "#00a8e0" },
  "kimi-web": { name: "Kimi", url: "https://www.kimi.com", color: "#7c3aed" },
  "gemini-web": { name: "Gemini", url: "https://gemini.google.com", color: "#4285f4" },
  "grok-web": { name: "Grok", url: "https://grok.com", color: "#000000" },
  "glm-web": { name: "GLM", url: "https://chatglm.cn", color: "#1a73e8" },
}

export function DialogWebAuth(props: { provider: string }) {
  const dialog = useDialog()
  const globalSDK = useGlobalSDK()
  const language = useLanguage()
  const server = useServer()

  const info = createMemo(() => {
    return PROVIDER_INFO[props.provider as WebProviderType] ?? {
      name: props.provider,
      url: `https://${props.provider.replace("-web", "")}.com`,
      color: "#666",
    }
  })

  const [state, setState] = createStore({
    status: "idle" as "idle" | "launching" | "waiting" | "capturing" | "success" | "error",
    message: "",
    error: "",
  })

  const alive = { value: true }
  let abortController: AbortController | null = null

  onCleanup(() => {
    alive.value = false
    abortController?.abort()
  })

  async function startLogin() {
    if (alive.value === false) return

    abortController?.abort()
    abortController = new AbortController()
    const signal = abortController.signal

    setState("status", "launching")
    setState("message", language.t("provider.web.status.launching"))

    try {
      const baseUrl = server.current?.http.url
      if (!baseUrl) throw new Error("Server not connected")

      const http = server.current.http
      const headers: Record<string, string> = { "Content-Type": "application/json" }
      if (http.password) {
        headers.Authorization = `Basic ${btoa(`${http.username ?? "opencode"}:${http.password}`)}`
      }

      const url = `${baseUrl}/provider/${encodeURIComponent(props.provider)}/web-auth`

      const res = await fetch(url, {
        method: "POST",
        signal,
        headers,
      })

      if (!res.ok) {
        const body = await res.text().catch(() => "")
        try {
          const err = JSON.parse(body)
          throw new Error(err.message || err.error || body)
        } catch {
          throw new Error(`Server error ${res.status}: ${body.slice(0, 200)}`)
        }
      }

      if (!res.body) throw new Error("No response body")

      const ct = res.headers.get("content-type") ?? ""
      if (!ct.includes("text/event-stream")) {
        const text = await res.text().catch(() => "")
        throw new Error(text || `Unexpected response (content-type: ${ct})`)
      }

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
      let buffer = ""

      while (alive.value && !signal.aborted) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += value

        const chunks = buffer.split("\n\n")
        buffer = chunks.pop() ?? ""

        for (const chunk of chunks) {
          if (!alive.value || signal.aborted) return
          const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "))
          if (!dataLine) continue
          const raw = dataLine.slice(6)
          if (!raw) continue

          const event = JSON.parse(raw) as {
            status: string
            message: string
            credentials?: { accessToken: string; cookie: string; userAgent: string }
          }

          switch (event.status) {
            case "launching":
              setState("status", "launching")
              setState("message", event.message || language.t("provider.web.status.launching"))
              break
            case "waiting":
              setState("status", "waiting")
              setState("message", event.message || language.t("provider.web.status.waiting", { provider: info().name }))
              break
            case "capturing":
              setState("status", "capturing")
              setState("message", event.message || language.t("provider.web.status.capturing"))
              break
            case "success":
              setState("status", "success")
              setState("message", "")
              return
            case "error":
              throw new Error(event.message || language.t("provider.web.error.unknown"))
          }
        }
      }

      if (!alive.value) return
      if (state.status !== "success") {
        throw new Error(language.t("provider.web.error.unknown"))
      }
    } catch (e: unknown) {
      if (!alive.value) return
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes("abort") || msg.includes("AbortError")) return
      setState("status", "error")
      setState("error", msg)
    }
  }

  function goBack() {
    void import("./dialog-select-provider").then((x) => {
      dialog.show(() => <x.DialogSelectProvider />)
    })
  }

  async function complete() {
    await globalSDK.client.global.dispose()
    dialog.close()
    showToast({
      variant: "success",
      icon: "circle-check",
      title: language.t("provider.connect.toast.connected.title", { provider: info().name }),
      description: language.t("provider.web.toast.connected.description", { provider: info().name }),
    })
  }

  createEffect(() => {
    if (state.status === "success") {
      const timer = setTimeout(() => void complete(), 1000)
      onCleanup(() => clearTimeout(timer))
    }
  })

  onMount(() => {
    void startLogin()
  })

  return (
    <Dialog
      title={
        <IconButton
          tabIndex={-1}
          icon="arrow-left"
          variant="ghost"
          onClick={goBack}
          aria-label={language.t("common.goBack")}
        />
      }
    >
      <div class="flex flex-col gap-6 px-2.5 pb-3">
        <div class="px-2.5 flex gap-4 items-center">
          <ProviderIcon id={props.provider} class="size-5 shrink-0 icon-strong-base" />
          <div class="text-16-medium text-text-strong flex items-center gap-3">
            {language.t("provider.web.title", { provider: info().name })}
            <Tag>{language.t("provider.web.tag.free")}</Tag>
          </div>
        </div>

        <div class="px-2.5 pb-10 flex flex-col gap-6">
          <Switch>
            <Match when={state.status === "idle"}>
              <div class="contents" onClick={() => void startLogin()}>
                <Button size="large" variant="primary">
                  {language.t("provider.web.action.start")}
                </Button>
              </div>
            </Match>

            <Match when={state.status === "launching" || state.status === "waiting"}>
              <div class="flex flex-col gap-4 items-center py-6">
                <Spinner />
                <div class="text-14-regular text-text-base text-center">{state.message}</div>
                <div class="text-12-regular text-text-weak text-center max-w-[400px]">
                  {language.t("provider.web.hint.browser")}
                </div>
              </div>
            </Match>

            <Match when={state.status === "capturing"}>
              <div class="flex flex-col gap-4 items-center py-6">
                <Spinner />
                <div class="text-14-regular text-text-base text-center">
                  {language.t("provider.web.status.capturing")}
                </div>
              </div>
            </Match>

            <Match when={state.status === "success"}>
              <div class="flex flex-col gap-4 items-center py-6">
                <Icon name="circle-check" class="size-12 text-icon-success-base" />
                <div class="text-16-medium text-text-strong text-center">
                  {language.t("provider.web.success.title")}
                </div>
                <div class="text-14-regular text-text-weak text-center">
                  {language.t("provider.web.success.description", { provider: info().name })}
                </div>
              </div>
            </Match>

            <Match when={state.status === "error"}>
              <div class="flex flex-col gap-4 items-center py-6">
                <Icon name="circle-ban-sign" class="size-10 text-icon-critical-base" />
                <div class="text-16-medium text-text-strong text-center">
                  {language.t("provider.web.error.title")}
                </div>
                <div class="text-14-regular text-text-weak text-center max-w-[360px]">
                  {state.error || language.t("provider.web.error.unknown")}
                </div>
                <div class="flex gap-3 mt-2">
                  <div class="contents" onClick={() => { setState("error", ""); void startLogin() }}>
                    <Button size="large" variant="primary">
                      {language.t("provider.web.action.retry")}
                    </Button>
                  </div>
                  <div class="contents" onClick={goBack}>
                    <Button size="large" variant="ghost">
                      {language.t("common.goBack")}
                    </Button>
                  </div>
                </div>
              </div>
            </Match>
          </Switch>

          <Show when={state.status === "waiting"}>
            <div class="rounded-xl bg-surface-stronger p-4 flex flex-col gap-3">
              <div class="text-13-medium text-text-strong">
                {language.t("provider.web.steps.title")}
              </div>
              <ol class="list-decimal list-inside text-13-regular text-text-base space-y-2 pl-1">
                <li>{language.t("provider.web.steps.browserOpened")}</li>
                <li>
                  {language.t("provider.web.steps.login", {
                    provider: info().name,
                    url: info().url,
                  })}
                </li>
                <li>{language.t("provider.web.steps.autoDetect")}</li>
              </ol>
              <div class="mt-2 rounded-lg bg-critical-subtle/30 border border-critical-subtle p-3 flex gap-2">
                <Icon name="shield" class="size-4 shrink-0 text-icon-critical-base mt-0.5" />
                <span class="text-12-regular text-text-weak">
                  {language.t("provider.web.security.note")}
                </span>
              </div>
            </div>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}
