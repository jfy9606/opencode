/**
 * Per-model tool calling prompt templates.
 *
 * Reference:
 * - Paper: https://arxiv.org/html/2407.04997v1
 * - ComfyUI LLM Party: https://github.com/heshengtao/comfyui_LLM_party
 */

import { toolDefsJson } from "./web-tool-defs"

// Example-based teaching (key insight from arXiv:2407.04997 and ComfyUI LLM Party):
// A trivial example teaches the model the output format without confusing it with real tools.
const TOOL_EXAMPLE = `Example: to add 1 to number 5, return:
\`\`\`tool_json
{"tool":"plus_one","parameters":{"number":"5"}}
\`\`\`
(plus_one is just an example, not a real tool)`

/** No web models skip prompt injection — web interfaces don't pass native tools.
 *  Even DeepSeek/Claude/GLM need prompt injection when accessed via browser. */
const NATIVE_TOOL_MODELS = new Set<string>()

/** Models excluded from tool calling entirely */
const EXCLUDED_MODELS = new Set(["perplexity-web"])

/** Chinese-language models */
const CN_MODELS = new Set([
  "deepseek-web",
  "doubao-web",
  "qwen-cn-web",
  "kimi-web",
  "glm-web",
  "glm-intl-web",
  "xiaomimo-web",
])

/** Models that tend to add extra text after JSON */
const STRICT_MODELS = new Set(["chatgpt-web"])

export function shouldInjectToolPrompt(api: string): boolean {
  return !NATIVE_TOOL_MODELS.has(api) && !EXCLUDED_MODELS.has(api)
}

export function getToolPrompt(api: string, tools?: unknown[]): string {
  const defs = toolDefsJson(tools)
  if (STRICT_MODELS.has(api)) {
    return `Tools: ${defs}

${TOOL_EXAMPLE}

Your actual tools are listed above. To use one, reply ONLY with the tool_json block. No extra text.
No tool needed? Answer directly.

`
  }
  if (CN_MODELS.has(api)) {
    return `工具: ${defs}

示例: 要给数字5加1，返回:
\`\`\`tool_json
{"tool":"plus_one","parameters":{"number":"5"}}
\`\`\`
(plus_one仅为示例，非真实工具)

你的真实工具见上方列表。需要时只回复tool_json块。不需要则直接回答。

`
  }
  return `Tools: ${defs}

${TOOL_EXAMPLE}

Your actual tools are listed above. To use one, reply ONLY with the tool_json block.
No tool needed? Answer directly.

`
}

/** Format tool result for feedback to the model */
export function formatToolResult(toolName: string, result: string): string {
  return `Tool ${toolName} returned: ${result}\nPlease continue answering based on this result.`
}
