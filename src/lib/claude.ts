import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type Anthropic from "@anthropic-ai/sdk"
import {
  query,
  type AccountInfo,
  type EffortLevel,
  type ModelInfo,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  type ThinkingConfig,
} from "@anthropic-ai/claude-agent-sdk"
import consola from "consola"

import { HttpError, statusForSdkError } from "./errors.ts"
import { slots } from "./guard.ts"
import { contentToText, singleTurn } from "./prompt.ts"
import { APP_NAME, APP_VERSION, state } from "./state.ts"
import { recordResult } from "./usage.ts"

export type StreamEvent = Anthropic.Beta.BetaRawMessageStreamEvent
export type FinalMessage = Anthropic.Beta.BetaMessage

export interface ChatRequest {
  model?: string
  system?: string
  prompt: SDKUserMessage
  maxTokens?: number
  effort?: EffortLevel
  thinking?: ThinkingConfig
  signal?: AbortSignal
}

/** What runChat yields: raw Messages API stream events, then the query's result. */
export type ChatEvent = { kind: "event"; event: StreamEvent } | { kind: "result"; result: SDKResultMessage }

function sdkEnv(extra: Record<string, string> = {}): Options["env"] {
  return { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: `${APP_NAME}/${APP_VERSION}`, ...extra }
}

function commonOptions(): Partial<Options> {
  return {
    pathToClaudeCodeExecutable: state.claudePath,
    stderr: state.verbose ? (line) => consola.debug(`[claude] ${line.trimEnd()}`) : undefined,
  }
}

/**
 * Claude Code always tells the model its working folder. Chat requests run in an
 * empty folder so nothing about the server's own folder leaks into replies.
 */
let chatDir: string | undefined
function chatCwd(): string {
  if (!chatDir) {
    chatDir = path.join(os.tmpdir(), APP_NAME, "chat")
    fs.mkdirSync(chatDir, { recursive: true })
  }
  return chatDir
}

function linkAbort(signal: AbortSignal | undefined): AbortController {
  const controller = new AbortController()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener("abort", () => controller.abort(), { once: true })
  }
  return controller
}

function assistantErrorText(msg: Extract<SDKMessage, { type: "assistant" }>): string {
  const text = contentToText(msg.message.content as Anthropic.MessageParam["content"])
  return text || `Claude Code error: ${msg.error}`
}

function resultError(result: SDKResultMessage): HttpError | undefined {
  if (result.subtype !== "success") {
    return new HttpError(502, result.errors?.join("; ") || `Claude Code stopped: ${result.subtype}`)
  }
  if (result.is_error) {
    return new HttpError(result.api_error_status ?? 502, result.result || "Claude Code returned an error")
  }
  return undefined
}

/**
 * Plain-model mode: Claude Code with no tools, no settings files, no saved session,
 * and the caller's system prompt in place of Claude Code's. Yields the Messages API
 * stream events of the reply, then the result.
 */
export async function* runChat(req: ChatRequest): AsyncGenerator<ChatEvent> {
  const release = await slots.acquire()
  const abortController = linkAbort(req.signal)
  const options: Options = {
    ...commonOptions(),
    model: req.model,
    systemPrompt: req.system ?? "You are a helpful assistant.",
    cwd: chatCwd(),
    tools: [],
    settingSources: [],
    persistSession: false,
    maxTurns: 1,
    includePartialMessages: true,
    abortController,
    effort: req.effort,
    thinking: req.thinking,
    env: sdkEnv(req.maxTokens ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(req.maxTokens) } : {}),
  }

  let sawMessageStop = false
  let sawAnyEvent = false
  try {
    for await (const msg of query({ prompt: singleTurn(req.prompt), options })) {
      if (msg.type === "stream_event") {
        // Forward only the first top-level reply; ignore anything after it.
        if (msg.parent_tool_use_id !== null || sawMessageStop) continue
        sawAnyEvent = true
        if (msg.event.type === "message_stop") sawMessageStop = true
        yield { kind: "event", event: msg.event }
      } else if (msg.type === "assistant" && msg.error && !sawAnyEvent) {
        throw new HttpError(statusForSdkError(msg.error), assistantErrorText(msg), msg.error)
      } else if (msg.type === "result") {
        recordResult(msg)
        const err = resultError(msg)
        if (err && !sawAnyEvent) throw err
        yield { kind: "result", result: msg }
      }
    }
  } finally {
    abortController.abort()
    release()
  }
}

/** Rebuilds a complete Messages API response from stream events. */
export class MessageAccumulator {
  message: FinalMessage | undefined
  private readonly partialJson = new Map<number, string>()

