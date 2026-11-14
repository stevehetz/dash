import { createServer } from "node:http";
import { readFileSync, writeFileSync, unlinkSync, mkdtempSync, watch as fsWatch } from "node:fs";
import { readFile as fsReadFile, readdir as fsReaddir, writeFile as fsWriteFile, mkdir as fsMkdir, unlink as fsUnlink, stat as fsStat } from "node:fs/promises";
import { join, extname, normalize, resolve, dirname, basename, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { exec, execFile } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { Telegraf, Telegram } from "telegraf";
import { llmOneShot } from "./src/llm/one-shot.js";

import { createServices } from "./src/setup.js";
import { Agent } from "./src/agent.js";
import { lookupFood, nutritionAssist, logAssist, appendFoodRow, replaceFoodRow, buildFoodRecord, readNutritionTable, writeTempImage, removeTempImage, readGroupsWithTotals, saveGroup, deleteGroup, deleteFoodRow, readLogsWithTotals, saveLog, deleteLog, readTargetsConfig, writeTargetsItem, rescaleFoodReferences, renameFoodReferences, countFoodReferences } from "./src/nutrition.js";
import { libraryAssist } from "./src/docs.js";
import { readConfig as readJobsConfig, writeConfig as writeJobsConfig } from "./src/tools/dynamic-jobs/skill.js";

// ── Validate config ──────────────────────────────────────
const required = ["ALLOWED_USER_ID", "ONEDRIVE_PATH"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    console.error(`Copy .env.example to .env and fill in your values.`);
    process.exit(1);
  }
}

const ALLOWED_USER_ID = parseInt(process.env.ALLOWED_USER_ID, 10);
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
const TELEGRAM_ENABLED = process.env.TELEGRAM_ENABLED === "true";

// ── Security: only allow YOUR messages ───────────────────
function setupBot(bot, agent, fileManager) {
  bot.catch((err, ctx) => {
    console.error(`Bot error for ${ctx.updateType}:`, err.message);
    ctx.reply("Something went wrong, but I'm still running. Try again.").catch(() => {});
  });

  bot.use((ctx, next) => {
    if (ctx.from?.id !== ALLOWED_USER_ID) {
      console.log(
        `Blocked message from unauthorized user: ${ctx.from?.id} (${ctx.from?.username})`
      );
      return; // silently ignore
    }
    return next();
  });

  // ── Commands ─────────────────────────────────────────────
  bot.command("start", (ctx) => {
    ctx.reply(
      "Hey! I'm your personal assistant. Send me a message and I'll manage your files.\n\n" +
        "Examples:\n" +
        '• "Create a todo list for today in the General folder"\n' +
        '• "Log breakfast: Greek yogurt with blueberries and honey"\n' +
        '• "What files are in my notes?"\n' +
        '• "Read my todo list"\n\n' +
        "Commands:\n" +
        "/clear — Reset conversation history\n" +
        "/folders — Show top-level notes structure"
    );
  });

  bot.command("clear", async (ctx) => {
    await clearConversation();
    ctx.reply("Cleared — I won't refer back to anything before this.");
  });

  bot.command("sonnet", (ctx) => {
    ctx.reply("Dash uses the configured Codex model. Set CODEX_MODEL in config/.env to choose a specific one.");
  });

  bot.command("haiku", (ctx) => {
    ctx.reply("Dash uses the configured Codex model. Set CODEX_MODEL in config/.env to choose a specific one.");
  });

  bot.command("opus", (ctx) => {
    ctx.reply("Dash uses the configured Codex model. Set CODEX_MODEL in config/.env to choose a specific one.");
  });

  bot.command("folders", async (ctx) => {
    try {
      const overview = await fileManager.getFolderOverview(".", 2);
      ctx.reply(
        "📂 Your notes:\n\n" + overview.join("\n") || "Empty or inaccessible."
      );
    } catch (err) {
      ctx.reply(`Error listing folders: ${err.message}`);
    }
  });

  // ── Handle all text messages ─────────────────────────────
  bot.on("text", async (ctx) => {
    const userId = ctx.from.id;
    const message = ctx.message.text;

    // Log inbound user text. Outbound replies are captured automatically by
    // the bot.telegram.sendMessage patch further down — no need to record here.
    if (!message.startsWith("/")) recordMessage("user", message);

    // Show "typing" indicator while processing
    await ctx.sendChatAction("typing");

    try {
      const response = await agent.chat(userId, message, undefined, { history: recentTurns("telegram") });

      // Telegram has a 4096 char limit per message
      if (response.length <= 4096) {
        await ctx.reply(response, { parse_mode: "Markdown" }).catch(() => {
          // If Markdown parsing fails, send as plain text
          ctx.reply(response);
        });
      } else {
        // Split long responses
        const chunks = response.match(/[\s\S]{1,4000}/g) || [response];
        for (const chunk of chunks) {
          await ctx.reply(chunk);
        }
      }
    } catch (err) {
      console.error("Error processing message:", err);
      await ctx.reply(`Something went wrong: ${err.message}`);
    }
  });

  // ── Handle photo messages ────────────────────────────────
  bot.on("photo", async (ctx) => {
    const userId = ctx.from.id;

    await ctx.sendChatAction("typing");

    try {
      // Telegram sends multiple sizes — grab the largest one
      const photos = ctx.message.photo;
      const photo = photos[photos.length - 1];

      // Download the photo
      const fileLink = await ctx.telegram.getFileLink(photo.file_id);
      const res = await fetch(fileLink.href);
      const buffer = Buffer.from(await res.arrayBuffer());
      const base64 = buffer.toString("base64");

      // Save image to disk for dashapp display
      const imageFilename = `${Date.now()}.jpg`;
      await fsMkdir(TELEGRAM_IMAGES_DIR, { recursive: true });
      await fsWriteFile(join(TELEGRAM_IMAGES_DIR, imageFilename), buffer);

      // Build content blocks for Claude
      const content = [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/jpeg",
            data: base64,
          },
        },
      ];

      // Store base64 so Claude can save it via save_image tool if asked
      fileManager.pendingImage = { base64, mimeType: "image/jpeg" };

      // Include caption if provided
      const caption = ctx.message.caption || "What do you see in this image?";
      content.push({ type: "text", text: `${caption}\n\n(If Steve wants this image saved, use the save_image tool — the image data is already stored, just provide the path.)` });

      // Record the user message with image
      recordMessage("user", caption !== "What do you see in this image?" ? caption : "", `/telegram-images/${imageFilename}`);

      const response = await agent.chat(userId, content, undefined, { history: recentTurns("telegram") });

      if (response.length <= 4096) {
        await ctx.reply(response, { parse_mode: "Markdown" }).catch(() => {
          ctx.reply(response);
        });
      } else {
        const chunks = response.match(/[\s\S]{1,4000}/g) || [response];
        for (const chunk of chunks) {
          await ctx.reply(chunk);
        }
      }
    } catch (err) {
      console.error("Error processing photo:", err);
      await ctx.reply(`Something went wrong processing the image: ${err.message}`);
    }
  });

  // ── Handle document/file messages ───────────────────────
  bot.on("document", async (ctx) => {
    const userId = ctx.from.id;
    const doc = ctx.message.document;

    await ctx.sendChatAction("typing");

    try {
      const fileLink = await ctx.telegram.getFileLink(doc.file_id);
      const res = await fetch(fileLink.href);

      // Store raw document data so print_pending_document can access it
      const rawBuffer = Buffer.from(await res.clone().arrayBuffer());
      fileManager.pendingDocument = { buffer: rawBuffer, fileName: doc.file_name, mimeType: doc.mime_type };

      let text;
      if (doc.file_name?.endsWith(".pages")) {
        // Save to temp file, use Pages.app to export as plain text
        const tmp = mkdtempSync(join(tmpdir(), "dash-pages-"));
        const pagesPath = join(tmp, doc.file_name);
        const txtPath = join(tmp, "output.txt");
        writeFileSync(pagesPath, Buffer.from(await res.arrayBuffer()));

        const script = `
          tell application "Pages"
            activate
            open POSIX file "${pagesPath}"
            repeat 30 times
              try
                set docName to name of front document
                exit repeat
              end try
              delay 1
            end repeat
            export front document to POSIX file "${txtPath}" as unformatted text
            close front document saving no
          end tell
        `;
        await new Promise((resolve, reject) => {
          execFile("osascript", ["-e", script], { timeout: 60000 }, (err) => err ? reject(err) : resolve());
        });
        text = readFileSync(txtPath, "utf-8");
        // Clean up temp files
        try { unlinkSync(pagesPath); unlinkSync(txtPath); } catch {}
      } else {
        text = await res.text();
      }

      const caption = ctx.message.caption || "";
      const intro = caption
        ? `${caption}\n\nFile: ${doc.file_name}\n\n${text}`
        : `I'm sending you the contents of "${doc.file_name}":\n\n${text}`;

      const response = await agent.chat(userId, intro, undefined, { history: recentTurns("telegram") });

      if (response.length <= 4096) {
        await ctx.reply(response, { parse_mode: "Markdown" }).catch(() => ctx.reply(response));
      } else {
        const chunks = response.match(/[\s\S]{1,4000}/g) || [response];
        for (const chunk of chunks) {
          await ctx.reply(chunk);
        }
      }
    } catch (err) {
      console.error("Error processing document:", err);
      await ctx.reply(`Something went wrong processing the file: ${err.message}`);
    }
  });

  // ── Handle voice messages ────────────────────────────────
  bot.on("voice", async (ctx) => {
    await ctx.reply(
      "I can't process voice messages directly yet. " +
        "Use Telegram's speech-to-text (hold the voice message and tap the text option) " +
        "and send it as text instead!"
    );
  });
}

