# dash-dev MCP server

A small, **read-mostly** MCP server exposing the diagnostics an AI coding agent repeatedly
needs while working on this repo. Same server, usable by Claude Code, Codex, and Copilot —
MCP is the one dev-extension standard all three share.

It deliberately does **not** expose any of Dash's runtime capabilities (Plaid, email,
reminders, calendar). It only reads process/log/usage state.

## Tools

| Tool | Args | What it returns |
|---|---|---|
| `pm2_status` | — | dash-* process health: status, uptime, restarts, memory |
| `bot_logs` | `service?`, `lines?` (≤200), `grep?` | bounded recent log lines, optionally filtered |
| `recent_errors` | `lines?` (≤1000) | log lines matching ❌ / Error / failed |
| `claude_p_usage` | `date?` (YYYY-MM-DD) | subscription run count, ok/fail, total seconds, by source |
| `restart_bot` | `service?` | restarts a dash-* process (default dash-bot). **Write** — annotated `destructiveHint` so clients gate it |

All read tools are length-capped; `bot_logs` exists so agents don't dump whole logs.

## Register it (per tool — same server)

All three configs are committed in the repo and launch the server through one npm wrapper —
`npm run -s ai:mcp:dash-dev` (defined in `package.json`). One launch definition for every
tool; the `-s` flag keeps npm silent so its output can't corrupt the MCP stdio stream.

- **Claude Code** — `.mcp.json`. Start a new session and approve `dash-dev`.
- **Copilot (VS Code)** — `.vscode/mcp.json`. Start `dash-dev` from the MCP view.
- **Codex** — `.codex/config.toml` (project-level, committed). Restart Codex to pick it up.
  `restart_bot` is gated there with `approval_mode = "approve"`.

## Notes & next steps

- **Logs can contain personal content** (message text, tool inputs). Output is bounded;
  add redaction here if that matters for your use.
- `restart_bot` is the one write tool — `pm2 restart <service>`, annotated `destructiveHint`
  so MCP clients require confirmation before running it.
- Stack: `@modelcontextprotocol/sdk` + `zod` (both already project deps), stdio transport.
