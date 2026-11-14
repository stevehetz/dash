/**
 * Stdio MCP bridge used by Dash's Codex CLI runs.
 *
 * This process intentionally owns stdout: MCP protocol messages go there, while
 * all startup/tool logs go to stderr so they cannot corrupt the transport.
 */
const originalConsoleLog = console.log;
console.log = (...args) => console.error(...args);

const [
  { McpServer },
  { StdioServerTransport },
  { createServices },
  { loadTools },
  { toZodShape },
] = await Promise.all([
  import("@modelcontextprotocol/sdk/server/mcp.js"),
  import("@modelcontextprotocol/sdk/server/stdio.js"),
  import("../setup.js"),
  import("../tools/loader.js"),
  import("./json-schema-to-zod.js"),
]);

const services = await createServices();
const { tools, handleToolCall } = await loadTools({
  fileManager: services.fileManager,
  ...services,
});

const server = new McpServer({ name: "dash", version: "1.0.0" });

function normalize(result) {
  if (typeof result === "string") return [{ type: "text", text: result }];
  if (Array.isArray(result)) {
    return result.map((block) => {
      if (block?.type === "text") return { type: "text", text: block.text };
      if (block?.type === "image" && block.source) {
        return { type: "image", data: block.source.data, mimeType: block.source.media_type };
      }
      return { type: "text", text: typeof block === "string" ? block : JSON.stringify(block) };
    });
  }
  return [{ type: "text", text: String(result) }];
}

for (const tool of tools) {
  server.registerTool(tool.name, {
    description: tool.description || "",
    inputSchema: toZodShape(tool.input_schema),
  }, async (args) => {
    console.error(`  🔧 Codex MCP tool: ${tool.name}(${JSON.stringify(args).slice(0, 200)})`);
    try {
      const result = await handleToolCall(tool.name, args);
      console.error(`  ✅ ${tool.name} succeeded`);
      return { content: normalize(result) };
    } catch (err) {
      console.error(`  ❌ ${tool.name} failed: ${err.message}`);
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  });
}

await server.connect(new StdioServerTransport());
console.error(`🧩 Codex MCP server "dash" ready (${tools.length} tools)`);

// Keep the original binding available to debuggers without ever writing to stdout.
void originalConsoleLog;