// ── Graceful shutdown ────────────────────────────────────
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN || "unused", {
  handlerTimeout: 300_000, // 5 minutes for long-running tasks
});
process.once("SIGINT", () => { if (TELEGRAM_ENABLED) bot.stop("SIGINT"); process.exit(0); });
process.once("SIGTERM", () => { if (TELEGRAM_ENABLED) bot.stop("SIGTERM"); process.exit(0); });
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err.message);
});
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err.message || err);
});

// ── Launch ───────────────────────────────────────────────
const services = await createServices();

console.log("🤖 Bot starting...");
console.log(`   OneDrive path: ${process.env.ONEDRIVE_PATH}`);
console.log(`   LLM model: ${process.env.CODEX_MODEL || CLAUDE_MODEL}`);
console.log(`   Allowed user: ${ALLOWED_USER_ID}`);

const agent = new Agent(services.fileManager, services, CLAUDE_MODEL);

console.log("   Loading tools...");
await agent.init();

if (TELEGRAM_ENABLED) setupBot(bot, agent, services.fileManager);

// ── Config helpers ──────────────────────────────────────
function _readConfig() {
  try {
    const configPath = join(process.env.ONEDRIVE_PATH, "dashbook", "dash", "config", "CONFIG.json");
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return { silent_phone: false, silent_room: false };
  }
}

// ── TTS helpers ─────────────────────────────────────────
async function _getTtsText(fullResponse) {
  const text = await llmOneShot({
    user: `Summarize this response in one very brief spoken sentence (max 12 words, no markdown, no punctuation at end): ${fullResponse}`,
    model: "haiku",
    maxTokens: 60,
    source: "tts",
  });
  return text.trim();
}

function _speak(text, room, ttsUrl) {
  const url = ttsUrl || "http://127.0.0.1:3002/tts";
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, room }),
  }).catch((err) => console.error("TTS error:", err.message));
}

// ── Voice HTTP endpoint ──────────────────────────────────
const VOICE_PORT = parseInt(process.env.VOICE_PORT || "3001", 10);

// The server binds 0.0.0.0 so the MBP voice agent can reach it over the LAN, which
// also means anything on the same network can reach it. Loopback is trusted: that is
// the local voice listener and Tailscale Serve (the iPhone/dashapp path), which proxies
// tailnet traffic in from 127.0.0.1. Every other caller must send DASH_HTTP_TOKEN in
// the X-Dash-Token header. If the token is unset, non-loopback requests are refused.
const DASH_HTTP_TOKEN = process.env.DASH_HTTP_TOKEN || "";
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function isAuthorizedRequest(req) {
  if (LOOPBACK.has(req.socket.remoteAddress)) return true;
  if (!DASH_HTTP_TOKEN) return false;
  const given = Buffer.from(String(req.headers["x-dash-token"] || ""));
  const expected = Buffer.from(DASH_HTTP_TOKEN);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// Tracks which room/device the last voice command came from.
// Used later for TTS so Dash responds to the right speaker.
export let lastVoiceRoom = null;

// ── Dashapp (web UI) ───────────────────────────────────
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const WEB_DIR = resolve(__dirname, "web");
const AVATARS_DIR = resolve(__dirname, "avatars");
const TELEGRAM_IMAGES_DIR = join(process.env.ONEDRIVE_PATH, "dashbook", "images", "telegram");
const JOBS_PATH = `${process.env.ONEDRIVE_PATH}/dashbook/dash/config/JOBS_DYNAMIC.json`;
const SYSTEM_JOBS_PATHS = [
  join(process.env.ONEDRIVE_PATH, "dashbook", "dash", "config", "JOBS_SYSTEM.json"),
  join(process.env.ONEDRIVE_PATH, "dashbook", "dash", "config", "jobs_system.json"),
];
const NOTEBOOK_DIR = `${process.env.ONEDRIVE_PATH}/dashbook`;
const DASH_DIR = `${process.env.ONEDRIVE_PATH}/dashbook/dash`;
const PNC_REPORTS_DIR = `${process.env.ONEDRIVE_PATH}/dashbook/data/reports/pnc`;
// Nutrient reference table, exported from the "raw" tab of nutrition.xlsm.
const NUTRITION_FILE = `${process.env.ONEDRIVE_PATH}/dashbook/nutrition/raw.csv`;
// A food lookup takes several photos of the same item (package front, nutrition
// panel, ingredients). Capped so one request can't blow past the body limit.
const MAX_LOOKUP_PHOTOS = 6;
// A missing log file just means nothing has been logged yet.

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
};

const NOTE_ASSET_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico"]);

