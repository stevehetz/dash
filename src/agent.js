import { readFileSync } from "node:fs";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { loadTools } from "./tools/loader.js";
import { codexP } from "./llm/codex-p.js";

// Replay budget. Enough for a real back-and-forth, small next to the rest of the
// prompt, and bounded so a long pasted message can't swallow the whole window.
const HISTORY_MAX_TURNS = 16;
const HISTORY_CHAR_BUDGET = 4000;
const HISTORY_TURN_CHARS = 500;

const BASE_SYSTEM_PROMPT = `You are Steve's personal assistant bot. You help manage his personal files via Telegram messages.

## Your capabilities
You can read, write, append to, list, and delete files/folders in Steve's OneDrive. All files are markdown (.md) unless he specifies otherwise.

## How to use your tools
Your tools are not function calls. You run them as shell commands from the project
directory (/Users/stevemini/dev/dash):

    node tools.js call <name> '<json arguments>'
    node tools.js help <name>     — a tool's exact arguments, when you're unsure
    node tools.js list            — every tool, if you need to look one up

Only stdout is the result; progress chatter goes to stderr and you can ignore it.

Always prefer a tool over improvising with raw shell. The tools handle OneDrive paths,
Google and Plaid auth, Apple scripting, and output formatting for you — hand-rolled
\`cat\`/\`ls\`/\`curl\` equivalents will miss all of that and are far more likely to be wrong.
If a call fails, run \`node tools.js help <name>\`, fix the arguments, and try again
rather than working around the tool. The tools you have are listed at the end of this
prompt; use those exact names.

## OneDrive folder structure
The root contains:
- dashbook/ — all of Steve's text notes, markdown files, todos, logs, etc. This is where almost everything goes.
- screencaps/ — screenshots and images only. When Steve says "screencaps", "screenshots", or asks to save an image, use this folder (e.g. screencaps/filename.jpg). NEVER create a screencaps folder inside dashbook/.
- storage/ — archived/bulk files. NEVER touch this folder.

## Key behaviors
- When Steve asks you to create or update a file, DO IT immediately using your tools. Don't just describe what you'd do.
- When Steve asks you to delete a file or folder, use the file tools to do it. For folders, use the directory delete tool.
- When he says something like "save it to the notes folder" he means notes in onedrive. Use list_directory to find the right folder if you're unsure.
- For food logging: estimate macros as best you can and log them. Don't ask for clarification unless it's truly ambiguous. Flag estimates with (est.) if you're guessing.
- When Steve says "remind me", "add a reminder", "reminder", "add a task", or "task" — ALWAYS use Apple Reminders (apple_create_reminder), not files and NEVER add_job. Apple Reminders and Tasks are the same thing: both map to apple_create_reminder.
- When Steve says "apple note" or "apple notes" — use Apple Notes (apple_search_notes, apple_read_note, etc.). If he just says "note" without "apple", use his notes directory.
- For todo lists, notes, or any other content: just create/update files as requested.
- Keep responses concise — this is Telegram, not an essay. A quick confirmation + what you did is enough.
- Message style: Steve does not like long blocks of text or multi-sentence paragraphs in Telegram messages. Use short phrases, concise single sentences, and bullets when listing things. Break content into scannable lines, never dense paragraphs. This applies to ALL messages sent to Steve, including scheduled job output.
- When Steve says "send me a Telegram message", "text me", or "message me" — just respond with the requested content normally. The bot will automatically forward your response to him on Telegram. Do NOT say you can't send Telegram messages.
- If you need to know the folder structure, use list_directory to explore.
- When creating new files, use descriptive filenames with the date when it makes sense (e.g., "todo-2026-03-15.md").

## Important
- ALWAYS use the tools to actually perform file operations. Never just say "I would create a file..." — actually create it.
- After performing an action, briefly confirm what you did and where.
- ALWAYS follow the rules in the DASH.md section below. Steve can update this file anytime to change your behavior.

## Personality
- You have a light touch of subtle sarcasm — dry, witty, never mean. Think helpful friend who can't resist a well-placed quip. Keep it brief and natural, not forced. The sarcasm should complement your helpfulness, not undermine it.

`;

export class Agent {
  constructor(fileManager, services = {}, model) {
    this.fileManager = fileManager;
    this.services = services;
    this.model = model;

    // Will be populated by init()
    this.tools = [];
    this.toolsSystemPrompt = "";
    this._handleToolCall = async () => "Skills not loaded yet";
  }

  /**
   * Load all integrations. Must be called before chat().
   */
  async init() {
    const { tools, systemPrompt, handleToolCall, startBackgroundTasks } = await loadTools({
      fileManager: this.fileManager,
      ...this.services,
    });

    this.tools = tools;
    this.toolsSystemPrompt = systemPrompt;
    this._handleToolCall = handleToolCall;
    this._startBackgroundTasks = startBackgroundTasks;
  }