  push(event: StreamEvent) {
    switch (event.type) {
      case "message_start":
        this.message = structuredClone(event.message)
        this.message.content = []
        break
      case "content_block_start":
        this.message?.content.splice(event.index, 0, structuredClone(event.content_block))
        break
      case "content_block_delta": {
        const block = this.message?.content[event.index] as unknown as Record<string, unknown> | undefined
        if (!block) break
        const d = event.delta
        if (d.type === "text_delta") block.text = String(block.text ?? "") + d.text
        else if (d.type === "thinking_delta") block.thinking = String(block.thinking ?? "") + d.thinking
        else if (d.type === "signature_delta") block.signature = d.signature
        else if (d.type === "input_json_delta") {
          this.partialJson.set(event.index, (this.partialJson.get(event.index) ?? "") + d.partial_json)
        }
        break
      }
      case "content_block_stop": {
        const json = this.partialJson.get(event.index)
        const block = this.message?.content[event.index] as unknown as Record<string, unknown> | undefined
        if (json !== undefined && block) {
          try {
            block.input = JSON.parse(json)
          } catch {
            block.input = {}
          }
        }
        break
      }
      case "message_delta":
        if (this.message) {
          this.message.stop_reason = event.delta.stop_reason
          this.message.stop_sequence = event.delta.stop_sequence
          this.message.usage = { ...this.message.usage, ...stripNulls(event.usage) } as FinalMessage["usage"]
        }
        break
    }
  }

  text(): string {
    return (this.message?.content ?? [])
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
  }

  thinking(): string {
    return (this.message?.content ?? [])
      .filter((b): b is Anthropic.Beta.BetaThinkingBlock => b.type === "thinking")
      .map((b) => b.thinking)
      .join("")
  }
}

function stripNulls<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined)) as Partial<T>
}

/** Run a chat request to completion and return the assembled message. */
export async function completeChat(req: ChatRequest): Promise<{ message: FinalMessage; result?: SDKResultMessage }> {
  const acc = new MessageAccumulator()
  let result: SDKResultMessage | undefined
  for await (const ev of runChat(req)) {
    if (ev.kind === "event") acc.push(ev.event)
    else result = ev.result
  }
  if (!acc.message) {
    const text = result?.subtype === "success" ? result.result : ""
    throw new HttpError(502, `Claude Code returned no message${text ? `: ${text}` : ""}`)
  }
  return { message: acc.message, result }
}

export interface AgentRequest {
  prompt: string
  cwd: string
  model?: string
  allowedTools?: string[]
  permissionMode?: Options["permissionMode"]
  maxTurns?: number
  resume?: string
  appendSystemPrompt?: string
  effort?: EffortLevel
  signal?: AbortSignal
}

/**
 * Agent mode: full Claude Code (tools, CLAUDE.md, saved sessions) in a folder.
 * Tools not in `allowedTools` are denied, since nobody is there to approve them.
 */
export async function* runAgent(req: AgentRequest): AsyncGenerator<SDKMessage> {
  const release = await slots.acquire()
  const abortController = linkAbort(req.signal)
  const options: Options = {
    ...commonOptions(),
    model: req.model,
    cwd: req.cwd,
    systemPrompt: { type: "preset", preset: "claude_code", append: req.appendSystemPrompt },
    tools: { type: "preset", preset: "claude_code" },
    allowedTools: req.allowedTools,
    permissionMode: req.permissionMode,
    settingSources: ["project"],
    maxTurns: req.maxTurns,
    resume: req.resume,
    effort: req.effort,
    abortController,
    env: sdkEnv(),
  }
  try {
    for await (const msg of query({ prompt: req.prompt, options })) {
      if (msg.type === "result") recordResult(msg)
      yield msg
    }
  } finally {
    abortController.abort()
    release()
  }
}

export interface ProbeResult {
  account: AccountInfo
  models: ModelInfo[]
}

/**
 * Start Claude Code without sending a prompt, to read the signed-in account and
 * the models it offers. Makes no model call.
 */
export async function probe(timeoutMs = 60_000): Promise<ProbeResult> {
  const abortController = new AbortController()
  let finish!: () => void
  const done = new Promise<void>((r) => (finish = r))
  async function* idle(): AsyncGenerator<SDKUserMessage> {
    await done
  }
  const q = query({
    prompt: idle(),
    options: {
      ...commonOptions(),
      cwd: chatCwd(),
      tools: [],
      settingSources: [],
      persistSession: false,
      abortController,
      env: sdkEnv(),
    },
  })
  // Drain messages so the process isn't blocked on output.
  const drain = (async () => {
    try {
      for await (const _ of q) {
        // ignore
      }
    } catch {
      // aborted
    }
  })()
  const timer = setTimeout(() => abortController.abort(), timeoutMs)
  try {
    const [account, models] = await Promise.all([q.accountInfo(), q.supportedModels()])
    return { account, models }
  } finally {
    clearTimeout(timer)
    finish()
    abortController.abort()
    await drain
  }
}