// What the Library page shows of dashbook/. Text it can render and edit;
// the rest it can only display.
const LIBRARY_TEXT_EXTS = new Set([".md", ".json", ".jsonl", ".csv", ".txt"]);
const LIBRARY_BINARY_EXTS = new Set([".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".heic"]);
const LIBRARY_FILE_EXTS = new Set([...LIBRARY_TEXT_EXTS, ...LIBRARY_BINARY_EXTS]);
// Which of those an image model can actually be handed.
const LIBRARY_VIEWABLE_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

// SSE clients subscribed to jobs updates
const jobsClients = new Set();
// SSE clients subscribed to library (dashbook file tree + contents) updates
const libraryClients = new Set();
// ── Message history ─────────────────────────────────────
// Persisted to OneDrive so history survives restarts and syncs across devices.
const MESSAGES_MAX = 500;
const MESSAGES_FILE = join(process.env.ONEDRIVE_PATH, "dashbook", "data", "telegram.json");
const MESSAGES_DEFAULT_LIMIT = 40; // how many to send to dashapp by default
const messagesHistory = []; // { from: 'user' | 'dash', text, ts }

// ── Chat history (dashapp-only, never touches Telegram) ──
const CHAT_MAX = 500;
const CHAT_FILE = join(process.env.ONEDRIVE_PATH, "dashbook", "data", "chat.json");
const CHAT_DEFAULT_LIMIT = 40;
const chatHistory = []; // { from: 'user' | 'dash', text, ts }

try {
  const raw = readFileSync(CHAT_FILE, "utf-8");
  const loaded = JSON.parse(raw);
  if (Array.isArray(loaded)) chatHistory.push(...loaded.slice(-CHAT_MAX));
  console.log(`   💬 Loaded ${chatHistory.length} prior chat messages from ${CHAT_FILE}`);
} catch { /* file may not exist on first run */ }

try {
  const raw = readFileSync(MESSAGES_FILE, "utf-8");
  const loaded = JSON.parse(raw);
  if (Array.isArray(loaded)) messagesHistory.push(...loaded.slice(-MESSAGES_MAX));
  console.log(`   💬 Loaded ${messagesHistory.length} prior messages from ${MESSAGES_FILE}`);
} catch { /* file may not exist on first run */ }

let messagesSaveTimer = null;
function persistMessages() {
  clearTimeout(messagesSaveTimer);
  messagesSaveTimer = setTimeout(async () => {
    try {
      await fsMkdir(dirname(MESSAGES_FILE), { recursive: true });
      await fsWriteFile(MESSAGES_FILE, JSON.stringify(messagesHistory));
    } catch (err) {
      console.error("Failed to persist messages:", err.message);
    }
  }, 500);
}

function recordMessage(from, text, image) {
  if (!text && !image) return;
  // Dedupe: if the last entry is the same source + same text within 2s, skip.
  // This handles ctx.reply's Markdown-fallback double-send pattern and any
  // other place that tries the same payload twice in quick succession.
  const last = messagesHistory[messagesHistory.length - 1];
  const now = Date.now();
  if (last && last.from === from && last.text === text && now - last.ts < 2000) return;
  const entry = { from, text: text || "", ts: now };
  if (image) entry.image = image;
  messagesHistory.push(entry);
  while (messagesHistory.length > MESSAGES_MAX) messagesHistory.shift();
  persistMessages();
}

// ── Cleanup: prune messages + images older than 60 days ──
const MESSAGES_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

async function cleanupOldMessages() {
  const cutoff = Date.now() - MESSAGES_MAX_AGE_MS;
  const before = messagesHistory.length;

  // Collect image paths from messages we're about to remove
  const imagesToDelete = [];
  const remaining = [];
  for (const m of messagesHistory) {
    if (m.ts && m.ts < cutoff) {
      if (m.image) imagesToDelete.push(m.image);
    } else {
      remaining.push(m);
    }
  }

  if (remaining.length < before) {
    messagesHistory.length = 0;
    messagesHistory.push(...remaining);
    persistMessages();
    console.log(`🧹 Pruned ${before - remaining.length} messages older than 60 days`);
  }

  // Delete orphaned image files
  for (const imgPath of imagesToDelete) {
    try {
      const filename = imgPath.split("/").pop();
      await fsUnlink(join(TELEGRAM_IMAGES_DIR, filename));
    } catch { /* already gone */ }
  }

  // Also clean up any image files on disk not referenced by any message
  try {
    const files = await fsReaddir(TELEGRAM_IMAGES_DIR);
    const referencedImages = new Set(
      messagesHistory.filter((m) => m.image).map((m) => m.image.split("/").pop())
    );
    for (const file of files) {
      if (!referencedImages.has(file)) {
        const filePath = join(TELEGRAM_IMAGES_DIR, file);
        const st = await fsStat(filePath).catch(() => null);
        if (st && st.mtimeMs < cutoff) {
          await fsUnlink(filePath).catch(() => {});
        }
      }
    }
  } catch { /* dir may not exist yet */ }
}

// Run cleanup on startup and then daily
cleanupOldMessages();
setInterval(cleanupOldMessages, 24 * 60 * 60 * 1000);

// ── Chat history helpers (dashapp-only) ────────────────
let chatSaveTimer = null;
function persistChat() {
  clearTimeout(chatSaveTimer);
  chatSaveTimer = setTimeout(async () => {
    try {
      await fsMkdir(dirname(CHAT_FILE), { recursive: true });
      await fsWriteFile(CHAT_FILE, JSON.stringify(chatHistory));
    } catch (err) {
      console.error("Failed to persist chat:", err.message);
    }
  }, 500);
}

function recordChat(from, text) {
  if (!text) return;
  const last = chatHistory[chatHistory.length - 1];
  const now = Date.now();
  if (last && last.from === from && last.text === text && now - last.ts < 2000) return;
  chatHistory.push({ from, text, ts: now });
  while (chatHistory.length > CHAT_MAX) chatHistory.shift();
  persistChat();
}

// ── Conversation continuity ─────────────────────────────
// Each codex run is a fresh process with no session to resume, so short-term memory
// is the tail of the transcript we already keep for the dashapp. `/clear` writes a
// cutoff rather than deleting anything — the UI history stays intact, the agent just
// stops being shown what came before.
const CUTOFFS_FILE = join(process.env.ONEDRIVE_PATH, "dashbook", "data", "chat-cutoffs.json");
const chatCutoffs = { telegram: 0, chat: 0 };

try {
  Object.assign(chatCutoffs, JSON.parse(readFileSync(CUTOFFS_FILE, "utf-8")));
} catch { /* no cutoffs set yet */ }

/**
 * Recent turns for a channel: "telegram" (Telegram + voice) or "chat" (dashapp).
 *
 * Callers record Steve's message before handing it to the agent, so the last entry
 * is usually the message being answered right now. It is dropped here — it travels
 * as the current message and would otherwise appear twice.
 */
function recentTurns(channel) {
  const store = channel === "chat" ? chatHistory : messagesHistory;
  const cutoff = chatCutoffs[channel] || 0;
  const turns = store.filter((m) => m.ts > cutoff);
  if (turns.length && turns[turns.length - 1].from === "user") turns.pop();
  return turns.slice(-40);
}

async function clearConversation() {
  const now = Date.now();
  chatCutoffs.telegram = now;
  chatCutoffs.chat = now;
  try {
    await fsMkdir(dirname(CUTOFFS_FILE), { recursive: true });
    await fsWriteFile(CUTOFFS_FILE, JSON.stringify(chatCutoffs));
  } catch (err) {
    console.error("Failed to persist chat cutoffs:", err.message);
  }
}

// ── Deliver message ─────────────────────────────────────
// Central function for delivering Dash's outbound messages. Records to
// history (which handles SSE broadcast + push notification) and optionally
// forwards to Telegram when enabled.
function deliverMessage(text) {
  if (!text || typeof text !== "string") return Promise.resolve();
  recordMessage("dash", text);
  if (TELEGRAM_ENABLED) {
    return bot.telegram.sendMessage(ALLOWED_USER_ID, text, { parse_mode: "Markdown" })
      .catch(() => bot.telegram.sendMessage(ALLOWED_USER_ID, text));
  }
  return Promise.resolve();
}

// When Telegram is enabled, also patch prototype so ctx.reply and any other
// sendMessage calls are mirrored into the messages tab.
if (TELEGRAM_ENABLED) {
  const _origSendMessage = Telegram.prototype.sendMessage;
  Telegram.prototype.sendMessage = function (chatId, text, ...rest) {
    try {
      if (Number(chatId) === ALLOWED_USER_ID && typeof text === "string") {
        recordMessage("dash", text);
      }
    } catch { /* never block sending on logging failure */ }
    return _origSendMessage.call(this, chatId, text, ...rest);
  };
}

async function readJobsRaw() {
  try {
    return await fsReadFile(JOBS_PATH, "utf-8");
  } catch {
    return JSON.stringify({ jobs: [] });
  }
}

async function resolveSystemJobsPath() {
  for (const filePath of SYSTEM_JOBS_PATHS) {
    try {
      const info = await fsStat(filePath);
      if (info.isFile()) return filePath;
    } catch {}
  }
  return SYSTEM_JOBS_PATHS[0];
}

function displayConfigPath(filePath) {
  const base = `${process.env.ONEDRIVE_PATH}${sep}`;
  return filePath.startsWith(base) ? filePath.slice(base.length) : filePath;
}

async function readSystemJobsConfig() {
  const filePath = await resolveSystemJobsPath();
  try {
    const raw = await fsReadFile(filePath, "utf-8");
    return { config: JSON.parse(raw), path: displayConfigPath(filePath) };
  } catch (err) {
    if (err.code === "ENOENT") return { config: { jobs: {} }, path: displayConfigPath(filePath) };
    throw err;
  }
}

function validateSystemJobsConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Config must be a JSON object");
  }
  if (!config.jobs || typeof config.jobs !== "object" || Array.isArray(config.jobs)) {
    throw new Error("Config must include a jobs object");
  }
}

