import type { WebAuthCredentials } from "./types.js"

type DeepSeekConversationState = {
  sessionID?: string
  parentMessageID?: string | number
}

const stateByConversation = new Map<string, DeepSeekConversationState>()

export function getDeepSeekConversationState(
  credentials: Pick<WebAuthCredentials, "bearer" | "cookie">,
  model?: string,
): DeepSeekConversationState {
  return stateByConversation.get(getDeepSeekConversationKey(credentials, model)) ?? {}
}

export function setDeepSeekSessionID(
  credentials: Pick<WebAuthCredentials, "bearer" | "cookie">,
  model: string | undefined,
  sessionID: string,
) {
  const key = getDeepSeekConversationKey(credentials, model)
  const current = stateByConversation.get(key) ?? {}
  stateByConversation.set(key, {
    ...current,
    sessionID,
  })
}

export function setDeepSeekParentMessageID(
  credentials: Pick<WebAuthCredentials, "bearer" | "cookie">,
  model: string | undefined,
  parentMessageID: string | number,
) {
  const key = getDeepSeekConversationKey(credentials, model)
  const current = stateByConversation.get(key) ?? {}
  stateByConversation.set(key, {
    ...current,
    parentMessageID,
  })
}

export function resetDeepSeekConversationState() {
  stateByConversation.clear()
}

function getDeepSeekConversationKey(
  credentials: Pick<WebAuthCredentials, "bearer" | "cookie">,
  model?: string,
) {
  return JSON.stringify([model ?? "default", credentials.bearer ?? "", credentials.cookie ?? ""])
}
