import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createJob } from "./create-job.js";
import { getCachedEvents, getCacheTimestamp } from "./calendar-cache.js";

/**
 * Records yesterday's calendar events from the in-memory cache.
 * The cache now includes yesterday through +7 days, so this can run
 * after midnight to capture the full previous day.
 */

function yesterdayET() {
  const now = new Date();
  const et = new Date(
    now.toLocaleString("en-US", { timeZone: "America/New_York" })
  );
  et.setDate(et.getDate() - 1);
  const y = et.getFullYear();
  const m = String(et.getMonth() + 1).padStart(2, "0");
  const d = String(et.getDate()).padStart(2, "0");
  return { date: `${y}-${m}-${d}`, year: String(y) };
}

async function exportCalendarHistory() {
  const onedrive = process.env.ONEDRIVE_PATH;
  if (!onedrive) {
    console.log("  ⏭️  calendar-history: ONEDRIVE_PATH not set, skipping");
    return;
  }

  if (getCacheTimestamp() === 0) {
    console.log("  ⏭️  calendar-history: cache not populated yet, skipping");
    return;
  }

  const { date, year } = yesterdayET();

  const startDate = `${date}T00:00:00`;
  const endDate = `${date}T23:59:59`;
  const cached = getCachedEvents({ startDate, endDate });

  const events = cached.map((e) => ({
    title: e.summary,
    start: e.startDate,
    end: e.endDate,
    location: e.location || null,
    calendar: e.source,
    description: null,
  }));

  events.sort((a, b) => new Date(a.start) - new Date(b.start));

  // Read existing JSON or start fresh
  const filePath = join(
    onedrive,
    `dashbook/data/reports/calendar/${year}.json`
  );
  await mkdir(join(onedrive, "dashbook/data/reports/calendar"), {
    recursive: true,
  });

  let history = {};
  try {
    const raw = await readFile(filePath, "utf-8");
    history = JSON.parse(raw);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  history[date] = events;
  await writeFile(filePath, JSON.stringify(history, null, 2), "utf-8");

  console.log(
    `  📅 calendar-history: Saved ${events.length} events for ${date}`
  );
}

export function startCalendarHistoryExport({ interval } = {}) {
  return createJob({
    name: "calendar-history",
    interval: interval ?? 6 * 60 * 60 * 1000,
    runOnStart: false, // wait for cache to populate first
    sequential: true,
    activeHours: { start: 0, end: 6, timezone: "America/New_York" },
    fn: exportCalendarHistory,
  });
}