async function writeSystemJobsConfig(config) {
  validateSystemJobsConfig(config);
  const filePath = await resolveSystemJobsPath();
  await fsMkdir(dirname(filePath), { recursive: true });
  await fsWriteFile(filePath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  return { config, path: displayConfigPath(filePath) };
}

function broadcastJobs(raw) {
  const payload = `event: update\ndata: ${raw.replace(/\n/g, "")}\n\n`;
  for (const res of jobsClients) {
    try { res.write(payload); } catch { /* ignore */ }
  }
}

// The local YYYY-MM-DD an ISO timestamp falls on.
function localDateOf(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function readJsonRequest(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * The dashapp's two nutrition AI helpers share a request shape: a text prompt
 * plus up to MAX_LOOKUP_PHOTOS photos as data URLs, a body far past
 * readJsonRequest's 1 MB cap, and temp image files that have to be cleaned up
 * whichever way the run ends.
 *
 * They're also cancellable: the browser aborts the fetch, which closes the
 * socket, which aborts the run — the model subprocess is killed rather than
 * left to finish into nothing.
 *
 * `run({ text, imagePaths, parsed, signal })` returns the JSON to send back.
 */
function handleAssistRequest(req, res, label, run) {
  let body = "";
  let tooBig = false;
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 24_000_000 && !tooBig) { tooBig = true; req.destroy(); }
  });
  req.on("end", async () => {
    if (tooBig) return;
    let parsed;
    try { parsed = JSON.parse(body); } catch {
      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }
    const { text = "", images = [] } = parsed || {};
    const photos = (Array.isArray(images) ? images : []).filter(Boolean).slice(0, MAX_LOOKUP_PHOTOS);
    if (!String(text).trim() && !photos.length) {
      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Ask a question, attach a photo, or both" }));
      return;
    }
    const imagePaths = [];
    const controller = new AbortController();
    // The browser hanging up is the cancel: nobody is waiting for this answer,
    // so stop paying for it.
    const onClose = () => { if (!res.writableFinished) controller.abort(); };
    res.on("close", onClose);
    try {
      for (const photo of photos) imagePaths.push(await writeTempImage(photo));
      const result = await run({ text: String(text), imagePaths, parsed, signal: controller.signal });
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
    } catch (err) {
      if (controller.signal.aborted) console.log(`   ⏹  ${label} cancelled`);
      else {
        console.error(`   ⚠️  ${label} failed: ${err.message}`);
        if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: err.message }));
      }
    } finally {
      res.off("close", onClose);
      for (const p of imagePaths) await removeTempImage(p);
    }
  });
  req.on("error", () => {
    if (!res.headersSent) res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Request too large" }));
  });
}

// Watch the jobs file and push updates to all SSE clients.
// Watch the parent directory, not the file: fs.watch on a file silently dies
// when the file is replaced by rename (OneDrive sync, atomic writes).
// fs.watch can fire multiple times per change; debounce briefly.
let watchDebounce = null;
try {
  const jobsFileName = basename(JOBS_PATH);
  fsWatch(dirname(JOBS_PATH), { persistent: false }, (eventType, filename) => {
    if (filename && filename !== jobsFileName) return;
    clearTimeout(watchDebounce);
    watchDebounce = setTimeout(async () => {
      const raw = await readJobsRaw();
      broadcastJobs(raw);
    }, 100);
  });
} catch (err) {
  console.warn(`   ⚠️  Could not watch jobs file: ${err.message}`);
}

// ── Library: the whole notebook, one tree ──────────────
// The Library page browses dashbook/ itself rather than four fixed corners of
// it, so one listing, one watcher and one file endpoint serve the lot. Paths
// are relative to dashbook/ — "notes/food/chili.md", "data/reports/pnc/…".
async function listLibrary() {
  async function walk(absDir, relDir) {
    const out = { dirs: [], files: [] };
    let entries;
    try {
      entries = await fsReaddir(absDir, { withFileTypes: true });
    } catch {
      return out;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const childRel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        const child = await walk(join(absDir, e.name), childRel);
        out.dirs.push({ name: e.name, path: childRel, dirs: child.dirs, files: child.files });
      } else if (e.isFile() && LIBRARY_FILE_EXTS.has(extname(e.name).toLowerCase())) {
        out.files.push({ name: e.name, path: childRel });
      }
    }
    return out;
  }
  return walk(NOTEBOOK_DIR, "");
}

// Every library path, one per line — what Ask Dash is given to work from when
// no file is open, so it can say where a thing lives without reading anything.
async function libraryListing() {
  const paths = [];
  (function collect(node) {
    for (const f of node.files) paths.push(f.path);
    for (const d of node.dirs) collect(d);
  })(await listLibrary());
  return paths.sort().join("\n");
}

function isLibraryTextPath(p) {
  return typeof p === "string" && LIBRARY_TEXT_EXTS.has(extname(p).toLowerCase());
}

function isValidLibraryRelPath(p) {
  if (typeof p !== "string") return false;
  if (!LIBRARY_FILE_EXTS.has(extname(p).toLowerCase())) return false;
  if (p.includes("\\") || p.startsWith("/")) return false;
  // Dot-segments are how you climb out, and dot-directories are the ones the
  // listing leaves out — neither is reachable by path either.
  return p.split("/").every((seg) => seg && !seg.startsWith("."));
}

function libraryItemPath(relPath) {
  if (!isValidLibraryRelPath(relPath)) return null;
  const filePath = join(NOTEBOOK_DIR, relPath);
  if (!filePath.startsWith(NOTEBOOK_DIR)) return null;
  return filePath;
}


function sseSend(res, event, data) {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  try {
    res.write(`event: ${event}\ndata: ${payload.replace(/\n/g, "\\n")}\n\n`);
  } catch { /* ignore */ }
}

function broadcastLibrary(event, data) {
  for (const res of libraryClients) sseSend(res, event, data);
}

