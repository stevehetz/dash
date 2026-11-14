# Skills

Invokable skills in **Codex `SKILL.md` format** — one folder per skill, `<name>/SKILL.md`,
with `name` + `description` frontmatter. This is the canonical, tool-neutral home.

**Codex reads `.agents/skills/` natively** at the project level — after Codex loads the repo,
type `/<name>` and it appears in the slash menu (restart Codex to pick up new/changed skills).

Other tools don't read `.agents/skills/`, so they get a thin invoker that points back at the
same `SKILL.md`:

| Tool        | Invoker                              | Invoked as |
|-------------|--------------------------------------|------------|
| Codex       | _(native — reads `.agents/skills/`)_ | `/<name>`  |
| Claude Code | `.claude/commands/<name>.md`         | `/<name>`  |
| Copilot     | `.github/prompts/<name>.prompt.md`   | `/<name>`  |

## Adding a skill

1. `.agents/skills/<name>/SKILL.md` — frontmatter (`name`, `description`) + the behavior.
2. Add a thin invoker for the non-Codex tools you use, pointing at that SKILL.md
   (see `.claude/commands/caveman.md`).
3. List it under **Detailed guides** in the root `AGENTS.md`.

## Skills

- `caveman/` — `/caveman` terse output mode (saves context/tokens).
