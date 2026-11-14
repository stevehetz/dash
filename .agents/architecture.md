# Architecture

Real paths (the canonical index is `AGENTS.md`; read this when working in the code).

- `bot.js` — entry point: Telegram bot, HTTP server (dashapp + voice endpoints), scheduled jobs. Runs under pm2 as **`dash-bot`**.
- `cli.js` — run Dash capabilities directly for dev/testing (`chat`, `gcal`, `gdrive`, `gtasks`).
- `tools.js` — the shell bridge the agent calls its tools through (see below).
- `src/setup.js` — loads `config/.env`, unsets `ANTHROPIC_API_KEY`, builds services (FileManager, Google managers, etc.).
- `src/agent.js` — the agent. `chat()` runs one `codex exec`, assembles the system prompt, and replays recent turns for continuity.
- `src/llm/` —
  - `backend.js` — keeps `ANTHROPIC_API_KEY` out of the env so the CLI uses the subscription.
  - `codex-p.js` — spawns `codex exec`; owns the runtime flags and the usage log.
  - `one-shot.js` — text-in/out helper with no tools (TTS, email triage).
  - `dash-mcp-server.js`, `json-schema-to-zod.js` — stdio MCP bridge. **Currently unused** (see below); kept for if/when `codex exec` supports MCP.
- `src/tools/loader.js` — discovers tool providers at `src/tools/<name>/skill.js`. Each exports `{ name, tools, systemPrompt, requires?, createHandler, start? }`. Tool providers include apple, google-*, gmail, plaid, oura, weather, onedrive, dynamic-jobs, web, browser, printer, and others — run `node tools.js list` for the current set.
- `web/` — dashapp (served by `bot.js`). `voice/` — Python voice listener (pm2 `dash-voice`).
- `config/.env` — secrets + flags. Gitignored; copied from `Dropbox/dropbox/secret/dash/` by `npm run secrets:pull` (`scripts/pull-secrets.sh`, run automatically on `pm2:boot`/`pm2:start`/`pm2:restart`). Edit the Dropbox copy — local edits are overwritten on the next pull. Never commit it; the repo is public. `config/.env.example` lists the keys.
- HTTP server (`bot.js`, port 3001, binds `0.0.0.0`) — loopback callers are trusted (local voice listener, Tailscale Serve);
  any other caller must send `X-Dash-Token: $DASH_HTTP_TOKEN` or gets a 401.

> `src/tools/<name>/skill.js` modules are **runtime tool providers**, not agent skills.

## How tools reach the model

`codex exec` does **not** expose MCP servers to the model — verified on CLI 0.145.0 and
0.147.0, with production flags and with explicit `-c mcp_servers.*` overrides. A trivial
one-tool MCP server is equally invisible, and `input_tokens` is identical with and without
servers configured. Between the switch to `codex-p` and 2026-08-15, this meant Dash had
none of its own tools and improvised everything with Codex's built-in `exec` shell.

Tools now reach the agent as a **command** instead, over the `exec` channel it does have:

```bash
node tools.js list                    # every tool, grouped by provider
node tools.js help <name>             # one tool's argument schema
node tools.js call <name> '<json>'    # run it; '-' reads JSON from stdin
```

`tools.js` loads providers through the same `loadTools()` and calls the same
`handleToolCall()` as the MCP bridge, so **the tool-provider contract is unchanged** —
adding a tool still means adding it to a `skill.js`. Only stdout carries the result;
provider startup logs go to stderr.

`src/agent.js` injects the roster (names + one-line summaries) into every system prompt
via `_toolIndex()`. Full argument schemas are ~34KB, so they stay behind
`node tools.js help <name>` rather than travelling with each request.

## LLM backend

Dash runs on Steve's **Codex subscription** — `codex exec` under `src/llm/codex-p.js`.
No API tokens are consumed. The `api` (Anthropic) and `claude-p` (Claude Agent SDK)
backends were removed on 2026-08-15; `DASH_LLM_BACKEND` no longer does anything.

Runtime flags worth knowing (`src/llm/codex-p.js`):

- `--ephemeral` — no session transcript is written to `~/.codex/sessions`. Nothing
  resumes these runs, and they otherwise accumulated ~27MB/month of Steve's personal
  conversations.
- `-c project_doc_max_bytes=0` — stops Codex loading this repo's `AGENTS.md` into
  every runtime chat. `--cd DASH_ROOT` is still needed for the project config.
- `--dangerously-bypass-approvals-and-sandbox` — the agent runs unsandboxed with
  `approval_policy: never`.

## Conversation memory

Each run is a fresh process, so continuity is replay: `bot.js` passes the tail of the
channel's transcript (`recentTurns()`) into `agent.chat(..., { history })`, and
`_formatHistory()` renders it under `## Recent conversation` within a character budget.

- Telegram and voice replay `dashbook/data/telegram.json`; dashapp chat replays `chat.json`.
- Scheduled jobs and the email poller pass no history — they must not pick up whatever
  Steve was chatting about.
- `/clear` writes a cutoff timestamp to `dashbook/data/chat-cutoffs.json`. Nothing is
  deleted; the agent just stops being shown anything older.

There is no long-term memory store. `DASH.md` is the single source of standing facts and
behavioral rules, and Steve edits it directly.