// Watch dashbook whole: the list refresh is cheap and covers adds, removes and
// renames, and a text file that changed goes back out with its new contents so
// an open file redraws itself. Debounced per path — one save fires the watcher
// more than once.
const libraryWatchDebounce = new Map();
let libraryListDebounce = null;
try {
  fsWatch(NOTEBOOK_DIR, { recursive: true, persistent: false }, (eventType, filename) => {
    clearTimeout(libraryListDebounce);
    libraryListDebounce = setTimeout(async () => {
      broadcastLibrary("items", { tree: await listLibrary() });
    }, 120);

    if (!filename) return;
    const relPath = filename.split(sep).join("/");
    if (!isLibraryTextPath(relPath) || !isValidLibraryRelPath(relPath)) return;
    clearTimeout(libraryWatchDebounce.get(relPath));
    libraryWatchDebounce.set(
      relPath,
      setTimeout(async () => {
        libraryWatchDebounce.delete(relPath);
        const filePath = libraryItemPath(relPath);
        if (!filePath) return;
        try {
          broadcastLibrary("content", { path: relPath, content: await fsReadFile(filePath, "utf-8") });
        } catch { /* file may have been deleted */ }
      }, 120)
    );
  });
} catch (err) {
  console.warn(`   ⚠️  Could not watch ${NOTEBOOK_DIR}: ${err.message}`);
}

