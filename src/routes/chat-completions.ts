import type Anthropic from "@anthropic-ai/sdk"
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk"
import consola from "consola"
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"

import { completeChat, runChat, type FinalMessage } from "../lib/claude.ts"
import { HttpError, openAIErrorBody, toHttpError } from "../lib/errors.ts"
import { checkRateLimit, manualApproval } from "../lib/guard.ts"
import { resolveModel } from "../lib/models.ts"
import { buildUserMessage } from "../lib/prompt.ts"
import { recordError, recordRequest } from "../lib/usage.ts"

type OpenAIPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } | string }

interface OpenAIMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool"
  content?: string | OpenAIPart[] | null
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

interface ChatCompletionsBody {
  model?: string
  messages: OpenAIMessage[]
  stream?: boolean
  stream_options?: { include_usage?: boolean }
  max_tokens?: number
  max_completion_tokens?: number
  reasoning_effort?: string
  tools?: unknown[]
}

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"])

function toEffort(value: string | undefined): EffortLevel | undefined {
  if (!value) return undefined
  if (value === "minimal" || value === "none") return "low"
  return EFFORTS.has(value) ? (value as EffortLevel) : undefined
}

function partsToBlocks(content: OpenAIMessage["content"]): Anthropic.ContentBlockParam[] {
  if (content == null) return []
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : []
  return content.map((part): Anthropic.ContentBlockParam => {
    if (part.type === "text") return { type: "text", text: part.text }
    const url = typeof part.image_url === "string" ? part.image_url : part.image_url.url
    const data = /^data:(image\/[a-z+]+);base64,(.*)$/s.exec(url)
    if (data) {
      return {
        type: "image",
        source: { type: "base64", media_type: data[1] as "image/png", data: data[2]! },
      }
    }
    return { type: "image", source: { type: "url", url } }
  })
}

function partsToText(content: OpenAIMessage["content"]): string {
  if (content == null) return ""
  if (typeof content === "string") return content
  return content.map((p) => (p.type === "text" ? p.text : "")).join("\n")
}

/** OpenAI chat messages -> system prompt + Anthropic-style messages. */
export function fromOpenAI(messages: OpenAIMessage[]): { system?: string; messages: Anthropic.MessageParam[] } {
  const system: string[] = []
  const out: Anthropic.MessageParam[] = []
  for (const m of messages) {
    if (m.role === "system" || m.role === "developer") {
      system.push(partsToText(m.content))
    } else if (m.role === "user") {
      out.push({ role: "user", content: partsToBlocks(m.content) })
    } else if (m.role === "assistant") {
      const text = [
        partsToText(m.content),
        ...(m.tool_calls ?? []).map((t) => `[called tool ${t.function.name} with ${t.function.arguments}]`),
      ]
        .filter(Boolean)
        .join("\n")
      out.push({ role: "assistant", content: text })
    } else if (m.role === "tool") {
      out.push({ role: "user", content: `[tool result ${m.tool_call_id ?? ""}: ${partsToText(m.content)}]` })
    }
  }
  return { system: system.length ? system.join("\n\n") : undefined, messages: out }
}

function finishReason(stop: string | null | undefined): string {
  switch (stop) {
    case "max_tokens":
      return "length"
    case "refusal":
      return "content_filter"
    case "tool_use":
      return "tool_calls"
    default:
      return "stop"
  }
}

function openAIUsage(u: Partial<FinalMessage["usage"]> | undefined) {
  const prompt = (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0)
  const completion = u?.output_tokens ?? 0
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: u?.cache_read_input_tokens ?? 0 },
  }
}

export const chatCompletionsRoutes = new Hono()

chatCompletionsRoutes.post("/", async (c) => {
  recordRequest()
  try {
    const body = await c.req.json<ChatCompletionsBody>()
    if (!Array.isArray(body.messages)) throw new HttpError(400, "messages is required", "invalid_request_error")
    if (body.tools?.length) {
      consola.warn("Request includes tools; they are ignored (Claude Code backend runs without client tools)")
    }
    await checkRateLimit()
    await manualApproval(`POST /v1/chat/completions model=${body.model ?? "default"}`)

    const { system, messages } = fromOpenAI(body.messages)
    const req = {
      model: resolveModel(body.model),
      system,
      prompt: buildUserMessage(messages),
      effort: toEffort(body.reasoning_effort),
      signal: c.req.raw.signal,
    }
    const created = Math.floor(Date.now() / 1000)

    if (!body.stream) {
      const { message } = await completeChat(req)
      const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("")
      const reasoning = message.content.flatMap((b) => (b.type === "thinking" ? [b.thinking] : [])).join("")
      return c.json({
        id: `chatcmpl-${message.id}`,
        object: "chat.completion",
        created,
        model: message.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: text, ...(reasoning ? { reasoning_content: reasoning } : {}) },
            finish_reason: finishReason(message.stop_reason),
          },
        ],
        usage: openAIUsage(message.usage),
      })
    }

    const events = runChat(req)
    const first = await events.next()
    return streamSSE(c, async (stream) => {
      let id = "chatcmpl-unknown"
      let model = req.model ?? "claude"
      let usage: Partial<FinalMessage["usage"]> = {}
      const chunk = (delta: object, finish: string | null = null) =>
        stream.writeSSE({
          data: JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta, finish_reason: finish }],
          }),
        })
      try {
        let next = first
        while (!next.done) {
          const ev = next.value
          if (ev.kind === "event") {
            const e = ev.event
            if (e.type === "message_start") {
              id = `chatcmpl-${e.message.id}`
              model = e.message.model
              usage = { ...e.message.usage }
              await chunk({ role: "assistant", content: "" })
            } else if (e.type === "content_block_delta") {
              if (e.delta.type === "text_delta") await chunk({ content: e.delta.text })
              else if (e.delta.type === "thinking_delta") await chunk({ reasoning_content: e.delta.thinking })
            } else if (e.type === "message_delta") {
              for (const [k, v] of Object.entries(e.usage)) if (v != null) (usage as Record<string, unknown>)[k] = v
              await chunk({}, finishReason(e.delta.stop_reason))
            }
          }
          next = await events.next()
        }
        if (body.stream_options?.include_usage) {
          await stream.writeSSE({
            data: JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage: openAIUsage(usage) }),
          })
        }
      } catch (err) {
        recordError()
        await stream.writeSSE({ data: JSON.stringify(openAIErrorBody(toHttpError(err))) })
      }
      await stream.writeSSE({ data: "[DONE]" })
    })
  } catch (err) {
    recordError()
    const e = toHttpError(err)
    consola.error(`/v1/chat/completions: ${e.message}`)
    return c.json(openAIErrorBody(e), e.status as 400)
  }
})
