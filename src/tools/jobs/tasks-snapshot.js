import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createJob } from "./create-job.js";
import { snapshotReminders } from "../apple/apple-notes-reminders.js";

const TASKS_REL = "dashbook/data/tasks";

const STATE_FILE = "_state.json";

// Apple keeps completed reminders only until reminder-cleanup deletes them, so
// this file is the only lasting record of what got done on a given day.
// Layout: one file per local day, dashbook/data/tasks/YYYY-MM-DD.json
//   completed — accumulates; keyed by reminder id + occurrence, filed under the
//               day it was completed, so a task finished at 12:30am lands there.
//   open      — the day's latest look at what was still outstanding. Only the
//               current day is refreshed; past days keep the last snapshot
//               taken while they were still today (their end-of-day state).
// _state.json holds the previous run's due dates — see detectRecurringDone.

function localDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function tasksDir() {
  return join(process.env.ONEDRIVE_PATH, TASKS_REL);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(join(tasksDir(), file), "utf-8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    return fallback;
  }
}

async function readDay(date) {
  const data = await readJson(`${date}.json`, {});
  return { completed: data.completed || [], open: data.open || [] };
}

function byName(a, b) {
  return String(a.name || "").localeCompare(String(b.name || ""));
}

// A completed reminder appears twice only if it's a repeat on the same day,
// which is a distinct occurrence — so the due date is part of the key.
function completedKey(t) {
  return `${t.id}|${t.occurrence || ""}`;
}

/**
 * Recurring reminders never read as completed: Apple rolls the due date forward
 * to the next occurrence and leaves the reminder open, so `completed` stays
 * false and there is no completion date. The roll-forward is the only signal —
 * an open reminder whose due date moved later than last snapshot was completed
 * in between. (Manually pushing a due date out looks the same; it gets logged
 * as done. Nothing in the Reminders scripting API can tell the two apart.)
 *
 * Returns completed entries stamped at detection time, so a completion lands on
 * the day it was noticed — within one job interval of when it happened.
 */
function detectRecurringDone(open, prevDue, now) {
  const done = [];
  for (const t of open) {
    if (!t.dueDate) continue;
    const previous = prevDue[t.id];
    if (!previous || !(new Date(t.dueDate) > new Date(previous))) continue;
    done.push({
      id: t.id,
      name: t.name,
      list: t.list,
      dueDate: previous, // the occurrence that got completed
      occurrence: previous,
      priority: t.priority,
      completedAt: now.toISOString(),
      recurring: true,
    });
  }
  return done;
}

/**
 * Read every reminder and fold it into the per-day files. Idempotent — running
 * it more often just keeps the day's picture fresher.
 */
export async function snapshotTasks() {
  if (!process.env.ONEDRIVE_PATH) {
    console.log("  ⏭️  tasks-snapshot: ONEDRIVE_PATH not set, skipping");
    return { completed: 0, open: 0, days: 0 };
  }
  const reminders = await snapshotReminders();
  const now = new Date();
  const today = localDate(now);
  const prevDue = (await readJson(STATE_FILE, {})).dueDates || {};

  const completedByDay = new Map();
  const open = [];
  for (const r of reminders) {
    const task = {
      id: r.id,
      name: r.name,
      list: r.list,
      dueDate: r.dueDate,
      priority: r.priority || 0,
    };
    if (!r.completed) {
      open.push(task);
      continue;
    }
    // A completed reminder with no date is rare (older sync, or a list that
    // doesn't report one) — file it under today rather than lose it.
    const day = r.completionDate ? localDate(new Date(r.completionDate)) : today;
    if (!completedByDay.has(day)) completedByDay.set(day, []);
    completedByDay.get(day).push({ ...task, completedAt: r.completionDate });
  }
  open.sort(byName);

  // Recurring completions surface as a due date that moved forward, and are
  // only visible at the moment we notice them — so they file under today.
  const recurringDone = detectRecurringDone(open, prevDue, now);
  if (recurringDone.length) {
    if (!completedByDay.has(today)) completedByDay.set(today, []);
    completedByDay.get(today).push(...recurringDone);
  }

  await mkdir(tasksDir(), { recursive: true });

  const days = new Set([...completedByDay.keys(), today]);
  let written = 0;
  let completedCount = 0;
  for (const day of days) {
    const existing = await readDay(day);

    const merged = new Map(existing.completed.map((t) => [completedKey(t), t]));
    for (const t of completedByDay.get(day) || []) merged.set(completedKey(t), t);
    const completed = [...merged.values()].sort((a, b) =>
      String(a.completedAt || "").localeCompare(String(b.completedAt || "")) || byName(a, b)
    );
    completedCount += completed.length;

    // Only today's outstanding list reflects reality; older files keep theirs.
    const dayOpen = day === today ? open : existing.open;

    const payload = { date: day, completed, open: dayOpen };
    const before = JSON.stringify({ date: day, completed: existing.completed, open: existing.open });
    if (JSON.stringify(payload) === before) continue; // don't churn OneDrive

    await writeFile(
      join(tasksDir(), `${day}.json`),
      JSON.stringify({ ...payload, updatedAt: new Date().toISOString() }, null, 2)
    );
    written++;
  }

  // Baseline for the next run's roll-forward check. Open reminders only —
  // a completed one has no next occurrence to compare against.
  const dueDates = {};
  for (const t of open) if (t.dueDate) dueDates[t.id] = t.dueDate;
  if (JSON.stringify(dueDates) !== JSON.stringify(prevDue)) {
    await writeFile(
      join(tasksDir(), STATE_FILE),
      JSON.stringify({ updatedAt: now.toISOString(), dueDates }, null, 2)
    );
  }

  if (written > 0) {
    const extra = recurringDone.length ? `, ${recurringDone.length} recurring done` : "";
    console.log(`  ✅ tasks-snapshot: ${completedCount} completed, ${open.length} open${extra} → ${written} day file(s)`);
  }
  return { completed: completedCount, open: open.length, recurring: recurringDone.length, days: written };
}

export function startTasksSnapshot({ interval } = {}) {
  return createJob({
    name: "tasks-snapshot",
    interval: interval ?? 30 * 60 * 1000,
    runOnStart: true,
    sequential: true,
    fn: snapshotTasks,
  });
}
