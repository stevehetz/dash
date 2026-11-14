import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Integrations that are intentionally retired from Dash. Keep their source
// directories out of the loader so they are neither imported nor exposed.
const DISABLED_TOOL_PROVIDERS = new Set([
  "apple",
  "email",
  "gmail",
  "google-calendar",
  "google-drive",
  "google-tasks",
  "oura",
  "weather",
  "web",
]);

/**
 * Dynamically load all tools from the tools/ directory.
 *
 * Each tool module exports: { name, tools, systemPrompt, requires?, createHandler }
 *   - requires: optional dependency key (e.g. "fileManager").
 *     If set and the dependency isn't in `deps`, the tool is skipped.
 *   - createHandler(deps): returns an async (toolName, toolInput) => result function.
 *
 * Returns { tools, systemPrompt, handleToolCall, startBackgroundTasks }.
 */
export async function loadTools(deps = {}) {
  const loaded = [];

  for (const dir of readdirSync(__dirname, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    if (DISABLED_TOOL_PROVIDERS.has(dir.name)) continue;

    const mod = await import(join(__dirname, dir.name, "skill.js"));
    const toolModule = mod.default;

    // Skip if required dependency isn't available
    if (toolModule.requires && !deps[toolModule.requires]) {
      console.log(`  ⏭️  Tool "${toolModule.name}" skipped (missing ${toolModule.requires})`);
      continue;
    }

    loaded.push({
      ...toolModule,
      handler: toolModule.createHandler(deps),
    });

    const toolCount = toolModule.tools.length;
    console.log(`  ✅ Tool "${toolModule.name}" loaded${toolCount ? ` (${toolCount} tools)` : ""}`);
  }

  // Build the tool→handler routing map
  const handlers = new Map();
  for (const toolModule of loaded) {
    for (const tool of toolModule.tools) {
      handlers.set(tool.name, toolModule.handler);
    }
  }

  // Collect tool modules that have background tasks
  const backgroundModules = loaded.filter((s) => typeof s.start === "function");

  return {
    tools: loaded.flatMap((s) => s.tools),
    systemPrompt: loaded.map((s) => s.systemPrompt).filter(Boolean).join(""),
    async handleToolCall(toolName, toolInput) {
      const handler = handlers.get(toolName);
      if (!handler) return `Unknown tool: ${toolName}`;
      return handler(toolName, toolInput);
    },
    async startBackgroundTasks(context) {
      const stops = [];
      for (const mod of backgroundModules) {
        const stop = await mod.start({ ...context, ...deps });
        stops.push(stop);
        console.log(`   🔄 Tool "${mod.name}" background tasks started`);
      }
      return () => stops.forEach((stop) => stop());
    },
  };
}
