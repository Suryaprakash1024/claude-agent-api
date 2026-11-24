import path from "node:path"

export interface ServerState {
  port: number
  host: string
  verbose: boolean
  /** Model used when a request names no model or a non-Claude model (e.g. "gpt-4o"). Undefined = Claude Code's default. */
  defaultModel?: string
  /** Optional shared secret clients must send as `Authorization: Bearer` or `x-api-key`. */
  apiKey?: string
  /** Require interactive approval of each request in the server terminal. */
  manualApprove: boolean
  /** Minimum seconds between requests. */
  rateLimitSeconds?: number
  /** Wait out the rate-limit cooldown instead of returning 429. */
  rateLimitWait: boolean
  /** Max Claude Code processes running at once. */
  maxConcurrency: number
  /** Enables POST /v1/agent/query (Claude Code with its tools). */
  agentEnabled: boolean
  /** Agent requests may only run inside this folder. */
  workspaceRoot: string
  /** Explicit path to a `claude` executable (otherwise the SDK's bundled binary). */
  claudePath?: string
}

export const state: ServerState = {
  port: 4141,
  host: "127.0.0.1",
  verbose: false,
  manualApprove: false,
  rateLimitWait: false,
  maxConcurrency: 4,
  agentEnabled: false,
  workspaceRoot: path.resolve(process.cwd()),
}

export const APP_NAME = "claude-code-api"
export const APP_VERSION = "0.1.0"
