# Workflows

Tool-neutral, on-demand guides for repeated tasks in this repo. Each workflow is a single
markdown file (`<name>.md`) describing **when to use it** and the **steps**.

These are deliberately plain markdown — readable by any agent (Claude, Codex, Copilot).
There is no auto-trigger: the agent (or you) opens the relevant guide when a task matches,
routed from the index in the root `AGENTS.md`.

## Adding a workflow

1. Create `.agents/workflows/<name>.md` with a one-line "Use this when…" and the steps.
2. Add a bullet under **Detailed guides** in the root `AGENTS.md` pointing to it.

_None yet — add them as real repeated workflows emerge, not speculatively._
