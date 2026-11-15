#!/usr/bin/env node
/**
 * Shell bridge to Dash's tool providers.
 *
 * Why this exists: `codex exec` does not expose MCP servers to the model (verified
 * on CLI 0.145.0 and 0.147.0 — a one-tool MCP server is equally invisible, and
 * input_tokens is unchanged with or without servers configured). The agent does
 * reliably have Codex's built-in `exec`, so tools reach it as a command instead.
 *
 * Nothing about the providers changes: this loads them through the same
 * `loadTools()` and calls the same `handleToolCall()` the MCP bridge uses.
 *
 *   node tools.js list                 every tool, grouped by provider
 *   node tools.js help <name>          full input schema for one tool
 *   node tools.js call <name> '<json>' run it; '-' reads the JSON from stdin
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolved from this file, not the cwd: the agent may invoke tools.js from anywhere.
const LOG_DIR = join(dirname(fileURLToPath(import.meta.url)), "logs");

// Stdout carries the tool result and nothing else — the agent parses it. Provider
// startup chatter is rerouted to stderr, and the redirect has to be installed before
// setup.js is evaluated, hence the dynamic imports below rather than static ones.
const log = console.log;
console.log = (...args) => console.error(...args);

const { createServices } = await import("./src/setup.js");
const { loadTools } = await import("./src/tools/loader.js");

const [command, name, ...rest] = process.argv.slice(2);

function usage() {
  log(`Usage: node tools.js <command>

  list                      List every available tool, grouped by provider
  help <name>               Show the input schema for one tool
  call <name> '<json>'      Run a tool. Use '-' as the JSON to read it from stdin.

Examples:
  node tools.js list
  node tools.js help get_weather
  node tools.js call get_weather '{"location":"Macedonia, OH"}'`);
}

if (!command || command === "help" && !name) {
  usage();
  process.exit(command ? 0 : 1);
}

const services = await createServices();
const { tools, handleToolCall } = await loadTools({
  fileManager: services.fileManager,
  ...services,
});

/** First sentence of a description, for the compact listing. */
function summarize(text) {
  const first = String(text || "").trim().split(/(?<=\.)\s/)[0] || "";
  return first.length > 140 ? first.slice(0, 137) + "..." : first;
}

/** handleToolCall returns a string or an array of content blocks. */
function render(result) {
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    return result
      .map((b) => {
        if (b && b.type === "text") return b.text;
        if (b && b.type === "image") return "[image omitted — not viewable over stdout]";
        return typeof b === "string" ? b : JSON.stringify(b);
      })
      .join("\n");
  }
  return typeof result === "undefined" ? "" : String(result);
}

/**
 * Append one line per tool call. This is the only record that the agent used a tool
 * at all — the run happens inside a `codex exec` subprocess whose stderr is discarded,
 * so without this there is no way to tell a real tool call from an invented answer.
 */
function logCall(event) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, "tool-calls.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n");
  } catch { /* logging must never break a tool call */ }
}

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

switch (command) {
  case "list": {
    // Group by provider for readability. The loader flattens the tools, so read
    // the ownership back off the skill modules rather than tagging tool objects
    // that other callers hand straight to an API.
    const { readdirSync } = await import("node:fs");
    const owner = new Map();
    for (const dir of readdirSync("src/tools", { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const mod = await import(`./src/tools/${dir.name}/skill.js`);
      for (const t of mod.default.tools || []) owner.set(t.name, mod.default.name);
    }
    const byProvider = new Map();
    for (const t of tools) {
      const provider = owner.get(t.name) || "other";
      if (!byProvider.has(provider)) byProvider.set(provider, []);
      byProvider.get(provider).push(t);
    }
    for (const provider of [...byProvider.keys()].sort()) {
      log(`\n## ${provider}`);
      for (const t of byProvider.get(provider)) log(`${t.name} — ${summarize(t.description)}`);
    }
    log(`\n${tools.length} tools. Run "node tools.js help <name>" for a tool's arguments.`);
    break;
  }

  case "help": {
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      console.error(`Unknown tool: ${name}. Run "node tools.js list" to see them all.`);
      process.exit(1);
    }
    log(`${tool.name}\n\n${tool.description || "(no description)"}\n`);
    log(`Arguments (JSON):\n${JSON.stringify(tool.input_schema, null, 2)}`);
    break;
  }

  case "call": {
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      console.error(`Unknown tool: ${name}. Run "node tools.js list" to see them all.`);
      process.exit(1);
    }
    const raw = rest[0] === "-" ? await readStdin() : rest[0] || "{}";
    let input;
    try {
      input = JSON.parse(raw);
    } catch (err) {
      console.error(`Arguments must be valid JSON: ${err.message}`);
      process.exit(1);
    }
    const t0 = Date.now();
    try {
      const result = render(await handleToolCall(tool.name, input));
      logCall({ tool: tool.name, ms: Date.now() - t0, ok: true, chars: result.length });
      log(result);
    } catch (err) {
      logCall({ tool: tool.name, ms: Date.now() - t0, ok: false, error: err.message?.slice(0, 200) });
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    break;
  }

  default:
    usage();
    process.exit(1);
}

process.exit(0);
