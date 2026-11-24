import fs from "node:fs"
import path from "node:path"

import type { EffortLevel, Options, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk"
import consola from "consola"
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"

import { runAgent } from "../lib/claude.ts"
import { anthropicErrorBody, HttpError, toHttpError } from "../lib/errors.ts"
import { checkRateLimit, manualApproval } from "../lib/guard.ts"
import { resolveModel } from "../lib/models.ts"
import { state } from "../lib/state.ts"
import { recordError, recordRequest } from "../lib/usage.ts"

interface AgentBody {
  prompt: string
  /** Folder to work in, relative to the server's --workspace (default: the workspace itself). */
  cwd?: string
  model?: string
  /** Tools that run without approval. Everything else is denied. Default: read-only tools. */
  allowed_tools?: string[]
  permission_mode?: "dontAsk" | "acceptEdits" | "plan"
  max_turns?: number
  /** Resume an earlier agent session (the session_id a previous response returned). */
  session_id?: string
  append_system_prompt?: string
  effort?: EffortLevel
  stream?: boolean
}

const DEFAULT_TOOLS = ["Read", "Glob", "Grep"]
const PERMISSION_MODES = new Set(["dontAsk", "acceptEdits", "plan"])

function resolveCwd(requested: string | undefined): string {
  const root = state.workspaceRoot
  const cwd = path.resolve(root, requested ?? ".")
  const rel = path.relative(root, cwd)
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new HttpError(403, `cwd must be inside the server workspace (${root})`, "permission_error")
  }
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new HttpError(400, `cwd does not exist: ${cwd}`, "invalid_request_error")
  }
  return cwd
}

function summary(result: SDKResultMessage) {
  return {
    session_id: result.session_id,
    subtype: result.subtype,
    is_error: result.is_error,
    result: result.subtype === "success" ? result.result : undefined,
    errors: result.subtype === "success" ? undefined : result.errors,
    num_turns: result.num_turns,
    duration_ms: result.duration_ms,
    total_cost_usd: result.total_cost_usd,
    usage: result.usage,
    model_usage: result.modelUsage,
    permission_denials: result.permission_denials,
  }
}

export const agentRoutes = new Hono()

agentRoutes.post("/query", async (c) => {
  if (!state.agentEnabled) {
    const e = new HttpError(404, "Agent mode is off. Start the server with --agent to enable it.", "not_found_error")
    return c.json(anthropicErrorBody(e), 404)
  }
  recordRequest()
  try {
    const body = await c.req.json<AgentBody>()
    if (!body.prompt || typeof body.prompt !== "string") {
      throw new HttpError(400, "prompt (string) is required", "invalid_request_error")
    }
    const mode = body.permission_mode ?? "dontAsk"
    if (!PERMISSION_MODES.has(mode)) {
      throw new HttpError(400, `permission_mode must be one of ${[...PERMISSION_MODES].join(", ")}`, "invalid_request_error")
    }
    const cwd = resolveCwd(body.cwd)
    const allowedTools = body.allowed_tools ?? DEFAULT_TOOLS
    await checkRateLimit()
    await manualApproval(`POST /v1/agent/query cwd=${cwd} tools=${allowedTools.join(",")}`)
    consola.info(`Agent run in ${cwd} (tools: ${allowedTools.join(", ")}; mode: ${mode})`)

    const events = runAgent({
      prompt: body.prompt,
      cwd,
      model: resolveModel(body.model),
      allowedTools,
      permissionMode: mode as Options["permissionMode"],
      maxTurns: Math.min(body.max_turns ?? 20, 100),
      resume: body.session_id,
      appendSystemPrompt: body.append_system_prompt,
      effort: body.effort,
      signal: c.req.raw.signal,
    })

    if (!body.stream) {
      let result: SDKResultMessage | undefined
      for await (const msg of events) if (msg.type === "result") result = msg
      if (!result) throw new HttpError(502, "Claude Code ended without a result")
      return c.json(summary(result), result.is_error ? 502 : 200)
    }

    return streamSSE(c, async (stream) => {
      try {
        for await (const msg of events) {
          if (msg.type === "stream_event") continue
          const data = msg.type === "result" ? { type: "result", ...summary(msg) } : msg
          await stream.writeSSE({ event: msg.type, data: JSON.stringify(data) })
        }
      } catch (err) {
        recordError()
        await stream.writeSSE({ event: "error", data: JSON.stringify(anthropicErrorBody(toHttpError(err))) })
      }
    })
  } catch (err) {
    recordError()
    const e = toHttpError(err)
    consola.error(`/v1/agent/query: ${e.message}`)
    return c.json(anthropicErrorBody(e), e.status as 400)
  }
})
