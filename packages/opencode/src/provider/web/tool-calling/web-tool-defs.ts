/**
 * Core tool definitions for web models.
 * Kept minimal (~350 chars total) to avoid triggering rate limits.
 */

export interface WebToolDef {
  name: string
  description: string
  parameters: Record<string, string>
}

export const WEB_CORE_TOOLS: WebToolDef[] = [
  { name: "web_search", description: "Search web", parameters: { query: "string" } },
  { name: "web_fetch", description: "Fetch URL", parameters: { url: "string" } },
  { name: "exec", description: "Run command", parameters: { command: "string" } },
  { name: "read", description: "Read file", parameters: { path: "string" } },
  { name: "write", description: "Write file", parameters: { path: "string", content: "string" } },
  { name: "message", description: "Send msg", parameters: { text: "string", channel: "string" } },
]

/** Compact JSON string of tool definitions */
export function toolDefsJson(tools?: unknown[]): string {
  return JSON.stringify(
    normalizeToolDefs(tools).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
  )
}

function normalizeToolDefs(tools?: unknown[]) {
  if (!tools?.length) return WEB_CORE_TOOLS

  return tools.flatMap((tool) => {
    const fn = getToolRecord(tool)
    if (!fn?.name || typeof fn.name !== "string") return []

    return [{
      name: fn.name,
      description: typeof fn.description === "string" ? fn.description : "",
      parameters: getToolParameters(fn.parameters),
    }]
  })
}

function getToolRecord(tool: unknown) {
  if (!tool || typeof tool !== "object") return undefined
  const record = tool as Record<string, unknown>
  if (record.function && typeof record.function === "object") {
    return record.function as Record<string, unknown>
  }
  return record
}

function getToolParameters(value: unknown) {
  if (!value || typeof value !== "object") return {}
  const properties = (value as Record<string, unknown>).properties
  if (!properties || typeof properties !== "object") return {}

  return Object.fromEntries(
    Object.entries(properties).flatMap(([key, property]) => {
      if (!property || typeof property !== "object") return []
      const type = (property as Record<string, unknown>).type
      return [[key, typeof type === "string" ? type : "string"]]
    }),
  )
}
