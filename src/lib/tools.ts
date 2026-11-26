import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

import { APP_VERSION } from "./state.ts"

/** A tool the API client defines and runs itself (OpenAI function / Anthropic custom tool). */
export interface ClientTool {
  name: string
  description?: string
  input_schema: Record<string, unknown>
}

/** Normalized tool_choice (Anthropic shape). */
export type ToolChoice = { type: "auto" } | { type: "any" } | { type: "tool"; name: string } | { type: "none" }

const SERVER_NAME = "client"
const PREFIX = `mcp__${SERVER_NAME}__`

/** Claude Code shows MCP tools to the model as `mcp__<server>__<name>`; give the client back its own name. */
export function clientToolName(name: string): string {
  return name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name
}

/**
 * An in-process MCP server that only advertises the client's tools, with their JSON
 * Schemas passed through unchanged. Calls are never run here: runChat denies them and
 * returns the tool_use block to the client, which runs the tool and sends the result
 * back in its next request.
 */
export function clientToolServer(tools: ClientTool[]): McpSdkServerConfigWithInstance {
  const mcp = new McpServer({ name: SERVER_NAME, version: APP_VERSION }, { capabilities: { tools: {} } })
  // Low-level handlers instead of registerTool(), which needs Zod schemas.
  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: { ...t.input_schema, type: "object" as const },
    })),
  }))
  mcp.server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text" as const, text: "This tool is run by the API client, not by the server." }],
    isError: true,
  }))
  return { type: "sdk", name: SERVER_NAME, instance: mcp }
}

/** Claude Code can't force a tool choice, so required choices become a system-prompt instruction. */
export function toolChoiceInstruction(choice: ToolChoice | undefined): string | undefined {
  if (choice?.type === "any") return "In this reply you must call at least one of the available tools."
  if (choice?.type === "tool") return `In this reply you must call the tool \`${PREFIX}${choice.name}\`.`
  return undefined
}
