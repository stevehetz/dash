import { codexP } from "../../llm/codex-p.js";

const tools = [
  {
    name: "codex_code",
    description:
      "Delegate a heavy research subtask to a fresh local Codex session. Use this for substantive research, curation, and analysis. Returns a string. Each call is a fresh session with NO memory of prior context — pass everything it needs in `prompt`. Slower than a normal reply (~30s–3min). It has no Dash tools (no Plaid/calendar/reminders/file ops).",
    input_schema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "The full self-contained instruction for the subagent. Include all context it needs and the exact output format you want back. The subagent has WebFetch + WebSearch only.",
        },
      },
      required: ["prompt"],
    },
  },
];

const systemPrompt = `

## Codex subagent (codex_code)
Delegate heavy web research to a fresh Codex session. Calls take ~30s–3min.
- Good for: roundups, comparisons, multi-source digests — anything whose value comes from actually reading the web.
- Never for: work needing Dash tools (it has NONE), quick facts you already know, or anything depending on this conversation (every call is a fresh session).
- Pass a fully self-contained prompt and state the exact output format you want, then fold the returned text into your reply.
`;

function createHandler() {
  return async (toolName, toolInput) => {
    if (toolName !== "codex_code") return `Unknown tool: ${toolName}`;
    try {
      return await codexP(toolInput.prompt, { source: "subagent" });
    } catch (err) {
      return `codex_code failed: ${err.message}`;
    }
  };
}

export default { name: "subagent", tools, systemPrompt, createHandler };
