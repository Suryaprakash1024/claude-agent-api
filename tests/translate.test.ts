import assert from "node:assert/strict"
import { test } from "node:test"

import { HttpError } from "../src/lib/errors.ts"
import { buildUserMessage } from "../src/lib/prompt.ts"
import { fromOpenAI } from "../src/routes/chat-completions.ts"

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