async function serveStatic(req, res, urlPath, baseDir, prefix) {
  const rel = urlPath.replace(prefix, "").split("?")[0];
  const safeRel = normalize(rel).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(baseDir, safeRel);
  if (!filePath.startsWith(baseDir)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const buf = await fsReadFile(filePath);
    const ct = MIME[extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": ct, "Cache-Control": "no-cache" });
    res.end(buf);
  } catch {
    res.writeHead(404).end("Not found");
  }
}

// The dashapp is one page whatever the URL says — the routes (/sleep,
// /library/notes/foo.md, "/" for home) are the app's own, resolved in the browser.
async function serveIndexHtml(res) {
  try {
    let html = (await fsReadFile(join(WEB_DIR, "index.html"))).toString();
    // Cache-bust /web/app.js and /web/styles.css with their mtime so iOS
    // PWAs (which keep WebKit's disk cache across force-quits) always
    // pick up new JS/CSS as soon as the file changes on disk.
    const versioned = await Promise.all(
      ["app.js", "styles.css"].map(async (f) => {
        const st = await fsStat(join(WEB_DIR, f)).catch(() => null);
        return [f, st ? Math.floor(st.mtimeMs).toString(36) : Date.now().toString(36)];
      })
    );
    for (const [f, v] of versioned) {
      html = html.replaceAll(`/web/${f}`, `/web/${f}?v=${v}`);
    }
    res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-store, must-revalidate" });
    res.end(html);
  } catch {
    res.writeHead(500).end("Dashapp not built");
  }
}

async function handleDashapp(req, res) {
  const url = req.url || "/";

  if (url === "/" || url === "/index.html") {
    await serveIndexHtml(res);
    return true;
  }

  if (url.startsWith("/web/")) {
    await serveStatic(req, res, url, WEB_DIR, "/web/");
    return true;
  }

  if (url.startsWith("/avatars/")) {
    await serveStatic(req, res, url, AVATARS_DIR, "/avatars/");
    return true;
  }

  if (url.startsWith("/telegram-images/")) {
    await serveStatic(req, res, url, TELEGRAM_IMAGES_DIR, "/telegram-images/");
    return true;
  }

  if (url === "/api/jobs") {
    const raw = await readJobsRaw();
    res.writeHead(200, { "Content-Type": MIME[".json"], "Cache-Control": "no-cache" });
    res.end(raw);
    return true;
  }

  if (url === "/api/system/jobs-config") {
    try {
      const data = await readSystemJobsConfig();
      res.writeHead(200, { "Content-Type": MIME[".json"], "Cache-Control": "no-cache" });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500, { "Content-Type": MIME[".json"] });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  // Images a markdown file references by relative path. Every one of them
  // resolves against dashbook/ — the viewer does that arithmetic before asking.
  if (url.startsWith("/api/dashbook/assets/")) {
    const rel = decodeURIComponent(url.replace("/api/dashbook/assets/", "").split("?")[0]);
    const safeRel = normalize(rel).replace(/^(\.\.[/\\])+/, "");
    const filePath = join(NOTEBOOK_DIR, safeRel);
    if (!filePath.startsWith(NOTEBOOK_DIR)) {
      res.writeHead(403).end();
      return true;
    }
    const ext = extname(filePath).toLowerCase();
    if (!NOTE_ASSET_EXTS.has(ext)) {
      res.writeHead(404).end();
      return true;
    }
    try {
      const buf = await fsReadFile(filePath);
      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Cache-Control": "public, max-age=2592000, immutable",
      });
      res.end(buf);
    } catch {
      res.writeHead(404).end();
    }
    return true;
  }

  if (url === "/api/library/items") {
    const tree = await listLibrary();
    res.writeHead(200, { "Content-Type": MIME[".json"], "Cache-Control": "no-cache" });
    res.end(JSON.stringify({ tree }));
    return true;
  }

  if (url === "/api/library/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");
    listLibrary().then((tree) => sseSend(res, "items", { tree }));
    libraryClients.add(res);
    req.on("close", () => libraryClients.delete(res));
    return true;
  }

  // One endpoint for everything the Library shows: text comes back as text for
  // the viewer to render, images and PDFs as themselves for <img> and pdf.js.
  if (url.startsWith("/api/library/file/")) {
    const rel = decodeURIComponent(url.replace("/api/library/file/", "").split("?")[0]);
    const filePath = libraryItemPath(rel);
    if (!filePath) {
      res.writeHead(400).end("Invalid path");
      return true;
    }
    try {
      const buf = await fsReadFile(filePath);
      res.writeHead(200, {
        "Content-Type": MIME[extname(filePath).toLowerCase()] || "application/octet-stream",
        // Text is edited in place and re-pushed over the stream, so it can
        // never come from cache. A binary only changes by being replaced.
        "Cache-Control": isLibraryTextPath(rel) ? "no-cache" : "public, max-age=300",
      });
      res.end(buf);
    } catch {
      res.writeHead(404).end("Not found");
    }
    return true;
  }

  if (url === "/api/food-logs") {
    try {
      const data = await readLogsWithTotals();
      res.writeHead(200, { "Content-Type": MIME[".json"], "Cache-Control": "no-cache" });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500, { "Content-Type": MIME[".json"] }).end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  if (url === "/api/groups") {
    try {
      const data = await readGroupsWithTotals();
      res.writeHead(200, { "Content-Type": MIME[".json"], "Cache-Control": "no-cache" });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500, { "Content-Type": MIME[".json"] }).end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  // How many logged entries point at a food. The food editor asks before
  // redefining a serving, so it needs the count the moment Save is pressed —
  // the Nutrition tab doesn't otherwise hold the groups or days that use it.
  if (url.startsWith("/api/nutrition/references")) {
    try {
      const item = new URL(url, "http://localhost").searchParams.get("item") || "";
      res.writeHead(200, { "Content-Type": MIME[".json"], "Cache-Control": "no-cache" });
      res.end(JSON.stringify({ count: await countFoodReferences(item) }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": MIME[".json"] }).end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  if (url === "/api/nutrition") {
    try {
      const content = await fsReadFile(NUTRITION_FILE, "utf-8");
      // Which rows are the daily target and its floor and ceiling — all three
      // renameable, so the dashapp can't know them from constants. Headers
      // rather than a wrapper object: the body is the CSV itself and the tab
      // parses it as text.
      const targets = await readTargetsConfig();
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Targets-Item": encodeURIComponent(targets.item),
        "X-Targets-Min": encodeURIComponent(targets.min),
        "X-Targets-Max": encodeURIComponent(targets.max),
      });
      res.end(content);
    } catch {
      res.writeHead(404).end("Not found");
    }
    return true;
  }

  if (url === "/api/finances" || url.startsWith("/api/finances?")) {
    try {
      const files = await fsReaddir(PNC_REPORTS_DIR);
      const csvFiles = files.filter(f => f.startsWith("pnc-") && f.endsWith(".csv")).sort().reverse();
      const months = [];
      for (const file of csvFiles) {
        const raw = await fsReadFile(join(PNC_REPORTS_DIR, file), "utf8");
        const lines = raw.trim().split("\n").slice(1);
        const incomeItems = new Map();  // merchant -> total
        const expenseItems = new Map();
        let totalIncome = 0, totalExpenses = 0;
        let minDate = null, maxDate = null;
        for (const line of lines) {
          const [date, , , name, merchant, amountRaw, category, , , exclude] = line.split(",");
          if (!date) continue;
          const amount = parseFloat(amountRaw.replace(/−/g, "-"));
          if (isNaN(amount)) continue;
          if (!minDate || date < minDate) minDate = date;
          if (!maxDate || date > maxDate) maxDate = date;
          if (exclude === "true") continue;
          const label = merchant || name || "(unknown)";
          if (amount < 0 && category === "INCOME") {
            const abs = Math.abs(amount);
            incomeItems.set(label, (incomeItems.get(label) || 0) + abs);
            totalIncome += abs;
          } else if (amount > 0) {
            expenseItems.set(label, (expenseItems.get(label) || 0) + amount);
            totalExpenses += amount;
          }
        }
        // Sort each group by amount descending
        const sortMap = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([name, total]) => ({ name, total: Math.round(total * 100) / 100 }));
        // Extract month label from filename (pnc-2026.04.csv)
        const match = file.match(/pnc-(\d{4})\.(\d{2})/);
        const label = match ? new Date(+match[1], +match[2] - 1).toLocaleDateString([], { month: "long", year: "numeric" }) : file;
        months.push({
          label,
          dateRange: minDate && maxDate ? `${minDate} – ${maxDate}` : "",
          income: sortMap(incomeItems),
          expenses: sortMap(expenseItems),
          totalIncome: Math.round(totalIncome * 100) / 100,
          totalExpenses: Math.round(totalExpenses * 100) / 100,
          net: Math.round((totalIncome - totalExpenses) * 100) / 100,
        });
      }
      res.writeHead(200, { "Content-Type": MIME[".json"], "Cache-Control": "no-cache" });
      res.end(JSON.stringify({ months }));
    } catch (err) {
      res.writeHead(502, { "Content-Type": MIME[".json"] });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  if (url === "/api/jobs/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");
    // Send current state immediately
    readJobsRaw().then((raw) => {
      res.write(`event: update\ndata: ${raw.replace(/\n/g, "")}\n\n`);
    });
    jobsClients.add(res);
    req.on("close", () => jobsClients.delete(res));
    return true;
  }

  // Anything left that a browser is asking for as a page is a dashapp route —
  // /sleep, /library/notes/some/file.md — so hand back the app and let its router read
  // the path. Matching on Accept rather than on the shape of the path is what
  // lets a route carry a filename (/library/notes/foo.md) without being mistaken for a
  // missing static file. Sub-resource requests and unknown /api/ paths don't
  // ask for HTML, so they still 404.
  if (!url.startsWith("/api/") && (req.headers.accept || "").includes("text/html")) {
    await serveIndexHtml(res);
    return true;
  }

  return false;
}

createServer(async (req, res) => {
  if (!isAuthorizedRequest(req)) {
    console.warn(`🚫 Rejected ${req.method} ${req.url} from ${req.socket.remoteAddress}`);
    res.writeHead(401, { "Content-Type": "text/plain" }).end("Unauthorized");
    return;
  }

  // Dashapp (GET) routes are handled first
  if (req.method === "GET") {
    const handled = await handleDashapp(req, res);
    if (handled) return;
    res.writeHead(404).end();
    return;
  }

  const isPhoneVoice = req.method === "POST" && req.url.startsWith("/phone-voice");
  const isRoomVoice = req.method === "POST" && req.url.startsWith("/room-voice");
  // Legacy /voice endpoint support
  const isLegacyVoice = req.method === "POST" && req.url.startsWith("/voice") && !isPhoneVoice && !isRoomVoice;
  const isDashMessage = req.method === "POST" && req.url === "/api/dash-message";
  const isDashChat = req.method === "POST" && req.url === "/api/dash-chat";
  const isTelegramMessage = req.method === "POST" && req.url === "/api/telegram-message";
  const isCreateJob = req.method === "POST" && req.url === "/api/jobs/create";
  const isDeleteJob = req.method === "POST" && req.url === "/api/jobs/delete";
  const isToggleJob = req.method === "POST" && req.url === "/api/jobs/toggle";
  const isUpdateJobPrompt = req.method === "POST" && req.url === "/api/jobs/update-prompt";
  const isUpdateJob = req.method === "POST" && req.url === "/api/jobs/update";
  const isSaveSystemJobsConfig = req.method === "POST" && req.url === "/api/system/jobs-config";
  const isRestartSystem = req.method === "POST" && req.url === "/api/system/restart";
  const isSaveLibrary = req.method === "POST" && req.url === "/api/library/save";
  const isLibraryAssist = req.method === "POST" && req.url === "/api/library/assist";
  const isNutritionLookup = req.method === "POST" && req.url === "/api/nutrition/lookup";
  const isNutritionAssist = req.method === "POST" && req.url === "/api/nutrition/assist";
  const isNutritionAdd = req.method === "POST" && req.url === "/api/nutrition/add";
  const isNutritionDelete = req.method === "POST" && req.url === "/api/nutrition/delete";
  const isGroupSave = req.method === "POST" && req.url === "/api/groups/save";
  const isLogAssist = req.method === "POST" && req.url === "/api/food-logs/assist";
  const isLogSave = req.method === "POST" && req.url === "/api/food-logs/save";
  const isLogDelete = req.method === "POST" && req.url === "/api/food-logs/delete";
  const isGroupDelete = req.method === "POST" && req.url === "/api/groups/delete";

  if (isSaveSystemJobsConfig) {
    try {
      const parsed = await readJsonRequest(req);
      const config = parsed?.config || parsed;
      const saved = await writeSystemJobsConfig(config);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, ...saved }));
    } catch (err) {
      const status = err.message === "Invalid JSON" || err.message.includes("Config must") ? 400 : 500;
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (isRestartSystem) {
    res.writeHead(202, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, command: "npm run pm2:restart" }));
    setTimeout(() => {
      exec("npm run pm2:restart", { cwd: __dirname }, (err, stdout, stderr) => {
        if (err) {
          console.error("System restart failed:", err.message);
          if (stderr) console.error(stderr.trim());
          return;
        }
        if (stdout) console.log(stdout.trim());
        if (stderr) console.warn(stderr.trim());
      });
    }, 250);
    return;
  }

  if (isCreateJob) {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }
      const { prompt, type, time } = parsed || {};
      if (!prompt || !type || !time) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Missing prompt, type, or time" }));
        return;
      }
      try {
        const { randomUUID } = await import("node:crypto");
        const config = await readJobsConfig();
        const job = {
          id: randomUUID().slice(0, 8),
          type,
          prompt: prompt.trim(),
          time,
          ...(parsed.date && { date: parsed.date }),
          ...(parsed.days && parsed.days.length > 0 && { days: parsed.days }),
          ...(parsed.day_of_month != null && { day_of_month: parsed.day_of_month }),
          createdAt: new Date().toISOString(),
        };
        config.jobs.push(job);
        await writeJobsConfig(config);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ success: true, job }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (isDeleteJob) {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }
      const { id } = parsed || {};
      if (!id) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Missing id" }));
        return;
      }
      try {
        const config = await readJobsConfig();
        const before = config.jobs.length;
        config.jobs = config.jobs.filter((j) => j.id !== id);
        if (config.jobs.length === before) {
          res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Job not found" }));
          return;
        }
        await writeJobsConfig(config);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ success: true, removed: id }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (isToggleJob) {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }
      const { id, enabled } = parsed || {};
      if (!id || typeof enabled !== "boolean") {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Missing id or enabled" }));
        return;
      }
      try {
        const config = await readJobsConfig();
        const job = config.jobs.find((j) => j.id === id);
        if (!job) {
          res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Job not found" }));
          return;
        }
        job.enabled = enabled;
        await writeJobsConfig(config);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ success: true, id, enabled }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (isUpdateJobPrompt) {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }
      const { id, prompt } = parsed || {};
      if (!id || typeof prompt !== "string" || !prompt.trim()) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Missing id or prompt" }));
        return;
      }
      try {
        const config = await readJobsConfig();
        const job = config.jobs.find((j) => j.id === id);
        if (!job) {
          res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Job not found" }));
          return;
        }
        job.prompt = prompt.trim();
        await writeJobsConfig(config);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ success: true, id, prompt: job.prompt }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (isUpdateJob) {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }
      const { id, ...fields } = parsed || {};
      if (!id) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Missing id" }));
        return;
      }
      const ALLOWED = ["prompt", "time", "type", "days", "date", "day_of_month", "enabled", "title"];
      try {
        const config = await readJobsConfig();
        const job = config.jobs.find((j) => j.id === id);
        if (!job) {
          res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Job not found" }));
          return;
        }
        for (const key of Object.keys(fields)) {
          if (ALLOWED.includes(key)) job[key] = fields[key];
        }
        await writeJobsConfig(config);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ success: true, job }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Nutrition: look up a food from text and/or photos of it. Returns the proposed
  // row for review — the write happens in /api/nutrition/add after Steve confirms.
  if (isNutritionLookup) {
    // Photos push well past readJsonRequest's 1 MB cap.
    let body = "";
    let tooBig = false;
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 24_000_000 && !tooBig) { tooBig = true; req.destroy(); }
    });
    req.on("end", async () => {
      if (tooBig) return;
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }
      // `image` is the old single-photo shape; `images` is the current one.
      const { text = "", image = "", images = [] } = parsed || {};
      const photos = [image, ...(Array.isArray(images) ? images : [])].filter(Boolean).slice(0, MAX_LOOKUP_PHOTOS);
      if (!String(text).trim() && !photos.length) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Provide a description, a photo, or both" }));
        return;
      }
      const imagePaths = [];
      try {
        for (const photo of photos) imagePaths.push(await writeTempImage(photo));
        const result = await lookupFood({ description: String(text), imagePaths });
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
      } catch (err) {
        console.error(`   ⚠️  nutrition lookup failed: ${err.message}`);
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: err.message }));
      } finally {
        for (const p of imagePaths) await removeTempImage(p);
      }
    });
    req.on("error", () => {
      if (!res.headersSent) res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Request too large" }));
    });
    return;
  }

  // Nutrition: the food tab's general AI helper — a question about the table
  // rather than a lookup of one food. Answers in prose, and when Steve asked for
  // a change it also returns proposed rows (usually the daily target/min/max).
  // Like the lookup, it writes nothing: proposals go through /api/nutrition/add.
  if (isNutritionAssist) {
    handleAssistRequest(req, res, "nutrition assist", ({ text, imagePaths, signal }) =>
      nutritionAssist({ question: text, imagePaths, signal }),
    );
    return;
  }

  // Library: the same helper over whatever file the browser has open. The file
  // is read here rather than posted, so the model works from what's on disk;
  // an open image is handed over as an image. Writes nothing — a proposed file
  // comes back for review and is saved through /api/library/save.
  if (isLibraryAssist) {
    handleAssistRequest(req, res, "library assist", async ({ text, imagePaths, parsed, signal }) => {
      const relPath = String(parsed?.path || "");
      if (!relPath) {
        return libraryAssist({ question: text, imagePaths, listing: await libraryListing(), signal });
      }
      const filePath = libraryItemPath(relPath);
      if (!filePath) throw new Error("Invalid path");
      const ext = extname(relPath).toLowerCase();
      if (isLibraryTextPath(relPath)) {
        let content = "";
        try {
          content = await fsReadFile(filePath, "utf-8");
        } catch (err) {
          if (err.code !== "ENOENT") throw err; // no file yet is an empty one
        }
        return libraryAssist({ question: text, imagePaths, file: relPath, content, kind: "text", signal });
      }
      return libraryAssist({
        question: text,
        imagePaths,
        file: relPath,
        kind: LIBRARY_VIEWABLE_IMAGE_EXTS.has(ext) ? "image" : ext === ".pdf" ? "PDF" : "file",
        // Never pushed onto imagePaths: handleAssistRequest deletes every path
        // in that array once the run is done, and this one is Steve's own file.
        openImagePath: LIBRARY_VIEWABLE_IMAGE_EXTS.has(ext) ? filePath : "",
        signal,
      });
    });
    return;
  }

  // Meal log: the same helper over the logged days — review the day on
  // screen against the daily target, edit it, or build a new one from the foods
  // in raw.csv. Proposed logs are applied through /api/food-logs/save.
  if (isLogAssist) {
    handleAssistRequest(req, res, "food log assist", ({ text, imagePaths, parsed, signal }) =>
      logAssist({ question: text, imagePaths, logId: String(parsed?.logId || ""), signal }),
    );
    return;
  }

  // Nutrition: commit a reviewed food to the CSV. The record is re-normalized
  // server-side so the file stays well-formed regardless of what the client sends.
  if (isNutritionAdd) {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }
      // `replaceItem` is the row being replaced, when that isn't the name the
      // record now carries — i.e. a rename. `rescale` is the factor the row's
      // serving moved by, when redefining it has to take the entries that
      // reference it along — see rescaleFoodReferences.
      const { food, replace = false, replaceItem = "", rescale = 1 } = parsed || {};
      if (!food || typeof food !== "object") {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Missing food" }));
        return;
      }
      try {
        const { header } = await readNutritionTable();
        // Which of the three daily rows this is, if it is one — needed before
        // the write (blanks are kept only there) and again after it (a rename
        // has to take the pointer along).
        const targets = await readTargetsConfig();
        const role = replace && replaceItem
          ? Object.keys(targets).find((r) => targets[r].toLowerCase() === replaceItem.toLowerCase())
          : undefined;
        const record = buildFoodRecord(header, food, { allowBlank: Boolean(role) });
        const line = replace ? await replaceFoodRow(record, replaceItem) : await appendFoodRow(record);
        const name = record[header[0].trim()];
        let rescaled = 0;
        let renamed = 0;
        // Renaming the target, min or max row moves its pointer with it —
        // nothing else identifies those rows, so leaving a pointer behind would
        // unpin one.
        if (replace && replaceItem) {
          if (role) await writeTargetsItem(name, role);
          // Rescale before the rename: both address entries by name, and after
          // a rename the old one no longer finds them.
          const factor = Number(rescale);
          if (Number.isFinite(factor) && factor > 0 && factor !== 1) {
            rescaled = await rescaleFoodReferences(replaceItem, factor);
          }
          renamed = await renameFoodReferences(replaceItem, name);
        }
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ success: true, item: name, line, rescaled, renamed }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (isNutritionDelete) {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }
      const { index, item } = parsed || {};
      try {
        const result = await deleteFoodRow({ index, item });
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ success: true, ...result }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (isLogSave) {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }
      try {
        const log = await saveLog(parsed || {});
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ success: true, log }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (isLogDelete) {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }
      const { id } = parsed || {};
      if (!id) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Missing id" }));
        return;
      }
      try {
        const result = await deleteLog(id);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ success: true, ...result }));
      } catch (err) {
        res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (isGroupSave) {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }
      try {
        const group = await saveGroup(parsed || {});
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ success: true, group }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (isGroupDelete) {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }
      const { id } = parsed || {};
      if (!id) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Missing id" }));
        return;
      }
      try {
        // Resolve before writing the head — writeHead runs before the argument
        // is evaluated, so awaiting inline would commit a 200 we can't take back.
        const result = await deleteGroup(id);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ success: true, ...result }));
      } catch (err) {
        res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }


  if (isSaveLibrary) {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }
      const { path: relPath, content } = parsed || {};
      if (!relPath || typeof content !== "string") {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Missing path or content" }));
        return;
      }
      const filePath = libraryItemPath(relPath);
      // Text is the only thing the viewer can edit, so it's the only thing
      // this writes — an image or a PDF arriving here is a bug, not a save.
      if (!filePath || !isLibraryTextPath(relPath)) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Invalid path" }));
        return;
      }
      if (relPath.toLowerCase().endsWith(".json")) {
        try { JSON.parse(content); }
        catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: `Invalid JSON: ${e.message}` }));
          return;
        }
      }
      try {
        await fsWriteFile(filePath, content, "utf-8");
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (isTelegramMessage) {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      let parsed;
      try { parsed = JSON.parse(body); }
      catch {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }
      const text = (parsed && parsed.text || "").trim();
      if (!text) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Missing text" }));
        return;
      }
      console.log(`📱 Dashapp→Telegram: "${text}"`);
      recordMessage("user", text);
      try {
        const response = await agent.chat(ALLOWED_USER_ID, text, undefined, { history: recentTurns("telegram") });
        await deliverMessage(response);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ response }));
      } catch (err) {
        console.error("Telegram-from-dashapp error:", err.message);
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (isDashMessage || isDashChat) {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }
      const text = (parsed && parsed.text || "").trim();
      const activeFile = parsed && typeof parsed.activeFile === "string" ? parsed.activeFile.trim() : "";
      const activeTab = parsed && typeof parsed.activeTab === "string" ? parsed.activeTab.trim() : "";
      if (!text) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Missing text" }));
        return;
      }
      const parts = [`[source: dashapp]`];
      if (activeTab) parts.push(`[active_tab: ${activeTab}]`);
      if (activeFile) parts.push(`[user is viewing ${activeFile} — if they ask to add/update/append without naming a file, target this one]`);
      const contextPrefix = parts.join(" ") + " ";
      console.log(`💬 Dashapp ${isDashChat ? "chat" : "message"}: "${text}"${activeTab ? ` (tab=${activeTab})` : ""}${activeFile ? ` (viewing ${activeFile})` : ""}`);
      try {
        // Chat messages stay in chat history only — never touch Telegram
        recordChat("user", text);
        const response = await agent.chat(ALLOWED_USER_ID, `${contextPrefix}${text}`, undefined, { history: recentTurns(isDashChat ? "chat" : "telegram") });
        recordChat("dash", response);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ response }));
      } catch (err) {
        console.error("Dashapp chat error:", err.message);
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (!isPhoneVoice && !isRoomVoice && !isLegacyVoice) {
    res.writeHead(404).end();
    return;
  }

  const sync = req.url.endsWith("/sync");

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    if (res.headersSent) return;

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400).end("Invalid JSON");
      return;
    }

    const { text, room, silent, tts_url: ttsUrl } = parsed;
    if (!text) { res.writeHead(200).end(""); return; }

    const cancelPhrases = /\b(forget (about )?it|cancel|don'?t worry about it|never ?mind|stop|disregard( that)?|ignore that|skip it)\s*\.?$/i;
    if (cancelPhrases.test(text.trim())) {
      console.log(`🎤 Voice command cancelled [${room}]: "${text}"`);
      res.writeHead(200).end("");
      return;
    }

    lastVoiceRoom = room;
    const voiceSource = isPhoneVoice ? "phone" : isRoomVoice ? "room" : (sync || ttsUrl) ? "phone" : "room";
    const config = _readConfig();
    const silentMode = config[`silent_${voiceSource}`] || silent;
    console.log(`🎤 Voice command [${voiceSource}/${room}]: "${text}"`);
    recordMessage("user", text);

    // In silent mode, always respond immediately — process async
    if (!sync || silentMode) res.writeHead(200).end(sync ? "" : "ok");

    try {
      const response = await agent.chat(ALLOWED_USER_ID, `[voice_source: ${voiceSource}] ${text}`, undefined, { history: recentTurns("telegram") });

      // Re-read config — the agent may have toggled silent mode during this request
      const updatedConfig = _readConfig();
      const nowSilent = updatedConfig[`silent_${voiceSource}`] || silent;

      const wantsMessage = /telegram|send me|message me|text me/i.test(text);

      // In silent mode or explicit message request, deliver to messages
      if (wantsMessage || nowSilent) {
        await deliverMessage(response);
      }

      if (sync && !res.headersSent) {
        if (nowSilent || wantsMessage) {
          // Silent was toggled on during this request — close the connection
          res.writeHead(200, { "Content-Type": "text/plain" }).end("");
        } else {
          const ttsText = await _getTtsText(response);
          res.writeHead(200, { "Content-Type": "text/plain" }).end(ttsText);
        }
      } else if (!nowSilent && !silent && !wantsMessage) {
        _getTtsText(response).then((t) => _speak(t, room, ttsUrl)).catch((err) => console.error("TTS error:", err.message));
      }
    } catch (err) {
      console.error("Voice endpoint error:", err.message);
      const errConfig = _readConfig();
      const errSilent = errConfig[`silent_${voiceSource}`] || silent;
      if (sync && !res.headersSent) {
        res.writeHead(errSilent ? 200 : 500).end(errSilent ? "" : "Something went wrong. Check messages.");
      } else if (!errSilent) {
        _speak("Sorry, something went wrong. Check messages for details.", room, ttsUrl);
      }
      deliverMessage(`⚠️ Voice command failed\n\nCommand: "${text}"\nError: ${err.message}`)
        .catch(() => {});
    }
  });
}).listen(VOICE_PORT, "0.0.0.0", () => {
  console.log(`   🎤 Voice endpoint listening on 0.0.0.0:${VOICE_PORT}`);
});

agent.startBackgroundTasks({ userId: ALLOWED_USER_ID, bot, deliver: deliverMessage }).catch((err) => {
  console.error("  ❌ Failed to start background tasks:", err.message);
});

// Retry Telegram connection in case network isn't ready after reboot
async function launchBot() {
  for (let attempt = 1; ; attempt++) {
    try {
      bot.botInfo = await bot.telegram.getMe();
      console.log("   ✅ Bot is running! Send a message on Telegram to get started.");
      await bot.telegram.deleteWebhook({ drop_pending_updates: true });
      bot.startPolling();
      return;
    } catch (err) {
      if (attempt >= 10) {
        console.error(`   ❌ Telegram launch failed after ${attempt} attempts: ${err.message}`);
        process.exit(1);
      }
      console.error(`   ⚠️ Telegram launch attempt ${attempt} failed (${err.message}), retrying in 5s...`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
if (TELEGRAM_ENABLED) {
  launchBot();
} else {
  console.log("   📱 Telegram disabled — dashapp is primary interface");
}
