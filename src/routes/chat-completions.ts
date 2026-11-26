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
import type { ClientTool, ToolChoice } from "../lib/tools.ts"
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
  tools?: OpenAITool[]
  tool_choice?: "none" | "auto" | "required" | { type: "function"; function: { name: string } }
}

interface OpenAITool {
  type: string
  function?: { name: string; description?: string; parameters?: Record<string, unknown> }
}

/** OpenAI function tools -> client tools. Other tool types can't be offered and are skipped. */
export function toClientTools(tools: OpenAITool[] | undefined): ClientTool[] {
  const out: ClientTool[] = []
  for (const t of tools ?? []) {
    if (t.type !== "function" || !t.function?.name) {
      consola.warn(`Skipping tool of type "${t.type}": only function tools are supported`)
      continue
    }
    out.push({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters ?? { type: "object", properties: {} },
    })
  }
  return out
}

export function toToolChoice(choice: ChatCompletionsBody["tool_choice"]): ToolChoice | undefined {
  if (choice === undefined || choice === "auto") return undefined
  if (choice === "none") return { type: "none" }
  if (choice === "required") return { type: "any" }
  return { type: "tool", name: choice.function.name }
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
  const toolNames = new Map<string, string>()
  // Consecutive user turns (several tool results, or results then a user message) become one turn.
  const pushUser = (blocks: Anthropic.ContentBlockParam[]) => {
    const prev = out[out.length - 1]
    if (prev?.role === "user" && Array.isArray(prev.content)) prev.content.push(...blocks)
    else out.push({ role: "user", content: blocks })
  }
  for (const m of messages) {
    if (m.role === "system" || m.role === "developer") {
      system.push(partsToText(m.content))
    } else if (m.role === "user") {
      pushUser(partsToBlocks(m.content))
    } else if (m.role === "assistant") {
      for (const t of m.tool_calls ?? []) toolNames.set(t.id, t.function.name)
      const text = [
        partsToText(m.content),
        ...(m.tool_calls ?? []).map((t) => `[called tool ${t.function.name} (call ${t.id}) with ${t.function.arguments}]`),
      ]
        .filter(Boolean)
        .join("\n")
      out.push({ role: "assistant", content: text })
    } else if (m.role === "tool") {
      const id = m.tool_call_id ?? ""
      const name = toolNames.get(id)
      pushUser([{ type: "text", text: `[tool result${name ? ` from ${name}` : ""} (call ${id}): ${partsToText(m.content)}]` }])
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
    await checkRateLimit()
    await manualApproval(`POST /v1/chat/completions model=${body.model ?? "default"}`)

    const { system, messages } = fromOpenAI(body.messages)
    const req = {
      model: resolveModel(body.model),
      system,
      prompt: buildUserMessage(messages),
      effort: toEffort(body.reasoning_effort),
      tools: toClientTools(body.tools),
      toolChoice: toToolChoice(body.tool_choice),
      signal: c.req.raw.signal,
    }
    const created = Math.floor(Date.now() / 1000)

    if (!body.stream) {
      const { message } = await completeChat(req)
      const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("")
      const reasoning = message.content.flatMap((b) => (b.type === "thinking" ? [b.thinking] : [])).join("")
      const toolCalls = message.content.flatMap((b) =>
        b.type === "tool_use"
          ? [{ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }]
          : [],
      )
      return c.json({
        id: `chatcmpl-${message.id}`,
        object: "chat.completion",
        created,
        model: message.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: toolCalls.length && !text ? null : text,
              ...(reasoning ? { reasoning_content: reasoning } : {}),
              ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
            },
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
      // Content block index -> position in the OpenAI tool_calls array.
      const toolIndex = new Map<number, number>()
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
            } else if (e.type === "content_block_start" && e.content_block.type === "tool_use") {
              const index = toolIndex.size
              toolIndex.set(e.index, index)
              await chunk({
                tool_calls: [{ index, id: e.content_block.id, type: "function", function: { name: e.content_block.name, arguments: "" } }],
              })
            } else if (e.type === "content_block_delta") {
              if (e.delta.type === "text_delta") await chunk({ content: e.delta.text })
              else if (e.delta.type === "thinking_delta") await chunk({ reasoning_content: e.delta.thinking })
              else if (e.delta.type === "input_json_delta" && e.delta.partial_json && toolIndex.has(e.index)) {
                await chunk({ tool_calls: [{ index: toolIndex.get(e.index), function: { arguments: e.delta.partial_json } }] })
              }
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
