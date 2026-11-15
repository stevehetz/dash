import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createJob } from "./create-job.js";
import { getCachedEvents, getCacheTimestamp } from "./calendar-cache.js";

/**
 * Mirrors the day's calendar events into the planner (timeline) file.
 *
 * Ownership: blocks carry `source: "calendar"` when this job created them.
 * Anything without that marker is Steve's — never touched, moved, or removed.
 * Calendar-owned blocks are re-synced each run: retimed, retitled, or dropped
 * to match the calendar. Timed events become blocks; all-day events go in a
 * separate `allDay` list the planner renders as pills above the timeline.
 *
 * Each calendar block is keyed by `calEventId` = source:uid:date. Recurring
 * events expand to one occurrence per day, so keying on the day (rather than
 * the exact start) keeps the same block when a meeting moves within the day —
 * which preserves the block id and any notes Steve typed on it.
 */

/**
 * Placeholders Steve puts on his work calendar to stop people booking over him.
 * They aren't real plans, so they never reach the planner. Matched on the whole
 * title (trimmed, case-insensitive) so a genuine "Lunch with Dave" still shows.
 */
const IGNORED_TITLES = new Set(["lunch", "appointment"]);

function isIgnoredTitle(summary) {
  return IGNORED_TITLES.has(String(summary || "").trim().toLowerCase());
}

function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function localClock(d) {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function eventKey(e, date) {
  const uid = e.uid || e.id || e.summary || "unknown";
  return `${e.source || "apple"}:${uid}:${date}`;
}

function newBlockId() {
  return `b_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Turn a cached calendar event into planner block fields for `date`.
 * Returns null when the event doesn't actually overlap the day.
 */
function toBlockFields(e, date) {
  const start = new Date(e.startDate);
  const end = new Date(e.endDate || e.startDate);
  if (Number.isNaN(start.getTime())) return null;

  const dayStart = new Date(`${date}T00:00:00`);
  const dayEnd = new Date(`${date}T23:59:59`);
  if (end <= dayStart || start > dayEnd) return null;

  // Events can straddle midnight; clamp them to the day being synced.
  const startStr = start < dayStart ? "00:00" : localClock(start);
  let endStr = end > dayEnd ? "23:59" : localClock(end);
  // A zero-length block is invisible in the planner — give it a minute.
  if (endStr === startStr) endStr = endStr === "23:59" ? "23:59" : localClock(new Date(end.getTime() + 60000));

  return { start: startStr, end: endStr, title: e.summary || "(untitled)" };
}

function sameBlocks(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Reconcile the planner file for `date` against the calendar cache.
 * Returns a summary: { date, added, updated, removed, allDay, skipped }.
 *
 * `events` overrides the cache as the event source — the job and the HTTP
 * endpoint both omit it; it exists so the reconciliation can be exercised
 * against fixtures without a populated cache.
 */
export async function syncCalendarToPlanner(date = localDate(), { events: injected } = {}) {
  const onedrive = process.env.ONEDRIVE_PATH;
  if (!onedrive) return { date, skipped: "ONEDRIVE_PATH not set" };
  if (!injected && getCacheTimestamp() === 0) {
    return { date, skipped: "calendar cache not populated yet" };
  }

  const events = injected || getCachedEvents({
    startDate: `${date}T00:00:00`,
    endDate: `${date}T23:59:59`,
  });

  const dir = join(onedrive, "dashbook/data/timeline");
  const filePath = join(dir, `${date}.json`);

  let existing = { date, blocks: [], allDay: [] };
  try {
    existing = JSON.parse(await readFile(filePath, "utf-8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const existingBlocks = Array.isArray(existing.blocks) ? existing.blocks : [];
  const existingAllDay = Array.isArray(existing.allDay) ? existing.allDay : [];

  // Steve's own blocks pass through untouched.
  const manualBlocks = existingBlocks.filter((b) => b.source !== "calendar");
  const priorCalBlocks = new Map();
  for (const b of existingBlocks) {
    if (b.source === "calendar" && b.calEventId) priorCalBlocks.set(b.calEventId, b);
  }
  const priorAllDay = new Map();
  for (const a of existingAllDay) {
    if (a.calEventId) priorAllDay.set(a.calEventId, a);
  }

  const calBlocks = [];
  const allDay = [];
  const seen = new Set();
  let added = 0;
  let updated = 0;

  for (const e of events) {
    // Skipped before the key is recorded in `seen`, so any block synced under
    // one of these titles previously is treated as stale and removed.
    if (isIgnoredTitle(e.summary)) continue;

    let key = eventKey(e, date);
    // Two occurrences of one recurring event in a single day would collide.
    let n = 1;
    while (seen.has(key)) key = `${eventKey(e, date)}#${++n}`;
    seen.add(key);

    // Anything not contained within this single day goes to the all-day strip,
    // whichever side it overflows. Clamping a multi-day event produces a giant
    // 00:00-to-whenever (or whenever-to-23:59) bar that swamps the chart, and
    // clamping only one side rendered the same event as a bar on the day it
    // started and a pill on every day after. Calendars show multi-day events in
    // the all-day row on every day they touch; so do we.
    // An event ending exactly at midnight is still contained — 22:00-00:00 is a
    // normal evening block, not a multi-day event.
    const dayStart = new Date(`${date}T00:00:00`);
    const nextDayStart = new Date(dayStart);
    nextDayStart.setDate(nextDayStart.getDate() + 1);
    const evStart = new Date(e.startDate);
    const evEnd = new Date(e.endDate || e.startDate);
    const spansDays = evStart < dayStart || evEnd > nextDayStart;

    if (e.allDay || spansDays) {
      const prior = priorAllDay.get(key);
      allDay.push({
        id: prior?.id || newBlockId(),
        title: e.summary || "(untitled)",
        source: "calendar",
        calEventId: key,
      });
      continue;
    }

    const fields = toBlockFields(e, date);
    if (!fields) continue;

    const prior = priorCalBlocks.get(key);
    const block = {
      id: prior?.id || newBlockId(),
      start: fields.start,
      end: fields.end,
      title: fields.title,
      // Notes are Steve's even on a calendar-owned block — keep them.
      notes: prior?.notes || "",
      source: "calendar",
      calEventId: key,
    };
    if (!prior) added++;
    else if (!sameBlocks(prior, block)) updated++;
    calBlocks.push(block);
  }

  const removed = [...priorCalBlocks.keys()].filter((k) => !seen.has(k)).length;

  const blocks = [...manualBlocks, ...calBlocks].sort((a, b) => a.start.localeCompare(b.start));
  const payload = { date, blocks, allDay, updatedAt: existing.updatedAt || null };

  // Only write when something actually changed — this runs hourly against
  // OneDrive, and a no-op write would churn sync on every machine.
  const unchanged =
    sameBlocks(existingBlocks, blocks) && sameBlocks(existingAllDay, allDay);
  if (unchanged) return { date, added: 0, updated: 0, removed: 0, allDay: allDay.length, unchanged: true };

  payload.updatedAt = new Date().toISOString();
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, JSON.stringify(payload, null, 2), "utf-8");

  return { date, added, updated, removed, allDay: allDay.length };
}

