#!/usr/bin/env node
import { createServices } from "./src/setup.js";
import { Agent } from "./src/agent.js";

function usage() {
  console.log(`Usage: node cli.js chat <prompt>

Sends a prompt to Dash using its available tools.`);
  process.exit(1);
}

const [service, ...promptParts] = process.argv.slice(2);
if (service !== "chat" || promptParts.length === 0) usage();

const services = await createServices();
const agent = new Agent(services.fileManager, services, process.env.CLAUDE_MODEL || "claude-sonnet-4-6");
await agent.init();

try {
  const response = await agent.chat(process.env.ALLOWED_USER_ID || "cli", promptParts.join(" "));
  console.log(response);
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
