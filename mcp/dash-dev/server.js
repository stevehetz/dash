#!/usr/bin/env node
/**
 * dash-dev — a small read-only MCP server for the Dash developer workflow.
 *
 * Exposes the diagnostics an AI coding agent (Claude / Codex / Copilot) repeatedly
 * needs while working on this repo: pm2 process health, bounded log tails, an error
 * scan, and a claude-p subscription-usage summary. Read-only by design — it does NOT
 * expose any of Dash's runtime capabilities (Plaid, email, reminders, etc.).
 *
 * Run: node mcp/dash-dev/server.js  (stdio transport; registered per tool — see README).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { promisify } from "node:util";
import { execFile as _execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const execFile = promisify(_execFile);

const ONEDRIVE =
  process.env.ONEDRIVE_PATH ||
  "/Users/stevemini/Library/CloudStorage/OneDrive-Personal/steve";
const USAGE_DIR = join(ONEDRIVE, "dashbook", "data", "reports", "claude-p");
const PROCESSES = ["dash-bot", "dash-voice", "dash-tailscale"];
const MAX_TEXT = 16000;
const PM2_BUF = { maxBuffer: 8 * 1024 * 1024 };

const text = (s) => ({ content: [{ type: "text", text: String(s).slice(0, MAX_TEXT) }] });

async function pm2Logs(service, lines) {
  const { stdout } = await execFile(
    "pm2",
    ["logs", service, "--nostream", "--lines", String(lines)],
    PM2_BUF,
  );
  return stdout.split("\n");
}

const server = new McpServer({ name: "dash-dev", version: "0.1.0" });

server.registerTool(
  "pm2_status",
  {
    description: "Health of Dash's pm2 processes (online state, uptime, restart count, memory).",
    annotations: { readOnlyHint: true },
  },
  async () => {
    try {
      const { stdout } = await execFile("pm2", ["jlist"], PM2_BUF);
      const rows = JSON.parse(stdout)
        .filter((p) => p.name?.startsWith("dash-"))
        .map((p) => {
          const e = p.pm2_env || {};
          const up = e.pm_uptime ? Math.round((Date.now() - e.pm_uptime) / 1000) : 0;
          const mem = p.monit?.memory ? `${Math.round(p.monit.memory / 1e6)}mb` : "?";
          return `${p.name.padEnd(16)} ${(e.status || "?").padEnd(10)} up ${up}s · restarts ${e.restart_time ?? "?"} · ${mem}`;
        });
      return text(rows.length ? rows.join("\n") : "no dash-* processes found");
    } catch (err) {
      return text(`pm2 not reachable: ${err.message}`);
    }
  },
);

server.registerTool(
  "bot_logs",
  {
    description:
      "Recent log lines for a Dash pm2 process, bounded. Optional case-insensitive substring filter. Use this instead of dumping whole logs.",
    inputSchema: {
      service: z.enum(PROCESSES).default("dash-bot").describe("Which pm2 process (default dash-bot)."),
      lines: z.number().int().min(1).max(200).default(50).describe("How many recent lines (max 200)."),
      grep: z.string().optional().describe("Case-insensitive substring filter."),
    },
  },
  async ({ service, lines, grep }) => {
    try {
      let out = await pm2Logs(service, Math.max(lines, grep ? 200 : lines));
      if (grep) out = out.filter((l) => l.toLowerCase().includes(grep.toLowerCase()));
      out = out.slice(-lines);
      return text(out.join("\n") || "(no matching lines)");
    } catch (err) {
      return text(`could not read logs for ${service}: ${err.message}`);
    }
  },
);

server.registerTool(
  "recent_errors",
  {
    description: "Scan recent dash-bot logs for errors (❌ / Error / failed / unhandled). Returns matching lines, bounded.",
    inputSchema: {
      lines: z.number().int().min(50).max(1000).default(300).describe("How many recent lines to scan."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ lines }) => {
    try {
      const errs = (await pm2Logs("dash-bot", lines)).filter((l) =>
        /❌|\berror\b|\bfailed\b|unhandled/i.test(l),
      );
      return text(errs.length ? errs.slice(-60).join("\n") : `no errors in the last ${lines} lines`);
    } catch (err) {
      return text(`could not scan logs: ${err.message}`);
    }
  },
);

server.registerTool(
  "claude_p_usage",
  {
    description: "Summarize claude-p (Max subscription) usage for a date (default today): run count, ok/fail, total seconds, and counts by source.",
    inputSchema: {
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD (default today)."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ date }) => {
    const day = date || new Date().toISOString().slice(0, 10);
    try {
      const raw = await readFile(join(USAGE_DIR, `${day}.jsonl`), "utf-8");
      const events = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const ok = events.filter((e) => e.ok).length;
      const ms = events.reduce((a, e) => a + (e.ms || 0), 0);
      const bySource = {};
      for (const e of events) bySource[e.source || "?"] = (bySource[e.source || "?"] || 0) + 1;
      const srcLines = Object.entries(bySource)
        .sort((a, b) => b[1] - a[1])
        .map(([s, n]) => `  ${s}: ${n}`);
      return text(
        `${day}: ${events.length} runs (${ok} ok, ${events.length - ok} fail), ${Math.round(ms / 1000)}s total\nby source:\n${srcLines.join("\n")}`,
      );
    } catch (err) {
      return text(`no usage log for ${day} (${err.code || err.message})`);
    }
  },
);

server.registerTool(
  "restart_bot",
  {
    description:
      "Restart a Dash pm2 process (default dash-bot) to apply code changes. Real action — briefly takes the process offline. Use only when deploying a change.",
    inputSchema: {
      service: z.enum(PROCESSES).default("dash-bot").describe("Which pm2 process to restart (default dash-bot)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  async ({ service }) => {
    try {
      await execFile("pm2", ["restart", service], PM2_BUF);
      const { stdout } = await execFile("pm2", ["jlist"], PM2_BUF);
      const p = JSON.parse(stdout).find((x) => x.name === service);
      const e = p?.pm2_env || {};
      const up = e.pm_uptime ? Math.round((Date.now() - e.pm_uptime) / 1000) : 0;
      return text(`restarted ${service} → ${e.status || "?"} (uptime ${up}s, restarts ${e.restart_time ?? "?"})`);
    } catch (err) {
      return text(`failed to restart ${service}: ${err.message}`);
    }
  },
);

await server.connect(new StdioServerTransport());
