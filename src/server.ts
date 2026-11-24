import { timingSafeEqual } from "node:crypto"

import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"

import { listModels } from "./lib/models.ts"
import { APP_NAME, APP_VERSION, state } from "./lib/state.ts"
import { usageSnapshot } from "./lib/usage.ts"
import { agentRoutes } from "./routes/agent.ts"
import { chatCompletionsRoutes } from "./routes/chat-completions.ts"
import { messagesRoutes } from "./routes/messages.ts"

let accountInfo: Record<string, unknown> | undefined
export function setAccountInfo(info: Record<string, unknown>) {
  accountInfo = info
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

export function createServer() {
  const app = new Hono()

  app.use(logger())
  app.use(cors())

  // Optional shared key, checked on everything except the health check.
  app.use("/*", async (c, next) => {
    if (!state.apiKey || c.req.path === "/") return next()
    const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "")
    const key = c.req.header("x-api-key") ?? bearer
    if (!key || !safeEqual(key, state.apiKey)) {
      return c.json({ error: { message: "Invalid API key", type: "authentication_error" } }, 401)
    }
    return next()
  })

  app.get("/", (c) => c.text(`${APP_NAME} ${APP_VERSION} is running`))

  // OpenAI-compatible
  app.route("/chat/completions", chatCompletionsRoutes)
  app.route("/v1/chat/completions", chatCompletionsRoutes)

  const models = (c: { json: (o: unknown) => Response }) =>
    c.json({
      object: "list",
      data: listModels().map((m) => ({
        id: m.value,
        object: "model",
        created: 0,
        owned_by: "anthropic",
        display_name: m.displayName,
        description: m.description,
        resolved_model: m.resolvedModel,
      })),
      has_more: false,
    })
  app.get("/models", models)
  app.get("/v1/models", models)

  const embeddings = (c: { json: (o: unknown, s: 501) => Response }) =>
    c.json({ error: { message: "Embeddings are not available from Claude Code.", type: "not_implemented" } }, 501)
  app.post("/embeddings", embeddings)
  app.post("/v1/embeddings", embeddings)

  // Anthropic-compatible
  app.route("/v1/messages", messagesRoutes)

  // Claude Code agent (opt-in with --agent)
  app.route("/v1/agent", agentRoutes)

  // Monitoring
  app.get("/usage", (c) => c.json({ ...usageSnapshot(), account: accountInfo ?? null }))

  return app
}
