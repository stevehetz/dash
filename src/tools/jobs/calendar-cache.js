import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJob } from "./create-job.js";
import { listEventsRaw } from "../apple/apple-calendar.js";

// The bot's cache lives in its process memory, but the agent reaches tools via
// `node tools.js call …` — a fresh process with a cold cache, which then falls
// back to a full JXA scan of Calendar.app (minutes) and times out. So the bot
// also writes each refresh to disk, and cold processes read that snapshot.
const SNAPSHOT_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../../data/calendar-cache.json");
const SNAPSHOT_MAX_AGE_MS = 30 * 60 * 1000;

/** In-memory unified calendar cache */
let cachedEvents = [];
let cacheTimestamp = 0;
let googleCalMgr = null;

// Spans from the start of yesterday, so it must stay >= PLANNER_SYNC_DAYS + 1
// for the planner sync (today .. today+6) to have a full final day of data.
// All readers filter down to the range they actually want.
const CACHE_RANGE_DAYS = 9;

/**
 * Fetch all Apple Calendar events in [now, now + 7 days].
 * Uses a simple .whose() query — Calendar.app expands recurring events for us.
 */
async function fetchAppleEvents(rangeStart, rangeEnd) {
  try {
    return await listEventsRaw(rangeStart, rangeEnd);
  } catch (err) {
    console.error("  ❌ Calendar cache: Apple Calendar fetch failed:", err.message);
    return [];
  }
}

/**
 * Fetch all Google Calendar events in [now, now + 7 days] across all calendars.
 */
async function fetchGoogleEvents(rangeStart, rangeEnd) {
  if (!googleCalMgr) return [];
  try {
    const calendars = await googleCalMgr.listCalendars();
    // Skip holiday calendars — already covered by Apple Calendar's "US Holidays"
    const filtered = calendars.filter((c) => !c.summary.toLowerCase().includes("holiday"));
    const allEvents = [];

    for (const cal of filtered) {
      try {
        const events = await googleCalMgr.listEvents(cal.id, {
          timeMin: rangeStart.toISOString(),
          timeMax: rangeEnd.toISOString(),
          maxResults: 200,
        });
        for (const e of events) {
          // Google returns all-day events as date-only strings ("2026-07-29").
          // `new Date("2026-07-29")` parses as UTC midnight, which is the
          // previous evening east of Greenwich — that shifted every all-day
          // event a day early. Pin them to local midnight instead.
          const isAllDay = !e.start.includes("T");
          allEvents.push({
            id: e.id,
            summary: e.summary,
            startDate: isAllDay ? new Date(`${e.start}T00:00:00`).toISOString() : e.start,
            endDate: isAllDay ? new Date(`${e.end}T00:00:00`).toISOString() : e.end,
            location: e.location,
            description: e.description,
            allDay: isAllDay,
            calendar: cal.summary,
            source: "google",
          });
        }
      } catch {
        // Skip calendars that fail (e.g. permission issues)
      }
    }

    return allEvents;
  } catch (err) {
    console.error("  ❌ Calendar cache: Google Calendar fetch failed:", err.message);
    return [];
  }
}

/**
 * All-day events (both sources) end at midnight of the *following* day — the
 * end is exclusive. Left as-is, a one-day event overlaps the next day's range
 * and shows up twice. Pull the end back an instant so it belongs only to the
 * days it actually covers.
 */
function clampAllDayEnd(e) {
  if (!e.allDay || !e.endDate) return e;
  const end = new Date(e.endDate);
  if (Number.isNaN(end.getTime())) return e;
  const atLocalMidnight =
    end.getHours() === 0 && end.getMinutes() === 0 &&
    end.getSeconds() === 0 && end.getMilliseconds() === 0;
  if (!atLocalMidnight) return e;
  return { ...e, endDate: new Date(end.getTime() - 1).toISOString() };
}

async function refreshCache() {
  const rangeStart = new Date();
  rangeStart.setHours(0, 0, 0, 0);
  rangeStart.setDate(rangeStart.getDate() - 1); // start of yesterday
  const rangeEnd = new Date(rangeStart.getTime() + CACHE_RANGE_DAYS * 86400000);

  const [appleEvents, googleEvents] = await Promise.all([
    fetchAppleEvents(rangeStart, rangeEnd),
    fetchGoogleEvents(rangeStart, rangeEnd),
  ]);

  const all = [...appleEvents, ...googleEvents].map(clampAllDayEnd);
  all.sort((a, b) => new Date(a.startDate) - new Date(b.startDate));

  cachedEvents = all;
  cacheTimestamp = Date.now();
  writeSnapshot();
}

function writeSnapshot() {
  try {
    mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true });
    const tmp = `${SNAPSHOT_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify({ timestamp: cacheTimestamp, events: cachedEvents }));
    renameSync(tmp, SNAPSHOT_PATH);
  } catch (err) {
    console.error("  ❌ Calendar cache: snapshot write failed:", err.message);
  }
}

/**
 * In a process whose in-memory cache is cold (e.g. `tools.js call`), load the
 * bot's on-disk snapshot if it's recent. Returns true if a usable cache is loaded.
 */
export function loadCalendarSnapshot() {
  if (cacheTimestamp > 0) return true;
  try {
    const { timestamp, events } = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
    if (!timestamp || !Array.isArray(events) || Date.now() - timestamp > SNAPSHOT_MAX_AGE_MS) return false;
    cachedEvents = events;
    cacheTimestamp = timestamp;
    return true;
  } catch {
    return false;
  }
}

let refreshInFlight = null;

/**
 * Re-fetch Apple + Google now, rather than waiting for the 5-minute tick.
 * Concurrent callers share the one in-flight fetch, so mashing a refresh button
 * can't stack up overlapping JXA/API calls.
 */
export function refreshCalendarCache() {
  if (!refreshInFlight) {
    refreshInFlight = refreshCache().finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

/**
 * Get cached events, optionally filtered by date range and calendar.
 * Returns all cached events if no filters specified.
 */
export function getCachedEvents({ startDate, endDate, calendarName, source } = {}) {
  let events = cachedEvents;

  if (source) {
    events = events.filter((e) => e.source === source);
  }
  if (calendarName) {
    events = events.filter((e) => e.calendar === calendarName);
  }
  if (startDate) {
    const start = new Date(startDate);
    events = events.filter((e) => new Date(e.endDate || e.startDate) >= start);
  }
  if (endDate) {
    const end = new Date(endDate);
    events = events.filter((e) => new Date(e.startDate) <= end);
  }

  return events;
}

/** Returns the timestamp of the last cache refresh, or 0 if never refreshed. */
export function getCacheTimestamp() {
  return cacheTimestamp;
}

export function startCalendarCache({ googleCalendarManager, interval } = {}) {
  googleCalMgr = googleCalendarManager || null;

  return createJob({
    name: "calendar-cache",
    interval: interval ?? 5 * 60 * 1000, // every 5 minutes
    runOnStart: true,
    sequential: true,
    async fn() {
      await refreshCalendarCache();
    },
  });
}
