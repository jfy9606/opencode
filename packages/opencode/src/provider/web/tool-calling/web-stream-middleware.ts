/**
 * Web Stream Middleware — unified input/output processing for all web models.
 *
 * Input:  extract last user message → strip metadata → inject tool prompt
 * Output: parse tool calls from response → emit ToolCall events
 *
 * This middleware replaces the per-stream prompt manipulation that was
 * previously duplicated across 13 stream files.
 */

import { extractToolCall } from "./web-tool-parser"
import { shouldInjectToolPrompt, getToolPrompt } from "./web-tool-prompt"

/**
 * Quick keyword check: does this message likely need tool use?
 * Only inject tool prompt when keywords suggest a tool action,
 * keeping normal chat messages short to reduce ban risk.
 */
function needsToolInjection(message: string): boolean {
  const lower = message.toLowerCase()
  const keywords = [
    // File operations
    "文件",
    "file",
    "read",
    "write",
    "创建",
    "写入",
    "读取",
    "打开",
    "保存",
    "桌面",
    "desktop",
    "目录",
    "directory",
    "folder",
    "文件夹",
    // Command execution
    "执行",
    "运行",
    "命令",
    "command",
    "run",
    "exec",
    "terminal",
    "终端",
    "shell",
    // Web operations
    "搜索",
    "search",
    "查找",
    "查询",
    "fetch",
    "抓取",
    "网页",
    "url",
    "http",
    "天气",
    "weather",
    "新闻",
    "news",
    // Message
    "发送",
    "send",
    "消息",
    "message",
    "通知",
    "notify",
    // General tool hints
    "帮我",
    "help me",
    "查看",
    "check",
    "look",
    "看看",
    "show",
    "下载",
    "download",
    "安装",
    "install",
    "更新",
    "update",
  ]
  return keywords.some((kw) => lower.includes(kw))
}

/**
 * Check if tool calling should be enabled for a given message and API.
 * Returns the tool prompt if injection is needed, null otherwise.
 */
export function evaluateToolInjection(userMessage: string, api: string, hasAgentTools: boolean): string | null {
  if (!shouldInjectToolPrompt(api)) return null
  if (!hasAgentTools) return null
  if (!needsToolInjection(userMessage)) return null

  return getToolPrompt(api)
}

/**
 * Parse tool call from accumulated response text.
 * Returns parsed tool call or null if not found.
 */
export function parseToolCallFromResponse(accumulatedText: string): { tool: string; parameters: Record<string, unknown> } | null {
  return extractToolCall(accumulatedText)
}

/** Check if text contains a tool call (quick check without full parsing) */
export function containsToolCall(text: string): boolean {
  const FENCED_REGEX = /```tool_json\s*\n?\s*(\{[\s\S]*?\})\}?\s*\n?\s*```/
  const BARE_JSON_REGEX = /\{\s*"tool"\s*:\s*"([^"]+)"\s*,\s*"parameters"\s*:\s*(\{[\s\S]*?\})\s*\}/
  const XML_TOOL_REGEX = /<tool_call[^>]*>([\s\S]*?)<\/tool_call>/

  return FENCED_REGEX.test(text) || BARE_JSON_REGEX.test(text) || XML_TOOL_REGEX.test(text)
}
