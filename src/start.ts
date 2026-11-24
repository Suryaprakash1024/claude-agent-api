import path from "node:path"

import { serve } from "@hono/node-server"
import { defineCommand } from "citty"
import consola from "consola"

import { probe } from "./lib/claude.ts"
import { setLiveModels } from "./lib/models.ts"
import { state } from "./lib/state.ts"
import { createServer, setAccountInfo } from "./server.ts"

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"])

export const start = defineCommand({
  meta: { name: "start", description: "Start the OpenAI/Anthropic-compatible API server backed by Claude Code" },
  args: {
    port: { type: "string", alias: "p", default: "4141", description: "Port to listen on" },
    host: { type: "string", default: "127.0.0.1", description: "Interface to bind (use 0.0.0.0 only with --api-key)" },
    verbose: { type: "boolean", alias: "v", default: false, description: "Verbose logging, including Claude Code's stderr" },
    model: { type: "string", alias: "m", description: "Default model (alias like 'sonnet' or an ID like 'claude-sonnet-5-5')" },
    "api-key": { type: "string", alias: "k", description: "Require clients to send this key (Bearer or x-api-key). Also read from CLAUDE_AGENT_API_KEY" },
    manual: { type: "boolean", default: false, description: "Approve each request manually in this terminal" },
    "rate-limit": { type: "string", alias: "r", description: "Minimum seconds between requests" },
    wait: { type: "boolean", alias: "w", default: false, description: "Wait for the rate-limit cooldown instead of returning 429" },
    concurrency: { type: "string", alias: "c", default: "4", description: "Max Claude Code processes at once" },
    agent: { type: "boolean", default: false, description: "Enable POST /v1/agent/query (Claude Code with tools)" },
    workspace: { type: "string", description: "Folder agent requests may work in (default: current folder)" },
    "claude-path": { type: "string", description: "Path to a claude executable to use instead of the SDK's bundled one" },
    "skip-probe": { type: "boolean", default: false, description: "Don't start Claude Code at launch to read account and models" },
  },
  async run({ args }) {
    state.port = Number.parseInt(args.port, 10)
    state.host = args.host
    state.verbose = args.verbose
    state.defaultModel = args.model
    state.apiKey = args["api-key"] ?? process.env.CLAUDE_AGENT_API_KEY
    state.manualApprove = args.manual
    state.rateLimitSeconds = args["rate-limit"] ? Number.parseFloat(args["rate-limit"]) : undefined
    state.rateLimitWait = args.wait
    state.maxConcurrency = Math.max(1, Number.parseInt(args.concurrency, 10) || 4)
    state.agentEnabled = args.agent
    state.workspaceRoot = path.resolve(args.workspace ?? process.cwd())
    state.claudePath = args["claude-path"]
    if (state.verbose) consola.level = 4

    if (!LOOPBACK.has(state.host) && !state.apiKey) {
      consola.warn(`Binding to ${state.host} without --api-key: anyone who can reach this port can use your Claude account.`)
    }

    if (!args["skip-probe"]) {
      consola.start("Starting Claude Code to read the account and model list...")
      try {
        const { account, models } = await probe()
        setLiveModels(models)
        setAccountInfo(account as Record<string, unknown>)
        const who = account.email ?? account.organization ?? "unknown account"
        consola.success(`Claude Code is signed in: ${who} (${account.subscriptionType ?? account.apiKeySource ?? account.tokenSource ?? "auth"})`)
        consola.info(`Models: ${models.map((m) => m.value).join(", ")}`)
        if (account.subscriptionType && !process.env.ANTHROPIC_API_KEY) {
          consola.box(
            "This server is using your Claude subscription login.\n" +
              "Anthropic does not allow offering claude.ai login or rate limits to others.\n" +
              "Keep this server for your own use, or set ANTHROPIC_API_KEY to bill an API key.",
          )
        }
      } catch (err) {
        consola.warn(`Could not read account/models from Claude Code: ${err instanceof Error ? err.message : err}`)
        consola.warn("Run `claude-agent-api auth` (or `claude auth login`) if Claude Code is not signed in.")
      }
    }

    const app = createServer()
    serve({ fetch: app.fetch, port: state.port, hostname: state.host }, () => {
      const base = `http://${state.host === "0.0.0.0" ? "localhost" : state.host}:${state.port}`
      consola.box(
        [
          `claude-agent-api listening on ${base}`,
          "",
          `OpenAI:     ${base}/v1/chat/completions   ${base}/v1/models`,
          `Anthropic:  ${base}/v1/messages           ${base}/v1/messages/count_tokens`,
          `Agent:      ${base}/v1/agent/query        ${state.agentEnabled ? `(on, workspace ${state.workspaceRoot})` : "(off: --agent)"}`,
          `Usage:      ${base}/usage`,
          "",
          "OpenAI clients:    OPENAI_BASE_URL=" + `${base}/v1` + "  OPENAI_API_KEY=" + (state.apiKey ? "<your --api-key>" : "dummy"),
          "Anthropic clients: ANTHROPIC_BASE_URL=" + base + "  ANTHROPIC_API_KEY=" + (state.apiKey ? "<your --api-key>" : "dummy"),
        ].join("\n"),
      )
    })
  },
})
