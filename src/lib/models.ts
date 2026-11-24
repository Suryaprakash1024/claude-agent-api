import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk"
import consola from "consola"

import { state } from "./state.ts"

/** Aliases Claude Code resolves itself. */
const ALIASES = new Set(["default", "opus", "sonnet", "haiku", "fable"])

/** Shown by GET /v1/models when the live list from Claude Code is unavailable. */
export const STATIC_MODELS: ModelInfo[] = [
  { value: "claude-opus-5-5", displayName: "Claude Opus 5.5", description: "Default Opus" },
  { value: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5", description: "Everyday coding and agent work" },
  { value: "claude-haiku-5-5", displayName: "Claude Haiku 5.5", description: "Fast and cheap" },
  { value: "claude-fable-5-2", displayName: "Claude Fable 5.2", description: "Most capable" },
]

let liveModels: ModelInfo[] | undefined

export function setLiveModels(models: ModelInfo[]) {
  liveModels = models
}

export function listModels(): ModelInfo[] {
  return liveModels && liveModels.length > 0 ? liveModels : STATIC_MODELS
}

/**
 * Pick the model to hand to Claude Code. Claude model IDs and aliases pass through;
 * anything else (an OpenAI client sending "gpt-4o", say) falls back to the server default.
 */
export function resolveModel(requested: string | undefined): string | undefined {
  const model = requested?.trim()
  if (!model) return state.defaultModel
  if (model.startsWith("claude-") || ALIASES.has(model)) return model
  const known = listModels().some((m) => m.value === model)
  if (known) return model
  consola.warn(`Unknown model "${model}", using ${state.defaultModel ?? "Claude Code's default"}`)
  return state.defaultModel
}
