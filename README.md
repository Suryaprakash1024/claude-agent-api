# claude-agent-api

*Powered by Claude. An independent project, not affiliated with or endorsed by Anthropic.*

Use your local **Claude Code** as an **OpenAI- and Anthropic-compatible HTTP API**, the same way
[copilot-api](https://github.com/ericc-ch/copilot-api) does for GitHub Copilot. Any tool that speaks
the OpenAI Chat Completions API or the Anthropic Messages API (SDKs, LangChain, Open WebUI,
scripts, `curl`) can point at `http://localhost:4141` and get answers from Claude through Claude Code.

It is built on the official [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)
(`@anthropic-ai/claude-agent-sdk`), which runs Claude Code as a library. It does not reverse-engineer
or extract tokens.

> **Terms of use.** Claude Code here signs in the way your local `claude` does: with a Claude
> subscription login or with `ANTHROPIC_API_KEY`. Anthropic's docs say: *"Unless previously approved,
> Anthropic does not allow third party developers to offer claude.ai login or rate limits for their
> products, including agents built on the Claude Agent SDK."* Run this for **your own use** on your own
> machine. For anything shared with a team or a product, set `ANTHROPIC_API_KEY` (or use Bedrock /
> Vertex / Foundry) so usage is billed to an API key.

---

## Ways to use Claude Code from an API

| # | Approach | How it works | Pros | Cons | Verdict |
|---|----------|--------------|------|------|---------|
| 1 | **Agent SDK proxy** (this project) | HTTP server translates OpenAI/Anthropic requests into `query()` calls of `@anthropic-ai/claude-agent-sdk` | Official, typed, streaming events, sessions, cost/usage per call, can switch on the Claude Code tools (agent mode) | Starts one Claude Code process per request (~1–3 s overhead); adds ~900 tokens of context | **Chosen** |
| 2 | **CLI subprocess** | Spawn `claude -p --output-format stream-json` per request and parse stdout | No library dependency; works from any language | Hand-parsing of the stream; fewer controls; same per-request start cost | Fallback for non-JS stacks |
| 3 | **Direct Claude API** | Call `api.anthropic.com` with the Anthropic SDK and an API key | Fastest, no extra context, real tool use and token counting | It is not Claude Code: no Claude Code login, tools, CLAUDE.md or sessions | Use when you have an API key and don't need Claude Code |
| 4 | **Reuse Claude Code's OAuth token** | Read the token Claude Code stores and call the API with it, as copilot-api does with Copilot | Lowest overhead | Against Anthropic's terms; breaks without notice | **Not used** |

copilot-api has to take approach 4 for Copilot, because Copilot has no SDK. Claude Code ships an
official SDK, so this project takes approach 1 and keeps copilot-api's commands, flags and endpoint layout.

---

## Quick start

Requirements: Node.js 22.18+ (it runs TypeScript directly), and Claude Code signed in
(`claude auth login`) **or** `ANTHROPIC_API_KEY` set.

```powershell
git clone <this-repo-url> claude-agent-api
cd claude-agent-api
npm install
npm run build
node dist/main.js start
```

On Windows you can instead double-click **`start.bat`**. It installs dependencies on first run,
builds, and starts the server; any flags you pass go to `start` (for example
`start.bat --port 4242 --model sonnet --agent`).

During development, `npm run dev` runs from source with `--watch --verbose`.

At startup the server launches Claude Code once (without a prompt, so nothing is billed) to read the
signed-in account and the model list. Then it prints the endpoints:

```
OpenAI:     http://127.0.0.1:4141/v1/chat/completions   http://127.0.0.1:4141/v1/models
Anthropic:  http://127.0.0.1:4141/v1/messages           http://127.0.0.1:4141/v1/messages/count_tokens
Agent:      http://127.0.0.1:4141/v1/agent/query        (off: --agent)
Usage:      http://127.0.0.1:4141/usage
```

## Commands (compared with copilot-api)

| copilot-api | claude-agent-api | Notes |
|---|---|---|
| `start` | `start` | Starts the server |
| `auth` | `auth` / `auth --status` | Runs `claude auth login` / `claude auth status` |
| `check-usage` | `check-usage` | Shows the `/usage` counters of a running server |
| `debug [--json]` | `debug [--json]` | Shows versions, runtime, signed-in account and models |

### `start` flags

| Flag | Alias | Default | Description |
|---|---|---|---|
| `--port` | `-p` | 4141 | Port to listen on |
| `--host` | | 127.0.0.1 | Interface to bind. Use `0.0.0.0` only together with `--api-key` |
| `--verbose` | `-v` | false | Verbose logs, including Claude Code's stderr |
| `--model` | `-m` | Claude Code default | Default model, for requests that name none or a non-Claude model such as `gpt-4o` |
| `--api-key` | `-k` | none | Clients must send this key as `Authorization: Bearer …` or `x-api-key`. Also read from `CLAUDE_AGENT_API_KEY` |
| `--manual` | | false | Approve each request in the server terminal |
| `--rate-limit` | `-r` | none | Minimum seconds between requests |
| `--wait` | `-w` | false | Wait out the rate limit instead of returning 429 |
| `--concurrency` | `-c` | 4 | Maximum Claude Code processes at once (the rest queue) |
| `--agent` | | false | Turn on `POST /v1/agent/query` (Claude Code with its tools) |
| `--workspace` | | current folder | The only folder agent requests may work in |
| `--claude-path` | | bundled binary | Use a specific `claude` executable |
| `--skip-probe` | | false | Skip reading the account and models at startup |

## Endpoints

| Endpoint | Compatible with | Notes |
|---|---|---|
| `POST /v1/chat/completions` (also `/chat/completions`) | OpenAI | Streaming, `stream_options.include_usage`, images (`image_url` data or https URLs), `reasoning_effort` → effort, reasoning returned as `reasoning_content` |
| `GET /v1/models` (also `/models`) | OpenAI | Live list from Claude Code (aliases such as `sonnet` plus full IDs) |
| `POST /v1/embeddings` | OpenAI | Returns **501**: Claude has no embeddings |
| `POST /v1/messages` | Anthropic | Streaming passes Claude's own SSE events through unchanged. `system`, `thinking`, `output_config.effort` |
| `POST /v1/messages/count_tokens` | Anthropic | Exact when `ANTHROPIC_API_KEY` is set; otherwise an estimate (~4 chars/token) with header `x-token-count-estimated: true` |
| `POST /v1/agent/query` | (own) | Claude Code **with tools** in a folder; see below. Needs `--agent` |
| `GET /usage` | (like copilot-api) | Requests, errors, tokens and estimated cost per model since start, plus the signed-in account |

## Examples

**curl (OpenAI style)**

```powershell
curl.exe http://localhost:4141/v1/chat/completions -H "content-type: application/json" -d '{\"model\":\"sonnet\",\"messages\":[{\"role\":\"user\",\"content\":\"Hello\"}]}'
```

**OpenAI Python SDK**

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:4141/v1", api_key="dummy")
resp = client.chat.completions.create(
    model="claude-sonnet-5-5",
    messages=[{"role": "user", "content": "Write a haiku about proxies"}],
)
print(resp.choices[0].message.content)
```

**Anthropic Python SDK**

```python
import anthropic

client = anthropic.Anthropic(base_url="http://localhost:4141", api_key="dummy")
msg = client.messages.create(
    model="claude-opus-5-5",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Explain SSE in two sentences"}],
)
print(msg.content[0].text)
```

**Agent mode** (start with `--agent --workspace D:\path\to\repo`)

```powershell
curl.exe http://localhost:4141/v1/agent/query -H "content-type: application/json" -d '{\"prompt\":\"Summarize what src/ does\",\"cwd\":\".\",\"max_turns\":10}'
```

Agent request fields:
- `prompt` (required)
- `cwd`: relative to `--workspace`. Paths outside it are rejected with 403.
- `allowed_tools`: default `["Read","Glob","Grep"]`, which is read-only.
- `permission_mode`: `dontAsk` (default), `acceptEdits` or `plan`.
- `max_turns`: default 20, at most 100.
- `session_id`: resumes an earlier run.
- `append_system_prompt`, `effort`, `model`
- `stream`: SSE of the Agent SDK messages.

The response has `session_id`, `result`, `num_turns`, `total_cost_usd` and `usage`. Tools that are
not in `allowed_tools` are **denied**, since nobody is there to approve them. Add `Edit` / `Write` /
`Bash` only for folders you trust Claude to change.

## How it works

```
client ──HTTP──▶ Hono server ──translate──▶ query() (Agent SDK) ──▶ Claude Code process ──▶ Claude
       ◀─SSE/JSON── (OpenAI or Anthropic shape) ◀── stream_event / result messages ◀──
```

- **Chat mode** (`/v1/chat/completions`, `/v1/messages`) runs Claude Code as a plain model:
  - no tools (`tools: []`)
  - no settings files or CLAUDE.md (`settingSources: []`)
  - no saved session (`persistSession: false`)
  - one turn
  - your `system` text replaces Claude Code's system prompt
  - an empty temp folder as working directory, so nothing about the server's own folder reaches the model
- **History**: a Claude Code session starts from one user turn. Earlier messages of a stateless chat
  request are sent as a `<conversation_history>` transcript ahead of the latest user message.
- **Streaming**: `includePartialMessages` gives the raw Messages API stream events. `/v1/messages`
  passes them through unchanged; `/v1/chat/completions` turns them into OpenAI chunks.
- **Usage**: every `result` message's `modelUsage` is added to the `/usage` counters.

Project layout:

```
src/
  main.ts                 CLI: start | auth | check-usage | debug
  start.ts                start command, flags, startup probe, banner
  server.ts               Hono app, API-key middleware, models/embeddings/usage routes
  routes/messages.ts      Anthropic /v1/messages and count_tokens
  routes/chat-completions.ts  OpenAI /v1/chat/completions and translation
  routes/agent.ts         /v1/agent/query (Claude Code with tools)
  lib/claude.ts           Agent SDK calls: runChat, runAgent, probe, MessageAccumulator
  lib/prompt.ts           messages → Claude Code user turn
  lib/guard.ts            rate limit, manual approval, concurrency
  lib/models.ts, usage.ts, errors.ts, state.ts
tests/translate.test.ts   unit tests for request translation (npm test)
```

## Limitations

- **Client-defined tools / function calling are not supported** in chat mode. `tools` in a request is
  ignored with a warning. Use agent mode for Claude Code's own tools.
- **Assistant prefill is not supported.** The last message must be from the user.
- **Latency**: each request starts a Claude Code process, which adds about 1–3 s before the first token.
- **Token overhead**: Claude Code adds about 900 tokens of context to every chat request. These are
  cached after the first call.
- `temperature`, `top_p`, `stop` and similar sampling parameters are ignored.
- `max_tokens` / `max_completion_tokens` are ignored; replies use Claude Code's default output limit.
- Costs in `/usage` are Claude Code's client-side estimates, not a bill.
- Not affiliated with or supported by Anthropic.
