import consola from "consola"

import { HttpError } from "./errors.ts"
import { state } from "./state.ts"

let lastRequestAt = 0

/** Enforce --rate-limit / --wait, like copilot-api. */
export async function checkRateLimit() {
  const limit = state.rateLimitSeconds
  if (!limit) return
  const now = Date.now()
  const waitMs = lastRequestAt + limit * 1000 - now
  if (waitMs > 0) {
    if (!state.rateLimitWait) {
      throw new HttpError(429, `Rate limited: wait ${Math.ceil(waitMs / 1000)}s between requests`, "rate_limit_error")
    }
    consola.info(`Rate limit: waiting ${Math.ceil(waitMs / 1000)}s`)
    await new Promise((r) => setTimeout(r, waitMs))
  }
  lastRequestAt = Date.now()
}

/** Ask in the server terminal before running a request (--manual). */
export async function manualApproval(summary: string) {
  if (!state.manualApprove) return
  const ok = await consola.prompt(`Approve request? ${summary}`, { type: "confirm" })
  if (ok !== true) throw new HttpError(403, "Request rejected by the server operator", "permission_error")
}

/** Limit how many Claude Code processes run at once. */
class Semaphore {
  private active = 0
  private readonly queue: Array<() => void> = []

  async acquire(): Promise<() => void> {
    if (this.active >= state.maxConcurrency) {
      await new Promise<void>((resolve) => this.queue.push(resolve))
    }
    this.active++
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      this.queue.shift()?.()
    }
  }
}

export const slots = new Semaphore()
