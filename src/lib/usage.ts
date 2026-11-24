import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk"

interface ModelTotals {
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  costUSD: number
}

const startedAt = new Date()
let requests = 0
let errors = 0
const byModel = new Map<string, ModelTotals>()

function totalsFor(model: string): ModelTotals {
  let t = byModel.get(model)
  if (!t) {
    t = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 }
    byModel.set(model, t)
  }
  return t
}

export function recordRequest() {
  requests++
}

export function recordError() {
  errors++
}

/** Add one query()'s totals. `modelUsage` covers every model call the query made. */
export function recordResult(result: SDKResultMessage) {
  for (const [model, u] of Object.entries(result.modelUsage ?? {})) {
    const t = totalsFor(model)
    t.requests++
    t.inputTokens += u.inputTokens
    t.outputTokens += u.outputTokens
    t.cacheReadInputTokens += u.cacheReadInputTokens
    t.cacheCreationInputTokens += u.cacheCreationInputTokens
    t.costUSD += u.costUSD
  }
}

export function usageSnapshot() {
  const models = Object.fromEntries(byModel)
  const totals = [...byModel.values()].reduce(
    (acc, t) => {
      acc.inputTokens += t.inputTokens
      acc.outputTokens += t.outputTokens
      acc.cacheReadInputTokens += t.cacheReadInputTokens
      acc.cacheCreationInputTokens += t.cacheCreationInputTokens
      acc.estimatedCostUSD += t.costUSD
      return acc
    },
    { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, estimatedCostUSD: 0 },
  )
  return {
    since: startedAt.toISOString(),
    requests,
    errors,
    totals,
    byModel: models,
    note: "Counts cover this server process only. Costs are Claude Code's client-side estimates, not a bill.",
  }
}