/**
 * Today plus the next six days — seven in total. The cache starts at yesterday,
 * so its range must be >= PLANNER_SYNC_DAYS + 1 for the final day to have data.
 */
export const PLANNER_SYNC_DAYS = 7;

/**
 * Run the reconciliation across the sync window, starting today. Past days are
 * never touched — only today forward, so history stays as it was lived.
 */
export async function syncCalendarWindow(days = PLANNER_SYNC_DAYS) {
  const results = [];
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    results.push(await syncCalendarToPlanner(localDate(d)));
  }
  return results;
}

export function startCalendarPlannerSync({ interval } = {}) {
  return createJob({
    name: "calendar-planner-sync",
    interval: interval ?? 60 * 60 * 1000, // hourly
    runOnStart: false, // let the calendar cache populate first
    sequential: true,
    async fn() {
      const results = await syncCalendarWindow();
      const skipped = results.find((r) => r.skipped);
      if (skipped) {
        console.log(`  ⏭️  calendar-planner-sync: ${skipped.skipped}`);
        return;
      }
      const sum = (k) => results.reduce((n, r) => n + (r[k] || 0), 0);
      const changedDays = results.filter((r) => !r.unchanged);
      if (changedDays.length === 0) return;
      console.log(
        `  📅 calendar-planner-sync: ${changedDays.length}/${results.length} day(s) changed — ` +
        `+${sum("added")} ~${sum("updated")} -${sum("removed")} (${changedDays.map((r) => r.date).join(", ")})`
      );
    },
  });
}