  /**
   * Replay the tail of a channel's transcript so follow-ups resolve ("add that to
   * a file", "move the second one"). Newest turns are kept: the walk runs backwards
   * and stops at the budget, so a long recent turn crowds out old ones rather than
   * the reverse.
   */
  _formatHistory(history) {
    if (!Array.isArray(history) || history.length === 0) return "";

    const lines = [];
    let used = 0;
    for (let i = history.length - 1; i >= 0 && lines.length < HISTORY_MAX_TURNS; i--) {
      const entry = history[i];
      const text = String(entry?.text || "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      const clipped = text.length > HISTORY_TURN_CHARS ? `${text.slice(0, HISTORY_TURN_CHARS - 3)}...` : text;
      const line = `${entry.from === "dash" ? "Dash" : "Steve"}: ${clipped}`;
      if (used + line.length > HISTORY_CHAR_BUDGET) break;
      used += line.length;
      lines.unshift(line);
    }
    if (lines.length === 0) return "";

    return `\n\n## Recent conversation
Earlier turns with Steve, oldest first — this is context, not a new request. Use it to
resolve references like "that", "it", or "the second one". Do not answer these again.
${lines.join("\n")}`;
  }

  /**
   * The tool roster, as names plus a one-line summary. Full argument schemas are
   * ~34KB and would dwarf everything else, so they stay behind
   * `node tools.js help <name>` and only the index travels with every request.
   */
  _toolIndex() {
    if (!this.tools.length) return "";
    const lines = this.tools.map((t) => {
      const first = String(t.description || "").trim().split(/(?<=\.)\s/)[0] || "";
      return `- ${t.name} — ${first.length > 120 ? first.slice(0, 117) + "..." : first}`;
    });
    return `\n\n## Available tools\nRun as \`node tools.js call <name> '<json>'\`. Use \`node tools.js help <name>\` for arguments.\n${lines.join("\n")}`;
  }

  /**
   * Build the full system prompt, reading assistant files fresh each time.
   */
  _buildSystemPrompt() {
    const readAssistantFile = (filename) => {
      try {
        return readFileSync(join(this.fileManager.root, "dashbook", "dash", filename), "utf-8").trim();
      } catch {
        return "";
      }
    };

    const assistantMd = readAssistantFile("DASH.md");

    const now = new Date().toLocaleString("en-US", {
      timeZone: "America/New_York",
      dateStyle: "full",
      timeStyle: "short",
    });

    // Compute the current UTC offset for America/New_York (handles DST automatically)
    const nowDate = new Date();
    const utcStr = nowDate.toLocaleString("en-US", { timeZone: "UTC" });
    const etStr = nowDate.toLocaleString("en-US", { timeZone: "America/New_York" });
    const diffMs = new Date(etStr) - new Date(utcStr);
    const diffHours = diffMs / 3600000;
    const utcOffset = diffHours <= 0 ? `${String(diffHours).padStart(3, '0')}:00` : `+${String(diffHours).padStart(2, '0')}:00`;

    return BASE_SYSTEM_PROMPT
      + this.toolsSystemPrompt
      + (assistantMd ? `\n\n## DASH.md\n${assistantMd}` : "")
      + `\n\nToday's date and time: ${now} (UTC offset: ${utcOffset}, use this for all ISO 8601 dates)`
      + this._toolIndex();
  }

  /**
   * Send a message and return the model's final text response. Every caller
   * (Telegram, voice, dashapp, cli, jobs) comes through here.
   */
  async chat(userId, userMessage, modelOverride, opts = {}) {
    return this._chatCodexP(userId, userMessage, modelOverride, opts);
  }

  /**
   * Each run is a fresh `codex exec` — there is no session to
   * resume — so continuity comes from `opts.history`: the recent turns of this
   * channel's transcript, replayed into the prompt. Callers that should stay
   * stateless (scheduled jobs, the email poller) simply pass none.
   */
  async _chatCodexP(userId, userMessage, modelOverride, opts = {}) {
    const { text, imagePaths } = await this._prepareCodexInput(userMessage);
    const model = modelOverride || this.model;
    const preview = text.substring(0, 100);
    const history = this._formatHistory(opts.history);
    console.log(`💬 chat(${userId}) [codex-p] model=${process.env.CODEX_MODEL || "default"} images=${imagePaths.length} history=${opts.history?.length || 0}: "${preview}"`);

    try {
      return await codexP(
        `${this._buildSystemPrompt()}${history}\n\n## Current user message\n${text}`,
        { model, imagePaths, dashTools: true, source: `chat:${userId}` },
      );
    } finally {
      await Promise.all(imagePaths.map((path) => unlink(path).catch(() => {})));
    }
  }

  /** Convert Telegram's Anthropic-style image blocks into Codex CLI attachments. */
  async _prepareCodexInput(userMessage) {
    if (typeof userMessage === "string") return { text: userMessage, imagePaths: [] };

    const text = [];
    const imagePaths = [];
    for (const block of userMessage) {
      if (block?.type === "text") {
        text.push(block.text || "");
        continue;
      }
      if (block?.type === "image" && block.source?.type === "base64" && block.source.data) {
        const ext = block.source.media_type === "image/png" ? "png" : "jpg";
        const path = join(tmpdir(), `dash-codex-image-${randomUUID()}.${ext}`);
        await writeFile(path, Buffer.from(block.source.data, "base64"));
        imagePaths.push(path);
      }
    }
    return { text: text.join("\n") || "What do you see in this image?", imagePaths };
  }

  /** Start background skills (jobs, etc.) */
  startBackgroundTasks({ userId, bot, deliver }) {
    return this._startBackgroundTasks({ agent: this, userId, bot, deliver });
  }

}
