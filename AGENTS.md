# AGENTS.md — Dash

Canonical entry point for coding agents (Claude Code, Codex, Copilot). This file stays small
and always-loaded; detailed guides live in `.agents/` and are linked below — read the
relevant one when a task calls for it.

## What Dash is

A personal Telegram bot powered by Codex that manages Steve's files, calendar,
email, finances, health, and more. It also serves a web dashboard ("dashapp") and
a voice interface. Runs on Steve's Mac via pm2 (`dash-bot`). Local: `~/dev/dash` ·
GitHub: `git@github.com:stevehetz/dash.git`.

## Always applies

- **No test or lint suite.** Validate JS with `node --check <file>`; never claim tests ran or passed.
- **`cli.js` and the integration tools do real things** — send email, create calendar
  events, read bank data, print, consume the subscription. Don't run side-effecting commands
  just to "test." (detail: `.agents/conventions.md`)
- **Don't commit unless asked.** **Never commit secrets — this repo is public.** `config/.env`,
  `config/google-*.json`, `config/health-auto-export.json`, `scripts/plaid-*.pem` etc. are gitignored
  real files copied from `Dropbox/dropbox/secret/dash/` (same relative paths) by `npm run secrets:pull`,
  which runs automatically on `pm2:boot` / `pm2:start` / `pm2:restart`. **Edit secrets in the Dropbox
  copy** — local edits are overwritten on the next pull. New secrets go in Dropbox `config/.env`; add
  the key (blank) to `config/.env.example`.
- **Don't recursively scan** big dirs: OneDrive `storage/`, `voice/venv/`, `voice/training_data/`,
  `logs/`, `node_modules/`, generated reports. Search the smallest relevant path first.
- When Steve mentions an image or anything visual, **proactively check the screencaps folder
  first** — then **delete every `*.png` in it in that same turn**, before moving on to the task
  the screenshot was about. Never leave images behind (command + detail: `.agents/brain.md`).

## Commands

```bash
npm run dev              # bot + voice with --watch  (or: node bot.js)
pm2 restart dash-bot     # apply code changes to the running bot
pm2 logs dash-bot        # logs   ·   pm2 status   # health
node cli.js chat "…"     # exercise the full agent; also gcal / gdrive / gtasks subcommands
node tools.js list       # the tools the agent has; call/help run one (see architecture.md)
node --check <file.js>   # syntax-check a change (there is no test suite)
```

To exercise an existing capability (weather, calendar, file ops, Google, finances),
prefer `cli.js` over editing `bot.js` just to invoke it.

## Detailed guides (read on demand)

- `.agents/architecture.md` — real paths, how tools reach the model via `tools.js`, codex runtime flags, conversation replay.
- `.agents/conventions.md` — code style, the tool-provider contract, verifying changes, side effects.
- `.agents/brain.md` — OneDrive layout, when to read `DASH.md`, the no-scan list, screenshots.
- `.agents/skills/` — invokable skills in Codex `SKILL.md` format (Codex reads this natively; Claude/Copilot via thin invokers). E.g. `/caveman`.
- `.agents/workflows/` — task-specific workflow guides (add new ones here).
- `docs/` — operational/setup reference: `docs/operations.md` (Mac boot), `docs/voice-system.md`,
  `docs/iphone-voice.md`, `docs/mbp-voice-agent.md`.
