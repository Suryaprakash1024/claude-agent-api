import assert from "node:assert/strict"
import { test } from "node:test"

import { HttpError } from "../src/lib/errors.ts"
import { buildUserMessage } from "../src/lib/prompt.ts"
import { fromOpenAI, toClientTools, toToolChoice } from "../src/routes/chat-completions.ts"
import { clientToolName, toolChoiceInstruction } from "../src/lib/tools.ts"

test("OpenAI messages: system/developer become the system prompt", () => {
  const { system, messages } = fromOpenAI([
    { role: "system", content: "Be brief." },
    { role: "developer", content: "Use English." },
    { role: "user", content: "Hi" },
  ])
  assert.equal(system, "Be brief.\n\nUse English.")
  assert.deepEqual(messages, [{ role: "user", content: [{ type: "text", text: "Hi" }] }])
})

test("OpenAI image data URLs become base64 image blocks", () => {
  const { messages } = fromOpenAI([
    { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
  ])
  assert.deepEqual(messages[0]!.content, [
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
  ])
})

test("earlier turns are sent as a transcript ahead of the last user message", () => {
  const msg = buildUserMessage([
    { role: "user", content: "My name is Ravi." },
    { role: "assistant", content: "Hello Ravi." },
    { role: "user", content: "What is my name?" },
  ])
  const blocks = msg.message.content as Array<{ type: string; text: string }>
  assert.equal(blocks.length, 2)
  assert.match(blocks[0]!.text, /<conversation_history>[\s\S]*<assistant>\nHello Ravi\.\n<\/assistant>/)
  assert.equal(blocks[1]!.text, "What is my name?")
})

test("a trailing assistant message is rejected", () => {
  assert.throws(
    () => buildUserMessage([{ role: "assistant", content: "x" }]),
    (err: unknown) => err instanceof HttpError && err.status === 400,
  )
})

test("OpenAI function tools become client tools; other tool types are skipped", () => {
  const tools = toClientTools([
    { type: "function", function: { name: "get_weather", description: "Weather", parameters: { type: "object", properties: { city: { type: "string" } } } } },
    { type: "function", function: { name: "ping" } },
    { type: "web_search" },
  ])
  assert.deepEqual(tools, [
    { name: "get_weather", description: "Weather", input_schema: { type: "object", properties: { city: { type: "string" } } } },
    { name: "ping", description: undefined, input_schema: { type: "object", properties: {} } },
  ])
})

test("OpenAI tool_choice maps to the Anthropic shape", () => {
  assert.equal(toToolChoice(undefined), undefined)
  assert.equal(toToolChoice("auto"), undefined)
  assert.deepEqual(toToolChoice("none"), { type: "none" })
  assert.deepEqual(toToolChoice("required"), { type: "any" })
  assert.deepEqual(toToolChoice({ type: "function", function: { name: "f" } }), { type: "tool", name: "f" })
  assert.match(toolChoiceInstruction({ type: "tool", name: "f" })!, /mcp__client__f/)
  assert.equal(toolChoiceInstruction({ type: "auto" }), undefined)
})

test("MCP tool names are given back to the client without the server prefix", () => {
  assert.equal(clientToolName("mcp__client__get_weather"), "get_weather")
  assert.equal(clientToolName("other"), "other")
})

test("tool calls and consecutive tool results are kept in order, results merged into one user turn", () => {
  const { messages } = fromOpenAI([
    { role: "user", content: "Weather in Paris and Rome?" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "c1", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
        { id: "c2", function: { name: "get_weather", arguments: '{"city":"Rome"}' } },
      ],
    },
    { role: "tool", tool_call_id: "c1", content: "18C" },
    { role: "tool", tool_call_id: "c2", content: "24C" },
  ])
  assert.equal(messages.length, 3)
  assert.match(messages[1]!.content as string, /get_weather \(call c1\) with \{"city":"Paris"\}/)
  assert.deepEqual(messages[2], {
    role: "user",
    content: [
      { type: "text", text: "[tool result from get_weather (call c1): 18C]" },
      { type: "text", text: "[tool result from get_weather (call c2): 24C]" },
    ],
  })
})
