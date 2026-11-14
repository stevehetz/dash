/**
 * Nutrition table — the food reference CSV behind the dashapp's Nutrition tab.
 *
 * The CSV is the "raw" tab of nutrition.xlsm exported to
 * dashbook/nutrition/raw.csv. Column order there is authoritative: this module
 * always reads the header off the file rather than hardcoding it, so adding a
 * nutrient column in Excel doesn't require a code change.
 *
 * Lookups go through the LLM (with web_search/web_fetch when the backend is
 * codex-p, so it can cross-check real sources rather than guessing from memory).
 * The model only ever returns JSON — this module owns the CSV formatting, so a
 * malformed model response can't corrupt the file.
 */
import { readFile, appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { codexP } from "./llm/codex-p.js";

export const NUTRITION_FILE = `${process.env.ONEDRIVE_PATH}/dashbook/nutrition/raw.csv`;
export const GROUPS_FILE = `${process.env.ONEDRIVE_PATH}/dashbook/nutrition/groups.json`;
export const FOOD_LOGS_FILE = `${process.env.ONEDRIVE_PATH}/dashbook/nutrition/food-logs.json`;
// Where the logs lived before the rename. Read as a fallback so a bot that
// starts before the first save still finds them; the next write lands on
// FOOD_LOGS_FILE and the old file stops being consulted. Delete both this and
// the fallback branch in readLogs once food-logs.json is on disk.
export const LEGACY_MENUS_FILE = `${process.env.ONEDRIVE_PATH}/dashbook/nutrition/menus.json`;

const IDENTITY_COLS = ["Item", "Serving Size", "Serving Unit", "Servings"];

// raw.csv keeps Steve's daily goals as ordinary rows (one column per nutrient,
// serving size "1 day"), so the targets travel with the table instead of being
// duplicated in code. This is the one the dashapp's Log tab compares against.
//
// Only the name tells it apart — "1 day" doesn't, there are other daily rows
// alongside it — so the name is renameable and the current one is kept here
// rather than being hard-coded. The constant is the starting value and the
// fallback when the pointer hasn't been written yet.
export const TARGETS_ITEM = "Daily Nutrition Target";
// The floor and the ceiling for the same day, kept the same way: three ordinary
// rows, three pointers. The target is what a day aims at; min is what it mustn't
// fall below and max what it mustn't go past.
export const TARGETS_MIN_ITEM = "Daily Nutrition Min";
export const TARGETS_MAX_ITEM = "Daily Nutrition Max";
const TARGETS_POINTER = `${process.env.ONEDRIVE_PATH}/dashbook/nutrition/targets.json`;
// The pointer file's keys, and the name each falls back to.
const TARGET_ROLES = { item: TARGETS_ITEM, min: TARGETS_MIN_ITEM, max: TARGETS_MAX_ITEM };

/** Which rows are the target, min and max rows right now, by role. */
export async function readTargetsConfig() {
  let saved = {};
  try { saved = JSON.parse(await readFile(TARGETS_POINTER, "utf-8")) || {}; } catch {}
  return Object.fromEntries(
    Object.entries(TARGET_ROLES).map(([role, fallback]) => {
      const name = saved[role];
      return [role, typeof name === "string" && name.trim() ? name.trim() : fallback];
    }),
  );
}

/** Which row is the targets row right now. */
export async function readTargetsItem() {
  return (await readTargetsConfig()).item;
}

/**
 * Move one pointer, leaving the other two where they are — a rename touches one
 * row, and rewriting the file from scratch would drop the names beside it.
 */
export async function writeTargetsItem(item, role = "item") {
  if (!(role in TARGET_ROLES)) throw new Error(`Unknown targets role: ${role}`);
  const config = { ...(await readTargetsConfig()), [role]: String(item).trim() };
  await writeFile(TARGETS_POINTER, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

/** Minimal CSV line splitter — the file is written without quoting (see below). */
function splitCsvLine(line) {
  const out = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { out.push(field); field = ""; }
    else field += c;
  }
  out.push(field);
  return out;
}

/** Read the CSV and return its header plus existing item names. */
export async function readNutritionTable() {
  const text = await readFile(NUTRITION_FILE, "utf-8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const header = splitCsvLine(lines[0]);
  const items = lines.slice(1).map((l) => splitCsvLine(l)[0].trim()).filter(Boolean);
  return { text, header, items };
}

/**
 * Steve's naming rules, applied server-side so they hold no matter what the
 * model returns:
 *   - no parenthetical asides in the item name
 *   - no quotes anywhere (the file is written unquoted)
 *   - serving unit is the bare unit — never "raw", "cooked", "chopped"
 *   - servings is always 1; the amount lives in Serving Size
 */
export function normalizeItemName(raw) {
  return String(raw || "")
    .replace(/\([^)]*\)/g, " ")   // drop parentheticals
    .replace(/["']/g, "")          // drop quotes
    .replace(/,/g, " ")            // a comma would break the unquoted row
    .replace(/\s+/g, " ")
    .trim();
}

const UNIT_WORDS = new Set([
  "g", "kg", "mg", "mcg", "oz", "lb", "lbs", "ml", "l", "cup", "cups", "tbsp", "tsp",
  "slice", "slices", "piece", "pieces", "serving", "servings", "scoop", "scoops",
  "each", "clove", "cloves", "egg", "eggs", "fl oz", "can", "bar", "packet", "container",
]);

export function normalizeUnit(raw) {
  let u = String(raw || "")
    .replace(/["']/g, "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/,/g, " ")
    .trim()
    .toLowerCase();
  if (!u) return "";
  // "oz raw", "cup chopped" → keep only the leading unit token(s).
  if (u.startsWith("fl oz")) return "fl oz";
  const first = u.split(/\s+/)[0];
  return UNIT_WORDS.has(first) ? first : first;
}

function toNumber(v) {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[^0-9.eE+-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** Trim float noise so the CSV keeps the same shape as the Excel export. */
function fmtCsvNumber(n) {
  if (!Number.isFinite(n) || n === 0) return "0";
  const abs = Math.abs(n);
  const rounded = abs >= 100 ? Math.round(n) : abs >= 10 ? Math.round(n * 10) / 10 : parseFloat(n.toPrecision(3));
  return String(rounded);
}

/**
 * Build a CSV-ready record in the file's own column order.
 * Everything not supplied becomes 0 — never blank (Steve's rule).
 *
 * `allowBlank` is for the three daily rows only, where a blank nutrient means
 * there's no figure for it at all — a distinction a food doesn't need, and the
 * one the dashapp draws as a dash instead of a 0.
 */
export function buildFoodRecord(header, food, { allowBlank = false } = {}) {
  const byLower = new Map(Object.entries(food || {}).map(([k, v]) => [k.trim().toLowerCase(), v]));
  const pick = (col) => byLower.get(col.trim().toLowerCase());

  const name = normalizeItemName(pick("Item") ?? food?.name);
  if (!name) throw new Error("Food is missing an item name");

  const record = {};
  for (const col of header) {
    const key = col.trim();
    if (key.toLowerCase() === "item") record[key] = name;
    else if (key.toLowerCase() === "serving size") record[key] = fmtCsvNumber(toNumber(pick(key)) || 1);
    else if (key.toLowerCase() === "serving unit") record[key] = normalizeUnit(pick(key));
    else if (key.toLowerCase() === "servings") record[key] = "1"; // always 1
    else if (allowBlank && String(pick(key) ?? "").trim() === "") record[key] = "";
    else record[key] = fmtCsvNumber(toNumber(pick(key)));
  }
  return record;
}

/** Append a record to the CSV, matching the file's existing line ending. */
export async function appendFoodRow(record) {
  const { text, header } = await readNutritionTable();
  const line = header.map((col) => record[col.trim()] ?? "0").join(",");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const prefix = text.endsWith("\n") || text.endsWith("\r\n") ? "" : eol;
  await appendFile(NUTRITION_FILE, `${prefix}${line}${eol}`, "utf-8");
  return line;
}

/**
 * Replace an existing row (case-insensitive item match).
 *
 * `match` is the name to find, which is only the record's own when the name
 * isn't changing — a rename has to look for the row it's leaving behind, or it
 * would find nothing and append a second one.
 */
export async function replaceFoodRow(record, match = "") {
  const { text, header } = await readNutritionTable();
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const line = header.map((col) => record[col.trim()] ?? "0").join(",");
  const target = String(match || record[header[0].trim()]).toLowerCase();
  const lines = text.split(/\r?\n/);
  let replaced = false;
  const out = lines.map((l, i) => {
    if (i === 0 || l.trim() === "" || replaced) return l;
    if (splitCsvLine(l)[0].trim().toLowerCase() === target) { replaced = true; return line; }
    return l;
  });
  if (!replaced) return appendFoodRow(record);
  await writeFile(NUTRITION_FILE, out.join(eol), "utf-8");
  return line;
}

function buildLookupPrompt(header, description, imageCount = 0) {
  const nutrientCols = header.filter((h) => !IDENTITY_COLS.includes(h.trim()));
  // Several photos are still ONE food — typically the front of a package plus
  // its nutrition panel — so say so, or the model proposes a row per image.
  const imageIntro =
    imageCount > 1
      ? `The ${imageCount} attached images all show the SAME single food item from different angles (e.g. the front of the package, the nutrition facts panel, the ingredients list, the food itself). Combine them into one entry — do not return multiple foods. Read any nutrition facts panel in the images directly — a label on the product is more authoritative than a database.\n`
      : imageCount === 1
        ? `The attached image shows the food (it may be a product package, a nutrition label, or the food itself). Read any nutrition facts panel in the image directly — a label on the product is more authoritative than a database.\n`
        : "";
  return `You are a nutrition data researcher. Find accurate nutrient values for one food item and return them as JSON.

${imageIntro}${description ? `Food described by Steve: ${description}\n` : ""}
RESEARCH
- Cross-check at least two independent sources (USDA FoodData Central, the manufacturer's own nutrition facts, Nutritionix, SELF NutritionData, Cronometer).
- Prefer the manufacturer's label for branded products; prefer USDA for whole foods.
- If sources disagree, use the most authoritative and note the discrepancy.
- Do NOT open a browser. Use web_search / web_fetch if available, otherwise rely on your own knowledge.

SERVING RULES (important)
- If Steve gave an amount (e.g. "3 oz of carrots"), Serving Size = 3, Serving Unit = oz, Servings = 1.
- If he gave no amount, use a typical serving.
- Serving Unit is the bare unit only — "oz", "g", "cup". Never "oz raw" or "cup chopped".
- Servings is ALWAYS 1.
- Item name: no parentheses, no quotes, no commas. "Carrots" not "Carrots (raw, chopped)".
- All nutrient values are the amount in the WHOLE serving described, not per 100 g.
- Use 0 for anything you cannot find. Never leave a value blank or null.

OUTPUT
Return ONLY a JSON object — no markdown fence, no commentary — with exactly these keys:
{
  "Item": string,
  "Serving Size": number,
  "Serving Unit": string,
  "Servings": 1,
${nutrientCols.map((c) => `  ${JSON.stringify(c)}: number`).join(",\n")},
  "sources": [string],
  "notes": string
}
"sources" lists the sources you actually used. "notes" is one short sentence on confidence or any discrepancy (empty string if none).`;
}

function parseJsonResponse(text) {
  let s = String(text || "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Model did not return a JSON object");
  }
  return JSON.parse(s.slice(start, end + 1));
}

/**
 * Look up a food's nutrients from a text description and/or a photo.
 * Returns the normalized record plus the model's sources/notes — this does NOT
 * write to the CSV; the caller confirms first.
 *
 * @param {object} opts
 * @param {string} [opts.description]   Free text, e.g. "3 oz of carrots".
 * @param {string} [opts.imagePath]     Local path to a photo of the food/label.
 * @param {string[]} [opts.imagePaths]  Several photos of the same food (package
 *                                      front, nutrition panel, …). Merged with
 *                                      `imagePath` if both are given.
 */
export async function lookupFood({ description = "", imagePath = "", imagePaths = [] } = {}) {
  const paths = [imagePath, ...(Array.isArray(imagePaths) ? imagePaths : [])].filter(Boolean);
  if (!description.trim() && !paths.length) {
    throw new Error("Provide a description, a photo, or both");
  }
  const { header, items } = await readNutritionTable();
  const prompt = buildLookupPrompt(header, description.trim(), paths.length);

  let raw;
  // dashTools gives the model web_search / web_fetch — HTTP lookups, no browser.
  raw = await codexP(prompt, {
    dashTools: true,
    imagePaths: paths,
    timeoutMs: 4 * 60 * 1000,
    source: "nutrition-lookup",
  });

  const parsed = parseJsonResponse(raw);
  const record = buildFoodRecord(header, parsed);
  const duplicate = items.find((i) => i.toLowerCase() === record[header[0].trim()].toLowerCase());
  return {
    record,
    header,
    duplicate: duplicate || null,
    sources: Array.isArray(parsed.sources) ? parsed.sources.filter((s) => typeof s === "string") : [],
    notes: typeof parsed.notes === "string" ? parsed.notes : "",
  };
}

// ── AI helper ──────────────────────────────────────────
// The food tab's second panel: a free-form question about the table rather than
// a lookup of one food. It answers in prose, and when Steve asks for a change it
// also proposes rows — most often the daily target/min/max rows, researched from
// current guidance. Proposals are returned for review; nothing is written here.

/** How many rows one answer may propose changing. Keeps the review card sane. */
const MAX_ASSIST_PROPOSALS = 6;

/** Every row of the CSV keyed by lowercased item name, values as written. */
function recordsByName(text, header) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const byName = new Map();
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const name = cells[0].trim();
    if (!name || byName.has(name.toLowerCase())) continue;
    const values = {};
    header.forEach((h, i) => { values[h.trim()] = (cells[i] ?? "").trim(); });
    byName.set(name.toLowerCase(), { name, values });
  }
  return byName;
}

function buildAssistPrompt({ csv, targets, groups, logs, question, imageCount }) {
  // Names, not ids — the model is reading and writing item names, and ids mean
  // nothing to it. Quantities matter: they're what the totals are built from.
  const groupLines = groups
    .map((g) => `- ${g.name}: ${(g.items || []).map((i) => `${i.qty}× ${i.item}`).join(", ") || "(empty)"}`)
    .join("\n");
  const logLines = logs
    .map((m) => {
      const parts = (m.items || []).map((i) => {
        if (i.food) return `${i.qty}× ${i.food}`;
        if (i.custom) return `${i.qty}× ${i.name} [${(i.items || []).map((x) => `${x.qty}× ${x.item}`).join(", ")}]`;
        const g = groups.find((x) => x.id === i.group);
        return `${i.qty}× ${g ? g.name : i.group}`;
      });
      return `- ${m.name}: ${parts.join(", ") || "(empty)"}`;
    })
    .join("\n");

  const imageIntro = imageCount
    ? `Steve attached ${imageCount} image${imageCount === 1 ? "" : "s"} — read ${imageCount === 1 ? "it" : "them"} as part of his question (a lab result, a label, a chart, a screenshot of guidance).\n\n`
    : "";

  return `You are Steve's nutrition analyst. You have his complete food reference table and the groups and daily logs built from it. Answer his question, and — only if he asked for a change — propose the exact rows to write back.

${imageIntro}QUESTION FROM STEVE
${question || "(no text — work from the attached images)"}

THE DAILY ROWS
raw.csv keeps Steve's daily goals as ordinary rows, one column per nutrient:
- target (what a day aims at): "${targets.item}"
- minimum (what a day must not fall below): "${targets.min}"
- maximum (what a day must not exceed): "${targets.max}"
"Update my targets" means rewriting those rows.

FOOD TABLE (raw.csv, complete)
${csv.trim()}

GROUPS
${groupLines || "(none)"}

FOOD LOGS
${logLines || "(none)"}

HOW TO WORK
- Do the arithmetic against the table above rather than estimating. Cite the numbers you used.
- When the question needs outside facts (RDAs, upper limits, current research), research them: use web_search / web_fetch if available, otherwise say what your figures are based on. Do NOT open a browser.
- Steve's own context in the question — his weight, training, labs, goals — outranks a generic RDA. Say when you've deviated from a standard figure and why.
- Answer in full: name the foods, rows and figures you're talking about, not just the values. Skip the preamble and don't restate the question.

PROPOSING ROW CHANGES
Only propose rows when Steve asked for something to change. A question that just asks about the data gets an empty "proposals" list.
Each proposal is one COMPLETE row — every column, not just the ones you're changing — in the exact column names of the table above. Carry unchanged values through as they are.
- "item" must exactly match the existing row you're rewriting (e.g. "${targets.item}"), or be a new name if you genuinely mean to add a row.
- Servings is always 1. Serving Unit is a bare unit. Daily rows use serving size 1, unit "day".
- Every nutrient is a number — use 0 for anything you have no figure for, never blank or null.

OUTPUT
Return ONLY a JSON object — no markdown fence around the whole thing, no commentary outside it:
{
  "answer": string,        // markdown; tables and lists are fine
  "sources": [string],     // what you actually consulted, empty if none
  "proposals": [
    { "item": string, "reason": string, "row": { "Item": string, ...every column... } }
  ]
}`;
}

/**
 * Answer a free-form question about the nutrition table, optionally proposing
 * row rewrites (typically the daily target/min/max rows). Writes nothing — each
 * proposal comes back with a diff against the current row for review.
 *
 * @param {object} opts
 * @param {string}   [opts.question]   Steve's prompt.
 * @param {string[]} [opts.imagePaths] Local image files to include.
 * @param {AbortSignal} [opts.signal]  Cancel the run — kills the model process.
 */
export async function nutritionAssist({ question = "", imagePaths = [], signal } = {}) {
  const paths = (Array.isArray(imagePaths) ? imagePaths : []).filter(Boolean);
  if (!question.trim() && !paths.length) {
    throw new Error("Ask a question, attach a photo, or both");
  }
  const { text, header } = await readNutritionTable();
  const [targets, groups, logs] = await Promise.all([readTargetsConfig(), readGroups(), readLogs()]);
  const prompt = buildAssistPrompt({
    csv: text,
    targets,
    groups,
    logs,
    question: question.trim(),
    imageCount: paths.length,
  });

  let raw = await codexP(prompt, {
    dashTools: true,
    imagePaths: paths,
    timeoutMs: 5 * 60 * 1000,
    source: "nutrition-assist",
    signal,
  });

  const parsed = parseJsonResponse(raw);
  const itemCol = header[0].trim();
  const existing = recordsByName(text, header);

  // Each proposal is normalized through the same builder the food lookup uses,
  // so a sloppy model response can't produce a row the CSV wouldn't accept. The
  // diff is computed here rather than in the browser: the server is the one
  // holding the current file.
  const proposals = (Array.isArray(parsed.proposals) ? parsed.proposals : [])
    .slice(0, MAX_ASSIST_PROPOSALS)
    .map((p) => {
      const record = buildFoodRecord(header, p?.row ?? p?.record ?? p);
      // The row being rewritten is the one the model named, which is not the
      // record's own name when it's also renaming it.
      const named = normalizeItemName(p?.item ?? p?.match ?? record[itemCol]);
      const current = existing.get(named.toLowerCase()) || existing.get(record[itemCol].toLowerCase());
      const role = Object.keys(targets).find(
        (r) => current && targets[r].toLowerCase() === current.name.toLowerCase(),
      );
      const changes = header
        .map((h) => h.trim())
        .filter((col) => !current || String(current.values[col] ?? "") !== record[col])
        .map((col) => ({ col, from: current ? (current.values[col] ?? "") : null, to: record[col] }));
      return {
        item: record[itemCol],
        replaceItem: current ? current.name : "",
        exists: Boolean(current),
        role: role || null,
        reason: typeof p?.reason === "string" ? p.reason : "",
        record,
        changes,
      };
    })
    // A proposal that changes nothing is noise in the review card.
    .filter((p) => !p.exists || p.changes.length > 0);

  return {
    answer: typeof parsed.answer === "string" ? parsed.answer : String(parsed.answer ?? ""),
    sources: Array.isArray(parsed.sources) ? parsed.sources.filter((s) => typeof s === "string") : [],
    proposals,
    header,
  };
}

/** Write a base64 data URL to a temp file so it can be attached to the prompt. */
export async function writeTempImage(dataUrl) {
  const m = String(dataUrl || "").match(/^data:image\/(png|jpe?g|webp|gif|heic);base64,(.+)$/i);
  if (!m) throw new Error("Unsupported image format");
  const ext = m[1].toLowerCase() === "jpg" ? "jpeg" : m[1].toLowerCase();
  const path = join(tmpdir(), `dash-food-${randomUUID()}.${ext}`);
  await writeFile(path, Buffer.from(m[2], "base64"));
  return path;
}

export async function removeTempImage(path) {
  if (path) await unlink(path).catch(() => {});
}

// ── Groups ─────────────────────────────────────────────
// A group is a named list of foods with a quantity multiplier each. Only the
// food NAME and quantity are stored — totals are recomputed from raw.csv on
// read, so correcting a food's nutrients automatically corrects every group
// that uses it.

function slugId(name) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "group";
  return `${base}-${randomUUID().slice(0, 8)}`;
}

/** Read groups.json, tolerating a missing or empty file. */
export async function readGroups() {
  try {
    const raw = await readFile(GROUPS_FILE, "utf-8");
    const data = JSON.parse(raw);
    // `meals` is the pre-rename key — still read it so an un-migrated file works.
    const groups = Array.isArray(data) ? data : Array.isArray(data?.groups) ? data.groups : Array.isArray(data?.meals) ? data.meals : [];
    return groups.filter((m) => m && typeof m.name === "string");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function writeGroups(groups) {
  await writeFile(GROUPS_FILE, JSON.stringify({ groups }, null, 2) + "\n", "utf-8");
}

function normalizeGroupItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((it) => ({
      item: normalizeItemName(it?.item ?? it?.name),
      qty: (() => {
        const n = toNumber(it?.qty);
        return n > 0 ? n : 1;
      })(),
    }))
    .filter((it) => it.item);
}

/**
 * Create or update a group. An id that isn't already present is treated as a
 * create, so the endpoint is idempotent from the client's point of view.
 */
export async function saveGroup({ id, name, items, notes = "" }) {
  const cleanName = String(name || "").replace(/\s+/g, " ").trim();
  if (!cleanName) throw new Error("Group needs a name");
  const cleanItems = normalizeGroupItems(items);
  if (cleanItems.length === 0) throw new Error("Group needs at least one food");

  const groups = await readGroups();
  const now = new Date().toISOString();
  const idx = id ? groups.findIndex((m) => m.id === id) : -1;

  if (idx === -1) {
    const group = { id: id || slugId(cleanName), name: cleanName, notes: String(notes || ""), items: cleanItems, created: now, updated: now };
    groups.push(group);
    await writeGroups(groups);
    return group;
  }

  groups[idx] = { ...groups[idx], name: cleanName, notes: String(notes || ""), items: cleanItems, updated: now };
  await writeGroups(groups);
  return groups[idx];
}

export async function deleteGroup(id) {
  const groups = await readGroups();
  const next = groups.filter((m) => m.id !== id);
  if (next.length === groups.length) throw new Error("Group not found");
  await writeGroups(next);
  return { deleted: id };
}

/**
 * A list of `{ item, qty }` resolved against a name → food lookup: its totals,
 * the rows it resolved to, and the names it couldn't. Shared by groups and by
 * the ad-hoc groups a log carries inline, which are the same list under a
 * different owner.
 */
function resolveFoodItems(items, byName, nutrientCols) {
  const totals = Object.fromEntries(nutrientCols.map((c) => [c, 0]));
  const missing = [];
  const resolved = [];
  for (const it of items || []) {
    const food = byName.get(String(it.item).toLowerCase());
    if (!food) { missing.push(it.item); continue; }
    const qty = toNumber(it.qty) || 1;
    for (const c of nutrientCols) totals[c] += food.values[c] * qty;
    resolved.push({ item: food.name, qty, servingSize: food.servingSize, servingUnit: food.servingUnit });
  }
  for (const c of nutrientCols) totals[c] = Math.round(totals[c] * 1000) / 1000;
  return { totals, missing, resolved };
}

/**
 * Groups plus their computed nutrient totals, and the food table they resolve
 * against. Foods a group references that are no longer in the CSV come back in
 * `missing` rather than silently contributing zeros.
 */
export async function readGroupsWithTotals() {
  const text = await readFile(NUTRITION_FILE, "utf-8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const header = lines[0].split(",").map((h) => h.trim());
  const identity = new Set(IDENTITY_COLS.map((c) => c.toLowerCase()));
  const nutrientCols = header.filter((h) => !identity.has(h.toLowerCase()));

  // Groups reference foods by name, so a repeated name is ambiguous. Keep the
  // first occurrence (deterministic) and report the rest rather than silently
  // resolving to whichever row happened to be last.
  const foods = new Map();
  const duplicateFoods = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const name = cells[0].trim();
    if (!name) continue;
    if (foods.has(name.toLowerCase())) {
      if (!duplicateFoods.includes(name)) duplicateFoods.push(name);
      continue;
    }
    const values = {};
    header.forEach((h, i) => { values[h] = cells[i] ?? ""; });
    foods.set(name.toLowerCase(), {
      name,
      servingSize: values[header[1]] || "",
      servingUnit: values[header[2]] || "",
      values: Object.fromEntries(nutrientCols.map((c) => [c, toNumber(values[c])])),
      // The cells as written, so the daily rows below can tell a blank from a 0.
      cells: values,
    });
  }

  const groups = (await readGroups()).map((group) => {
    const { totals, missing, resolved } = resolveFoodItems(group.items, foods, nutrientCols);
    return { ...group, items: group.items || [], resolved, missing, totals };
  });

  // All three daily rows: what a day aims at, and the floor and ceiling either
  // side of it. Each is null when its row has been renamed or removed.
  //
  // A blank cell in one of them is null rather than 0: there is no figure for
  // that nutrient, which is not the same as a target of zero (trans fat's 0 is
  // a real ceiling). Foods keep the 0 — a food with no vitamin K has none, and
  // the totals add it up either way.
  const targetNames = await readTargetsConfig();
  const dailyRow = (role) => {
    const row = foods.get(targetNames[role].toLowerCase());
    if (!row) return null;
    const values = Object.fromEntries(
      nutrientCols.map((c) => [c, String(row.cells[c] ?? "").trim() === "" ? null : row.values[c]]),
    );
    return { name: row.name, values };
  };

  return {
    groups,
    nutrientCols,
    duplicateFoods,
    // null when the row has been renamed or removed — callers show totals only.
    targets: dailyRow("item"),
    targetsMin: dailyRow("min"),
    targetsMax: dailyRow("max"),
    foods: [...foods.values()].map((f) => ({ name: f.name, servingSize: f.servingSize, servingUnit: f.servingUnit, values: f.values })),
  };
}

/**
 * Delete a food row by its position among the data rows (0-based, header
 * excluded). Deleting by name alone is ambiguous — raw.csv can hold two rows
 * with the same item name — so the caller passes the index it saw and the name
 * it expected; a mismatch means the file changed underneath and we refuse
 * rather than delete the wrong food.
 */
export async function deleteFoodRow({ index, item }) {
  const idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0) throw new Error("Invalid row index");

  const text = await readFile(NUTRITION_FILE, "utf-8");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const trailingNewline = lines.length > 0 && lines[lines.length - 1] === "";
  const body = trailingNewline ? lines.slice(0, -1) : lines;

  const dataStarts = 1; // row 0 is the header
  const target = dataStarts + idx;
  if (target >= body.length) throw new Error("Row index out of range");

  const actual = splitCsvLine(body[target])[0].trim();
  const expected = String(item || "").trim();
  if (expected && actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`Row ${idx} is "${actual}", not "${expected}" — reload and try again`);
  }

  body.splice(target, 1);
  await writeFile(NUTRITION_FILE, body.join(eol) + (trailingNewline ? eol : ""), "utf-8");
  return { deleted: actual, remaining: body.length - 1 };
}

// ── Food logs ─────────────────────────────────────────
// A log is a full day, as a list of entries with a quantity each. An entry is
// one of three things, told apart by which key it carries:
//
//   { group, qty }              a saved group from groups.json, referenced by id
//                               rather than name so renaming it doesn't break
//                               the logs that use it.
//   { custom, name, items, qty } an ad-hoc group that belongs to this log
//                               alone: its own name and food list, kept here
//                               rather than in groups.json, so it never shows up
//                               on the Groups tab or in another day.
//   { food, qty }               a food eaten on its own, with no group around it.
//
// Totals cascade — foods → group totals → log totals — and are always
// recomputed from raw.csv, never stored.

export async function readLogs() {
  let raw;
  try {
    raw = await readFile(FOOD_LOGS_FILE, "utf-8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    // Pre-rename install: fall back to menus.json. Missing too means no logs
    // yet, which is a first run rather than a failure.
    try {
      raw = await readFile(LEGACY_MENUS_FILE, "utf-8");
    } catch (legacyErr) {
      if (legacyErr.code === "ENOENT") return [];
      throw legacyErr;
    }
  }
  const data = JSON.parse(raw);
  // `logs` is the current envelope; `menus` is what the old file wrote, and a
  // bare array is older still.
  const logs = Array.isArray(data) ? data : data?.logs || data?.menus || [];
  return (Array.isArray(logs) ? logs : []).filter((m) => m && typeof m.name === "string");
}

async function writeLogs(logs) {
  await writeFile(FOOD_LOGS_FILE, JSON.stringify({ logs }, null, 2) + "\n", "utf-8");
}

function normalizeLogItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((it) => {
      const n = toNumber(it?.qty);
      const qty = n > 0 ? n : 1;
      const food = normalizeItemName(it?.food);
      if (food) return { food, qty };
      if (it?.custom) {
        const name = String(it.name || "").replace(/\s+/g, " ").trim() || "Custom group";
        // Kept even while empty: one is created before its foods are picked, and
        // dropping it here would delete it out from under the row being filled.
        return { custom: String(it.custom).trim() || slugId(name), name, items: normalizeGroupItems(it.items), qty };
      }
      // `meal` is the pre-rename key — still accepted so old menus.json entries load.
      const group = String(it?.group ?? it?.meal ?? it?.id ?? "").trim();
      return group ? { group, qty } : null;
    })
    .filter(Boolean);
}

export async function saveLog({ id, name, items, notes = "" }) {
  const cleanName = String(name || "").replace(/\s+/g, " ").trim();
  if (!cleanName) throw new Error("Log needs a name");
  // An empty list is allowed, unlike a group's: a day is started from its name
  // and filled in from the table afterwards, so it exists before it has anything
  // in it — and emptying one out again is a state worth being able to save.
  const cleanItems = normalizeLogItems(items);

  const logs = await readLogs();
  const now = new Date().toISOString();
  const idx = id ? logs.findIndex((m) => m.id === id) : -1;

  if (idx === -1) {
    const log = { id: id || slugId(cleanName), name: cleanName, notes: String(notes || ""), items: cleanItems, created: now, updated: now };
    logs.push(log);
    await writeLogs(logs);
    return log;
  }

  logs[idx] = { ...logs[idx], name: cleanName, notes: String(notes || ""), items: cleanItems, updated: now };
  await writeLogs(logs);
  return logs[idx];
}

export async function deleteLog(id) {
  const logs = await readLogs();
  const next = logs.filter((m) => m.id !== id);
  if (next.length === logs.length) throw new Error("Log not found");
  await writeLogs(next);
  return { deleted: id };
}

// ── Food references ────────────────────────────────────
// Foods are referenced by name and quantity from three places: a group's item
// list, a day's item list (a food eaten on its own), and the item list of a
// day's ad-hoc group. Editing a food row can invalidate every one of them, so
// both sweeps below walk all three.

/**
 * Run `fn` over every reference to a food, in groups.json and food-logs.json. `fn`
 * gets the entry — `{ item, qty }` for a food inside a group, `{ food, qty }`
 * for one eaten on its own — and mutates it in place; returning true counts it
 * as changed. Nothing is written unless something did change.
 */
async function walkFoodReferences(name, fn) {
  const target = String(name || "").trim().toLowerCase();
  if (!target) return 0;
  let changed = 0;

  const hitItems = (items) => {
    for (const it of items || []) {
      if (String(it?.item || "").trim().toLowerCase() !== target) continue;
      if (fn(it)) changed++;
    }
  };

  const groups = await readGroups();
  for (const group of groups) hitItems(group.items);
  const groupHits = changed;
  if (groupHits) await writeGroups(groups);

  const logs = await readLogs();
  for (const log of logs) {
    for (const entry of log.items || []) {
      // A food eaten on its own carries the name under `food`, not `item`.
      if (entry?.food) {
        if (String(entry.food).trim().toLowerCase() === target && fn(entry)) changed++;
        continue;
      }
      hitItems(entry?.items);
    }
  }
  if (changed > groupHits) await writeLogs(logs);

  return changed;
}

/** How many entries point at a food — what the save dialog counts. */
export async function countFoodReferences(name) {
  let n = 0;
  await walkFoodReferences(name, () => { n++; return false; });
  return n;
}

/**
 * Multiply every logged quantity of a food by `factor`.
 *
 * Quantities are stored as a multiple of the food's serving, never as an
 * amount — so when a food's serving is redefined (8 oz → 1 bag), every entry
 * silently comes to mean something else. Rescaling by the same factor the
 * serving moved by keeps each entry at the amount it was logged as. The caller
 * works out the factor: see foodRebaseFactor in the dashapp.
 */
export async function rescaleFoodReferences(name, factor) {
  const f = Number(factor);
  if (!Number.isFinite(f) || f <= 0) throw new Error("Rescale factor must be a positive number");
  if (f === 1) return 0;
  return walkFoodReferences(name, (entry) => {
    const qty = toNumber(entry.qty) || 1;
    // Same 4dp the amount boxes round to, so a rescaled row still reads as
    // something you could have typed.
    const next = Math.round(qty * f * 10000) / 10000;
    if (next <= 0 || next === qty) return false;
    entry.qty = next;
    return true;
  });
}

/**
 * Point every reference at a food's new name. Groups and days resolve foods by
 * name, so without this a rename drops each entry out of its totals and leaves
 * it reading "not in the food table".
 */
export async function renameFoodReferences(from, to) {
  const next = normalizeItemName(to);
  if (!next || next.toLowerCase() === String(from || "").trim().toLowerCase()) return 0;
  return walkFoodReferences(from, (entry) => {
    if (entry.food) entry.food = next;
    else entry.item = next;
    return true;
  });
}

/**
 * Logs with totals summed from their groups, plus the groups they can draw
 * from. A group that has since been deleted is reported in `missing` rather
 * than quietly contributing nothing.
 *
 * The food table rides along too: a log expands three levels deep — day, group,
 * food — and the food rows need per-serving values to scale, which only the
 * table has.
 */
/**
 * Expand one day's list into resolved rows and summed totals. Split out of
 * readLogsWithTotals so a list that isn't saved anywhere — an AI proposal —
 * can be costed by exactly the same arithmetic the saved days are.
 */
function resolveLogItems(items, { byId, foodByName, nutrientCols }) {
  const totals = Object.fromEntries(nutrientCols.map((c) => [c, 0]));
  const missing = [];
  const resolved = [];
  // A log is only as complete as its groups — carry the foods they couldn't
  // resolve up to the log so a gap isn't hidden one level down.
  const missingFoods = [];
  const noteMissing = (names) => {
    for (const f of names || []) if (!missingFoods.includes(f)) missingFoods.push(f);
  };
  for (const it of items || []) {
    const qty = toNumber(it.qty) || 1;
    // A food eaten on its own. It has no group to expand into, so it resolves
    // to a row of its own with an empty food list.
    if (it.food) {
      const food = foodByName.get(String(it.food).toLowerCase());
      if (!food) { noteMissing([it.food]); continue; }
      for (const c of nutrientCols) totals[c] += (food.values[c] || 0) * qty;
      resolved.push({
        kind: "food",
        name: food.name,
        qty,
        calories: food.values["Calories"] || 0,
        foods: [],
      });
      continue;
    }
    // An ad-hoc group: its foods live in the entry itself, so they resolve
    // here rather than coming from groups.json.
    if (it.custom) {
      const own = resolveFoodItems(it.items, foodByName, nutrientCols);
      for (const c of nutrientCols) totals[c] += (own.totals[c] || 0) * qty;
      noteMissing(own.missing);
      resolved.push({
        kind: "custom",
        id: it.custom,
        name: it.name || "Custom group",
        qty,
        calories: own.totals["Calories"] || 0,
        foods: own.resolved.map((f) => ({ item: f.item, qty: f.qty })),
      });
      continue;
    }
    const ref = it.group ?? it.meal; // `meal` is the pre-rename key
    const group = byId.get(ref);
    if (!group) { missing.push(ref); continue; }
    for (const c of nutrientCols) totals[c] += (group.totals[c] || 0) * qty;
    noteMissing(group.missing);
    // Each group carries its own food list so the expanded log can show what
    // a group is made of without the caller re-resolving it against `groups`.
    resolved.push({
      kind: "group",
      id: group.id,
      name: group.name,
      qty,
      calories: group.totals["Calories"] || 0,
      foods: (group.resolved || []).map((f) => ({ item: f.item, qty: f.qty })),
    });
  }
  for (const c of nutrientCols) totals[c] = Math.round(totals[c] * 1000) / 1000;
  return { resolved, missing, missingFoods, totals };
}

export async function readLogsWithTotals() {
  const { groups, nutrientCols, duplicateFoods, targets, targetsMin, targetsMax, foods } = await readGroupsWithTotals();
  const byId = new Map(groups.map((m) => [m.id, m]));
  const foodByName = new Map(foods.map((f) => [f.name.toLowerCase(), f]));

  const logs = (await readLogs()).map((log) => ({
    ...log,
    items: log.items || [],
    ...resolveLogItems(log.items, { byId, foodByName, nutrientCols }),
  }));

  return { logs, groups, nutrientCols, duplicateFoods, targets, targetsMin, targetsMax, foods };
}

// ── AI helper: the meal log ────────────────────────────
// The Meal Log tab's version of the food tab's helper. Same panel, different
// subject: it reviews the day on screen against the daily target row, edits it,
// or builds a new one out of the foods in raw.csv. Proposals are whole item
// lists, costed here against the same table the tab shows, and written only when
// applied through /api/food-logs/save.

/** A day's list as the model should see it: names and quantities, no ids. */
function describeLogItems(resolved) {
  if (!resolved.length) return "    (empty)";
  return resolved
    .map((r) => {
      const head = `    - ${r.qty}× ${r.name}${r.kind === "food" ? "" : ` [${r.kind}]`} — ${Math.round(r.calories * (r.qty || 1))} cal`;
      const kids = (r.foods || []).map((f) => `        · ${f.qty}× ${f.item}`);
      return [head, ...kids].join("\n");
    })
    .join("\n");
}

/**
 * A saved day's list in the same shape the model has to return. Editing a day
 * is then "change this object", not "read this description and re-derive it" —
 * without it the sections and their names get flattened or renamed on the way
 * back, and a one-food change comes out as a rewrite of the whole day.
 */
function proposalItemsFromLog(log, groupNameById) {
  return (log.items || [])
    .map((it) => {
      const qty = toNumber(it.qty) || 1;
      if (it.food) return { food: it.food, qty };
      if (it.custom) {
        return {
          section: it.name || "Section",
          qty,
          foods: (it.items || []).map((f) => ({ item: f.item, qty: toNumber(f.qty) || 1 })),
        };
      }
      const group = groupNameById.get(it.group ?? it.meal);
      return group ? { group, qty } : null;
    })
    .filter(Boolean);
}

/** Totals beside the daily rows, so the model reads the gap rather than deriving it. */
function describeAgainstTargets(totals, { targets, targetsMin, targetsMax, nutrientCols }) {
  return nutrientCols
    .map((c) => {
      const have = Math.round((totals[c] || 0) * 10) / 10;
      const parts = [`${c}: ${have}`];
      // A blank in a daily row is left out rather than sent as 0 — there's no
      // figure for that nutrient, and a 0 reads as a goal of none.
      if (targets?.values[c] != null) parts.push(`target ${targets.values[c]}`);
      if (targetsMin?.values[c] != null) parts.push(`min ${targetsMin.values[c]}`);
      if (targetsMax?.values[c] != null) parts.push(`max ${targetsMax.values[c]}`);
      return `    ${parts.join(" | ")}`;
    })
    .join("\n");
}

function buildLogAssistPrompt({ csv, data, active, question, imageCount }) {
  const { logs, groups, nutrientCols, targets, targetsMin, targetsMax } = data;
  const others = logs.filter((m) => !active || m.id !== active.id);
  const groupNameById = new Map(groups.map((g) => [g.id, g.name]));

  const imageIntro = imageCount
    ? `Steve attached ${imageCount} image${imageCount === 1 ? "" : "s"} — read ${imageCount === 1 ? "it" : "them"} as part of his question.\n\n`
    : "";

  const activeBlock = active
    ? `THE ACTIVE DAY — the day currently on screen, and what "this day" means
  id: ${active.id}
  name: ${active.name}
${active.notes ? `  notes: ${active.notes}\n` : ""}  items:
${describeLogItems(active.resolved)}
  totals for the whole day, against the daily rows:
${describeAgainstTargets(active.totals, { targets, targetsMin, targetsMax, nutrientCols })}

  its current list in the OUTPUT format below — if you're changing this day,
  start from exactly this and edit it in place rather than rebuilding it:
${JSON.stringify(proposalItemsFromLog(active, groupNameById), null, 2)}`
    : `THE ACTIVE DAY
  (none is selected — a request to change "this day" has nothing to act on, so say so and propose a new one instead if that makes sense.)`;

  return `You are Steve's nutrition analyst, working on his meal log. The log is a record of days he has eaten: one entry per day, its foods drawn from his reference table. Read a day as something already eaten unless he says otherwise — a review is about what he did eat, not what he ought to plan. Answer his question, and — only if he asked for something built or changed — propose the day.

${imageIntro}QUESTION FROM STEVE
${question || "(no text — work from the attached images)"}

${activeBlock}

OTHER DAYS IN THE LOG
${others.length ? others.map((m) => `  ${m.name} (id: ${m.id}) — ${Math.round(m.totals["Calories"] || 0)} cal\n${describeLogItems(m.resolved)}`).join("\n") : "  (none)"}

${groups.length ? `SAVED MEALS — reusable food groups a day can reference by name\n${groups.map((g) => `  ${g.name}: ${(g.items || []).map((i) => `${i.qty}× ${i.item}`).join(", ")}`).join("\n")}\n` : ""}
THE DAILY ROWS
Steve's daily goals live in the food table as ordinary rows: target "${targets?.name || "(missing)"}", minimum "${targetsMin?.name || "(missing)"}", maximum "${targetsMax?.name || "(missing)"}". A good day lands near the target, above every minimum and under every maximum.

FOOD TABLE (raw.csv, complete — every food a day may use)
${csv.trim()}

HOW TO WORK
- Every food in a proposal must be an EXACT item name from the table above. You cannot invent foods — if the day needs something that isn't in the table, say so in the answer and leave it out of the proposal.
- Quantity is a multiplier on that row's serving, so 2× a row whose serving is 3 oz means 6 oz. Fractions are fine.
- Do the arithmetic against the table. When you say a day hits a number, it must be the number the rows actually add to.
- Research outside facts (guidance, nutrient timing, current evidence) with web_search / web_fetch when the question calls for it. Do NOT open a browser.
- Answer in full: name the foods, quantities and figures involved. Skip the preamble.

PROPOSING DAYS
Only propose when Steve asked for something built or changed. A review or a question gets an empty "templates" list — put the recommendations in the answer instead.
A proposal is the day's COMPLETE item list, not a patch: carry forward everything that stays.
- To change the active day, use its exact id. To create a new one, use "" for the id and give it a name.
- Divide a day into meals with sections ("Breakfast", "Lunch") when that's how it reads — a section is what the tab calls a meal, and it holds its own foods and belongs to this day alone.
- Changing an existing day means changing as little as possible: keep its section names, its ordering and its untouched foods EXACTLY as they are. Do not rename or regroup a day Steve didn't ask you to regroup — the change is reviewed as a diff, and a restructure buries what you actually did.

OUTPUT
Return ONLY a JSON object — no markdown fence around the whole thing, no commentary outside it:
{
  "answer": string,      // markdown; tables and lists are fine
  "sources": [string],   // what you actually consulted, empty if none
  "templates": [        // the days you propose — the key is historical, kept so
                        //   the tab keeps reading proposals it already understands
    {
      "id": string,      // existing day id, or "" for a new one
      "name": string,
      "notes": string,
      "reason": string,  // one line on what changed and why
      "items": [
        { "food": "<exact item name>", "qty": number },
        { "section": "Breakfast", "qty": 1, "foods": [ { "item": "<exact item name>", "qty": number } ] }
      ]
    }
  ]
}`;
}

/** Turn the model's item list into food-logs.json's own shape. */
function logItemsFromProposal(items, groupIdByName) {
  return (Array.isArray(items) ? items : [])
    .map((it) => {
      const qty = toNumber(it?.qty) || 1;
      if (it?.food) return { food: normalizeItemName(it.food), qty };
      // A section is an ad-hoc group: its foods live in the day rather than in
      // groups.json, so it gets an id of its own here.
      const sectionName = it?.section ?? (Array.isArray(it?.foods) ? it?.name : null);
      if (sectionName) {
        const name = String(sectionName).replace(/\s+/g, " ").trim() || "Section";
        return {
          custom: slugId(name),
          name,
          qty,
          items: (it.foods ?? it.items ?? []).map((f) => ({
            item: normalizeItemName(f?.item ?? f?.food),
            qty: toNumber(f?.qty) || 1,
          })),
        };
      }
      // A saved group, named rather than id'd — the model never sees ids.
      const groupId = it?.group ? groupIdByName.get(String(it.group).toLowerCase()) : null;
      return groupId ? { group: groupId, qty } : null;
    })
    .filter(Boolean);
}

/**
 * What moved between two resolved lists, matched on name. A day can hold the
 * same entry more than once — three coffees across a morning — so quantities
 * are totalled per name rather than paired off row by row, which would report a
 * spurious add and remove every time one of a repeated pair moved.
 */
function logItemChanges(before, after) {
  const tally = (rows) => {
    const by = new Map();
    for (const r of rows) {
      const key = r.name.toLowerCase();
      const seen = by.get(key);
      if (seen) seen.qty += r.qty;
      else by.set(key, { name: r.name, qty: r.qty });
    }
    return by;
  };
  const wasBy = tally(before);
  const nowBy = tally(after);
  const changes = [];
  for (const [key, now] of nowBy) {
    const was = wasBy.get(key);
    if (!was) changes.push({ kind: "added", name: now.name, to: now.qty });
    else if (Math.abs(was.qty - now.qty) > 1e-6) {
      changes.push({ kind: "qty", name: now.name, from: was.qty, to: now.qty });
    }
  }
  for (const [key, was] of wasBy) {
    if (!nowBy.has(key)) changes.push({ kind: "removed", name: was.name, from: was.qty });
  }
  return changes;
}

/**
 * Answer a question about the logged days, optionally proposing whole
 * days to create or replace. Writes nothing — each proposal comes back
 * costed, diffed against the day it would replace, and applied only when
 * the caller posts it to /api/food-logs/save.
 *
 * @param {object} opts
 * @param {string}   [opts.question]   Steve's prompt.
 * @param {string[]} [opts.imagePaths] Local image files to include.
 * @param {string}   [opts.logId]     The day on screen — what "this
 *                                     day" refers to.
 * @param {AbortSignal} [opts.signal]  Cancel the run — kills the model process.
 */
export async function logAssist({ question = "", imagePaths = [], logId = "", signal } = {}) {
  const paths = (Array.isArray(imagePaths) ? imagePaths : []).filter(Boolean);
  if (!question.trim() && !paths.length) {
    throw new Error("Ask a question, attach a photo, or both");
  }
  const csv = await readFile(NUTRITION_FILE, "utf-8");
  const data = await readLogsWithTotals();
  const active = data.logs.find((m) => m.id === logId) || null;
  const prompt = buildLogAssistPrompt({
    csv,
    data,
    active,
    question: question.trim(),
    imageCount: paths.length,
  });

  let raw = await codexP(prompt, {
    dashTools: true,
    imagePaths: paths,
    timeoutMs: 5 * 60 * 1000,
    source: "log-assist",
    signal,
  });

  const parsed = parseJsonResponse(raw);
  const byId = new Map(data.groups.map((g) => [g.id, g]));
  const foodByName = new Map(data.foods.map((f) => [f.name.toLowerCase(), f]));
  const groupIdByName = new Map(data.groups.map((g) => [g.name.toLowerCase(), g.id]));
  const ctx = { byId, foodByName, nutrientCols: data.nutrientCols };

  const templates = (Array.isArray(parsed.templates) ? parsed.templates : [])
    .slice(0, MAX_ASSIST_PROPOSALS)
    .map((t) => {
      const existing = data.logs.find((m) => m.id === t?.id) || null;
      const items = normalizeLogItems(logItemsFromProposal(t?.items, groupIdByName));
      const { resolved, missingFoods, totals } = resolveLogItems(items, ctx);
      const name = String(t?.name || existing?.name || "").replace(/\s+/g, " ").trim();
      return {
        id: existing ? existing.id : "",
        name: name || "Untitled template",
        notes: typeof t?.notes === "string" ? t.notes : existing?.notes || "",
        reason: typeof t?.reason === "string" ? t.reason : "",
        isNew: !existing,
        items,
        resolved,
        // Foods the model named that aren't in the table — they contribute
        // nothing, so the review card has to say so rather than let the totals
        // quietly come up short.
        missingFoods,
        totals,
        previousTotals: existing ? existing.totals : null,
        changes: existing ? logItemChanges(existing.resolved, resolved) : [],
      };
    })
    .filter((t) => t.resolved.length > 0 || t.missingFoods.length > 0);

  return {
    answer: typeof parsed.answer === "string" ? parsed.answer : String(parsed.answer ?? ""),
    sources: Array.isArray(parsed.sources) ? parsed.sources.filter((s) => typeof s === "string") : [],
    templates,
    targets: data.targets,
    nutrientCols: data.nutrientCols,
  };
}
