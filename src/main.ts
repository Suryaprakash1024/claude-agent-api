#!/usr/bin/env node
import { spawn } from "node:child_process"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

import { defineCommand, runMain } from "citty"
import consola from "consola"

import { probe } from "./lib/claude.ts"
import { APP_NAME, APP_VERSION } from "./lib/state.ts"
import { start } from "./start.ts"

function runClaude(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("claude", args, { stdio: "inherit", shell: process.platform === "win32" })
    child.on("exit", (code) => resolve(code ?? 1))
    child.on("error", (err) => {
      consola.error(`Could not run the claude CLI: ${err.message}. Install Claude Code or sign in with ANTHROPIC_API_KEY.`)
      resolve(1)
    })
  })
}

const auth = defineCommand({
  meta: { name: "auth", description: "Sign Claude Code in (runs `claude auth login`), or show status" },
  args: {
    status: { type: "boolean", default: false, description: "Show the current sign-in instead of signing in" },
  },
  async run({ args }) {
    process.exitCode = await runClaude(["auth", args.status ? "status" : "login"])
  },
})

const checkUsage = defineCommand({
  meta: { name: "check-usage", description: "Show usage counted by a running server" },
  args: {
    port: { type: "string", alias: "p", default: "4141", description: "Port of the running server" },
    host: { type: "string", default: "127.0.0.1", description: "Host of the running server" },
    "api-key": { type: "string", alias: "k", description: "The server's --api-key, if it has one" },
  },
  async run({ args }) {
    const key = args["api-key"] ?? process.env.CLAUDE_AGENT_API_KEY
    const res = await fetch(`http://${args.host}:${args.port}/usage`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
    }).catch((err: Error) => {
      consola.error(`No server at ${args.host}:${args.port} (${err.message}). Start one with \`${APP_NAME} start\`.`)
      process.exit(1)
    })
    console.log(JSON.stringify(await res.json(), null, 2))
  },
})

function sdkVersion(): string {
  try {
    const require = createRequire(import.meta.url)
    const entry = require.resolve("@anthropic-ai/claude-agent-sdk")
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(entry), "package.json"), "utf8"))
    return pkg.version
  } catch {
    return "unknown"
  }
}

const debug = defineCommand({
  meta: { name: "debug", description: "Show version, runtime and Claude Code sign-in" },
  args: { json: { type: "boolean", default: false, description: "Print JSON" } },
  async run({ args }) {
    const info: Record<string, unknown> = {
      version: APP_VERSION,
      agentSdkVersion: sdkVersion(),
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      env: {
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ? "set" : "not set",
        CLAUDE_AGENT_API_KEY: process.env.CLAUDE_AGENT_API_KEY ? "set" : "not set",
      },
    }
    try {
      const { account, models } = await probe()
      info.account = account
      info.models = models.map((m) => m.value)
    } catch (err) {
      info.account = { error: err instanceof Error ? err.message : String(err) }
    }
    if (args.json) console.log(JSON.stringify(info, null, 2))
    else consola.log(info)
  },
})

const main = defineCommand({
  meta: { name: APP_NAME, version: APP_VERSION, description: "Use Claude Code as an OpenAI/Anthropic-compatible API" },
  subCommands: { start, auth, "check-usage": checkUsage, debug },
})

await runMain(main)
