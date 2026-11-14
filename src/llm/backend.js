/**
 * Dash runs the agent and every one-shot helper through the local `codex exec`
 * CLI, under Steve's Codex subscription. No API tokens are consumed.
 *
 * This module used to select between three backends (`api`, `claude-p`,
 * `codex-p`). The other two are gone; all that remains is making sure the CLI
 * authenticates via the subscription.
 */

/**
 * Remove ANTHROPIC_API_KEY from the environment. Must be called AFTER
 * dotenv.config() and BEFORE anything spawns `codex`: the CLI silently prefers an
 * API key over the subscription if one is present, which would start billing.
 */
export function applyBackendEnv() {
  if (process.env.ANTHROPIC_API_KEY) {
    delete process.env.ANTHROPIC_API_KEY;
    console.log("🔑 LLM backend: codex-p (subscription) — ANTHROPIC_API_KEY unset");
  } else {
    console.log("🔑 LLM backend: codex-p (subscription)");
  }
}
