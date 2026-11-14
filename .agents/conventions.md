# Conventions & verifying changes

## Code style

- ESM (`"type": "module"`); match the surrounding style and 2-space indentation.
- New bot capabilities are tool providers under `src/tools/<name>/skill.js` following the
  loader contract (see `architecture.md`) — copy a neighboring provider rather than inventing
  a new shape.
- Don't commit unless asked. Never commit secrets: they live in gitignored symlinks into
  `Dropbox/dropbox/secret/dash/` (see `AGENTS.md`). The repo is public.

## Verifying changes

- Syntax: `node --check <changed-file.js>`.
- Behavior: prefer the narrowest `node cli.js …` over restarting the live bot.
- Restart the live bot (`pm2 restart dash-bot`) only when the task calls for deploying.
- There is **no test or lint suite** — never claim one ran or passed.

## Real-world side effects — be careful

`cli.js` and the integration tools perform **real actions**: sending email, creating
Google reminders and calendar events, reading bank/transaction (Plaid) data, printing,
and consuming the subscription. Don't run side-effecting commands just to "test" — pick the
narrowest read-only path when exploring.
