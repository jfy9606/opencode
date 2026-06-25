import { afterEach, describe, expect, test } from "bun:test"
import {
  getDeepSeekConversationState,
  resetDeepSeekConversationState,
  setDeepSeekParentMessageID,
  setDeepSeekSessionID,
} from "../../src/provider/web/deepseek-session-state"

afterEach(() => {
  resetDeepSeekConversationState()
})

describe("deepseek session state", () => {
  test("stores session and parent message IDs per credential and model", () => {
    const credentials = { cookie: "cookie-a", bearer: "bearer-a" }

    setDeepSeekSessionID(credentials, "deepseek-chat", "session-1")
    setDeepSeekParentMessageID(credentials, "deepseek-chat", "message-1")

    expect(getDeepSeekConversationState(credentials, "deepseek-chat")).toEqual({
      sessionID: "session-1",
      parentMessageID: "message-1",
    })
  })

  test("isolates conversations across models and credentials", () => {
    const credentialsA = { cookie: "cookie-a", bearer: "bearer-a" }
    const credentialsB = { cookie: "cookie-b", bearer: "bearer-b" }

    setDeepSeekSessionID(credentialsA, "deepseek-chat", "session-a")
    setDeepSeekParentMessageID(credentialsA, "deepseek-chat", "message-a")
    setDeepSeekSessionID(credentialsA, "deepseek-reasoner", "session-b")
    setDeepSeekSessionID(credentialsB, "deepseek-chat", "session-c")

    expect(getDeepSeekConversationState(credentialsA, "deepseek-chat")).toEqual({
      sessionID: "session-a",
      parentMessageID: "message-a",
    })
    expect(getDeepSeekConversationState(credentialsA, "deepseek-reasoner")).toEqual({
      sessionID: "session-b",
    })
    expect(getDeepSeekConversationState(credentialsB, "deepseek-chat")).toEqual({
      sessionID: "session-c",
    })
  })
})
