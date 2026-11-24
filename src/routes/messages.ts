import type Anthropic from "@anthropic-ai/sdk"
import type { EffortLevel, ThinkingConfig } from "@anthropic-ai/claude-agent-sdk"
import consola from "consola"
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"

import { completeChat, runChat, type ChatRequest } from "../lib/claude.ts"
import { anthropicErrorBody, HttpError, toHttpError } from "../lib/errors.ts"
import { checkRateLimit, manualApproval } from "../lib/guard.ts"
import { resolveModel } from "../lib/models.ts"
import { buildUserMessage, contentToText } from "../lib/prompt.ts"
import { recordError, recordRequest } from "../lib/usage.ts"

/** The parts of a Messages API request this server understands. */
interface MessagesBody {
  model?: string
  messages: Anthropic.MessageParam[]
  system?: string | Anthropic.TextBlockParam[]
  max_tokens?: number
  stream?: boolean
  tools?: unknown[]
  thinking?: { type: "adaptive" | "enabled" | "disabled"; display?: "summarized" | "omitted" }
  output_config?: { effort?: EffortLevel }
}

function systemText(system: MessagesBody["system"]): string | undefined {
  if (!system) return undefined
  return typeof system === "string" ? system : system.map((b) => b.text).join("\n\n")
}

function thinkingConfig(t: MessagesBody["thinking"]): ThinkingConfig | undefined {
  if (!t) return undefined
  if (t.type === "disabled") return { type: "disabled" }
  return { type: "adaptive", display: t.display }
}

export function toChatRequest(body: MessagesBody, signal: AbortSignal): ChatRequest {
  if (!Array.isArray(body.messages)) throw new HttpError(400, "messages is required", "invalid_request_error")
  if (body.tools?.length) {
    consola.warn("Request includes client-defined tools; they are ignored (Claude Code backend runs without client tools)")
  }
  return {
    model: resolveModel(body.model),
    system: systemText(body.system),
    prompt: buildUserMessage(body.messages),
    maxTokens: body.max_tokens,
    effort: body.output_config?.effort,
    thinking: thinkingConfig(body.thinking),
    signal,
  }
}

export const messagesRoutes = new Hono()

messagesRoutes.post("/", async (c) => {
  recordRequest()
  try {
    const body = await c.req.json<MessagesBody>()
    await checkRateLimit()
    await manualApproval(`POST /v1/messages model=${body.model ?? "default"}`)
    const req = toChatRequest(body, c.req.raw.signal)

    if (!body.stream) {
      const { message } = await completeChat(req)
      return c.json(message)
    }

    // Get the first event before committing to a 200, so early errors return a status code.
    const events = runChat(req)
    const first = await events.next()
    return streamSSE(c, async (stream) => {
      try {
        let next = first
        while (!next.done) {
          const ev = next.value
          if (ev.kind === "event") await stream.writeSSE({ event: ev.event.type, data: JSON.stringify(ev.event) })
          next = await events.next()
        }
      } catch (err) {
        const e = toHttpError(err)
        recordError()
        await stream.writeSSE({ event: "error", data: JSON.stringify(anthropicErrorBody(e)) })
      }
    })
  } catch (err) {
    recordError()
    const e = toHttpError(err)
    consola.error(`/v1/messages: ${e.message}`)
    return c.json(anthropicErrorBody(e), e.status as 400)
  }
})

/**
 * Claude Code has no token-count call. With ANTHROPIC_API_KEY set this asks the
 * API; otherwise it returns an estimate (about 4 characters per token).
 */
messagesRoutes.post("/count_tokens", async (c) => {
  try {
    const body = await c.req.json<MessagesBody>()
    if (process.env.ANTHROPIC_API_KEY) {
      const { default: AnthropicClient } = await import("@anthropic-ai/sdk")
      const client = new AnthropicClient()
      const count = await client.messages.countTokens({
        model: resolveModel(body.model) ?? "claude-opus-5-5",
        messages: body.messages,
        ...(body.system ? { system: body.system } : {}),
      })
      return c.json(count)
    }
    const chars =
      (systemText(body.system)?.length ?? 0) + body.messages.reduce((n, m) => n + contentToText(m.content).length, 0)
    c.header("x-token-count-estimated", "true")
    return c.json({ input_tokens: Math.ceil(chars / 4) })
  } catch (err) {
    const e = toHttpError(err)
    return c.json(anthropicErrorBody(e), e.status as 400)
  }
})
