import type Anthropic from "@anthropic-ai/sdk"
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"

import { HttpError } from "./errors.ts"

type Block = Anthropic.ContentBlockParam

/** Flatten any content block to text for the conversation transcript. */
function blockToText(block: Block): string {
  switch (block.type) {
    case "text":
      return block.text
    case "image":
      return "[image]"
    case "document":
      return "[document]"
    case "tool_use":
      return `[called tool ${block.name} with ${JSON.stringify(block.input)}]`
    case "tool_result": {
      const content =
        typeof block.content === "string"
          ? block.content
          : (block.content ?? []).map((b) => blockToText(b as Block)).join("\n")
      return `[tool result${block.is_error ? " (error)" : ""}: ${content}]`
    }
    case "thinking":
    case "redacted_thinking":
      return ""
    default:
      return ""
  }
}

export function contentToText(content: Anthropic.MessageParam["content"]): string {
  if (typeof content === "string") return content
  return content.map(blockToText).filter(Boolean).join("\n")
}

/** Keep blocks Claude Code can take as user input; turn the rest into text. */
function toUserBlocks(content: Anthropic.MessageParam["content"]): Block[] {
  if (typeof content === "string") return [{ type: "text", text: content }]
  return content.map((b): Block => {
    if (b.type === "text" || b.type === "image" || b.type === "document") return b
    return { type: "text", text: blockToText(b) }
  })
}

/**
 * Claude Code sessions start from one user turn, so earlier turns of a stateless
 * chat request are given as a transcript ahead of the latest user message.
 */
export function buildUserMessage(messages: Anthropic.MessageParam[]): SDKUserMessage {
  if (messages.length === 0) throw new HttpError(400, "messages must not be empty", "invalid_request_error")
  const last = messages[messages.length - 1]!
  if (last.role !== "user") {
    throw new HttpError(400, "The last message must have role 'user' (assistant prefill is not supported)", "invalid_request_error")
  }

  const blocks: Block[] = []
  const history = messages.slice(0, -1)
  if (history.length > 0) {
    const transcript = history
      .map((m) => `<${m.role}>\n${contentToText(m.content)}\n</${m.role}>`)
      .join("\n")
    blocks.push({
      type: "text",
      text:
        `<conversation_history>\n${transcript}\n</conversation_history>\n\n` +
        "Continue this conversation. Reply as the assistant to the user's latest message, which follows.",
    })
  }
  blocks.push(...toUserBlocks(last.content))

  return {
    type: "user",
    message: { role: "user", content: blocks },
    parent_tool_use_id: null,
  }
}

/** One-shot async iterable: the query ends once this turn is answered. */
export async function* singleTurn(message: SDKUserMessage): AsyncGenerator<SDKUserMessage> {
  yield message
}
