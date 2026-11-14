import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { appendFile, mkdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const DASH_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const USAGE_DIR = process.env.ONEDRIVE_PATH
  ? join(process.env.ONEDRIVE_PATH, "dashbook", "data", "reports", "codex-p")
  : null;

async function logUsage(event) {
  if (!USAGE_DIR) return;
  try {
    await mkdir(USAGE_DIR, { recursive: true });
    const date = event.ts.slice(0, 10);
    await appendFile(join(USAGE_DIR, `${date}.jsonl`), JSON.stringify(event) + "\n", "utf-8");
  } catch (err) {
    console.warn(`   ⚠️  codex-p usage log failed: ${err.message}`);
  }
}

/** Rejection for a run the caller cancelled — named so callers can tell it from a failure. */
function cancelledError() {
  const err = new Error("Cancelled");
  err.name = "AbortError";
  return err;
}

/**
 * Run a prompt through `codex exec` (OpenAI Codex CLI) under the local subscription.
 * Spawns a fresh subprocess each call. Uses tmpdir as cwd and --skip-git-repo-check
 * so it works outside a git repo. Prompt is piped via stdin; final agent message is
 * captured via --output-last-message to avoid parsing the streaming event log.
 *
 * @param {string} prompt           The prompt to run.
 * @param {object} [opts]
 * @param {string}   [opts.model]     Model the agent should use. Default: codex CLI default.
 * @param {boolean}  [opts.dashTools] Launch Dash's MCP tool bridge. Default false.
 * @param {string[]} [opts.imagePaths] Local image files to attach to the prompt.
 * @param {number}   [opts.timeoutMs] Abort after this many ms. Default 5 min.
 * @param {string}   [opts.source]    Tag for usage log (e.g. "dynamic-job:abc").
 * @param {AbortSignal} [opts.signal]  Cancel the run. Kills the subprocess, so
 *                                     the subscription stops being spent — not
 *                                     just the caller walking away from it.
 * @returns {Promise<string>}         Trimmed final agent message from `codex exec`.
 */
export function codexP(prompt, opts = {}) {
  const {
    model,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    source = "unknown",
    dashTools = false,
    imagePaths = [],
    signal,
  } = opts;

  const lastMsgFile = join(tmpdir(), `codex-last-${randomUUID()}.txt`);
  const args = [
    "exec",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    "--color", "never",
    // Nothing resumes these runs, so persisting a full transcript of every chat
    // and every scheduled job to ~/.codex/sessions only accumulates.
    "--ephemeral",
    // `--cd DASH_ROOT` (below) is needed to reach the project config, but it also
    // makes Codex load the repo's AGENTS.md — instructions written for coding
    // agents, not for Steve's assistant. Suppress the project doc, keep the cwd.
    "-c", "project_doc_max_bytes=0",
    "--output-last-message", lastMsgFile,
    "-",
  ];
  // Claude's historical sonnet/opus/haiku settings are not Codex model IDs.
  // Let Codex use its configured default unless an explicit Codex model is set.
  const codexModel = process.env.CODEX_MODEL || (
    model && !/(claude|sonnet|opus|haiku)/i.test(model) ? model : undefined
  );
  if (codexModel) args.splice(1, 0, "--model", codexModel);
  if (dashTools) args.splice(-1, 0, "--cd", DASH_ROOT);
  for (const imagePath of imagePaths) args.splice(-1, 0, "--image", imagePath);

  const t0 = Date.now();
  const ts = new Date().toISOString();

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      unlink(lastMsgFile).catch(() => {});
      return reject(cancelledError());
    }
    const child = spawn("codex", args, { cwd: dashTools ? DASH_ROOT : tmpdir() });

    let stdoutBytes = 0;
    let stderr = "";

    const stop = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000);
    };
    const timer = setTimeout(stop, timeoutMs);
    // A cancelled run and a timed-out one both arrive as SIGTERM; the signal is
    // what tells them apart in the close handler below.
    signal?.addEventListener("abort", stop, { once: true });
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    };

    // Drain stdout (the streaming event log) so the pipe doesn't backpressure.
    child.stdout.on("data", (chunk) => { stdoutBytes += chunk.length; });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 16_000) stderr += chunk;
    });

    child.on("error", (err) => {
      done();
      const ms = Date.now() - t0;
      logUsage({ ts, model: model || "default", source, ms, ok: false, error: err.message?.slice(0, 200) });
      unlink(lastMsgFile).catch(() => {});
      reject(err);
    });

    child.on("close", async (code, killedBy) => {
      done();
      const ms = Date.now() - t0;

      if (signal?.aborted) {
        logUsage({ ts, model: model || "default", source, ms, ok: false, error: "cancelled" });
        unlink(lastMsgFile).catch(() => {});
        return reject(cancelledError());
      }
      if (killedBy === "SIGTERM" || killedBy === "SIGKILL") {
        logUsage({ ts, model: model || "default", source, ms, ok: false, error: "timeout" });
        unlink(lastMsgFile).catch(() => {});
        return reject(new Error(`codex exec timed out after ${timeoutMs}ms`));
      }
      if (code !== 0) {
        logUsage({ ts, model: model || "default", source, ms, ok: false, error: `exit ${code}`, stderr: stderr.slice(0, 200) });
        unlink(lastMsgFile).catch(() => {});
        return reject(new Error(`codex exec exited ${code}: ${stderr.slice(0, 500)}`));
      }

      let text = "";
      try {
        const raw = await readFile(lastMsgFile, "utf-8");
        text = raw.length > MAX_OUTPUT_BYTES ? raw.slice(0, MAX_OUTPUT_BYTES) : raw;
        text = text.trim();
      } catch (err) {
        logUsage({ ts, model: model || "default", source, ms, ok: false, error: `read last-message: ${err.message?.slice(0, 100)}` });
        unlink(lastMsgFile).catch(() => {});
        return reject(new Error(`codex exec produced no last-message file: ${err.message}`));
      }
      unlink(lastMsgFile).catch(() => {});

      if (!text) {
        logUsage({ ts, model: model || "default", source, ms, ok: false, error: "empty output", stdoutBytes });
        return reject(new Error(`codex exec returned empty output. stderr: ${stderr.slice(0, 500)}`));
      }

      logUsage({ ts, model: model || "default", source, ms, ok: true, chars: text.length, stdoutBytes });
      resolve(text);
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}
