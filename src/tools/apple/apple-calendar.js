import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pkg from "rrule";
const { RRule } = pkg;

const exec = promisify(execFile);

const TIMEOUT = 30000;
const TIMEOUT_LONG = 300000;

async function runJxa(script, timeout = TIMEOUT) {
  try {
    const { stdout } = await exec("osascript", ["-l", "JavaScript", "-e", script], {
      timeout,
    });
    return stdout.trim();
  } catch (err) {
    const stderr = (err.stderr || "").trim();
    if (stderr) {
      const wrapped = new Error(`osascript failed: ${stderr}`);
      wrapped.cause = err;
      throw wrapped;
    }
    throw err;
  }
}

const DEFAULT_CALENDARS = [
  "shetzel84@gmail.com",
  "Family (Cameron\u2019s schedule) ",
  "US Holidays",
  "Birthdays",
  "Calendar",
];

// Work calendars: only summary + dates are cached — no location, description, or attendees
const SANITIZED_CALENDARS = ["Calendar"];

function calSelector(calendarName) {
  if (calendarName) {
    return `(() => {
      const names = app.calendars.name();
      const i = names.indexOf(${JSON.stringify(calendarName)});
      return i >= 0 ? [app.calendars[i]] : [];
    })()`;
  }
  const allowed = JSON.stringify(DEFAULT_CALENDARS);
  return `(() => {
    const allowed = ${allowed};
    const names = app.calendars.name();
    const cals = [];
    for (let i = 0; i < names.length; i++) {
      if (allowed.includes(names[i])) cals.push(app.calendars[i]);
    }
    return cals;
  })()`;
}

// ── Raw event fetching (used by calendar cache) ────────

function formatRRuleDateLocal(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * Does `master`'s recurrence rule itself generate an occurrence on the local
 * day of `iso`? Used to tell a same-day edit (the 5pm pickup moved to 3pm on
 * one Tuesday) apart from a genuine move to another day.
 *
 * Rules are built floating (no Z), so rrule returns local wall-clock in UTC
 * fields — the day window is built the same way to match.
 */
function ruleHasOccurrenceOnLocalDate(master, iso) {
  try {
    const dtstart = new Date(master.startDate);
    const rule = RRule.fromString(`DTSTART:${formatRRuleDateLocal(dtstart)}\nRRULE:${master.recurrence}`);
    const d = new Date(iso);
    const dayStart = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0));
    const dayEnd = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59));
    return rule.between(dayStart, dayEnd, true).length > 0;
  } catch {
    return false;
  }
}

function expandRecurring(events, rangeStart, rangeEnd) {
  const results = [];
  const seen = new Set();
  for (const ev of events) {
    try {
      const dtstart = new Date(ev.startDate);
      const duration = new Date(ev.endDate) - dtstart;
      // Use local time (no Z suffix) so rrule expands at the correct wall-clock
      // time across DST boundaries — Calendar.app stores events in local time
      const rule = RRule.fromString(`DTSTART:${formatRRuleDateLocal(dtstart)}\nRRULE:${ev.recurrence}`);
      const occurrences = rule.between(rangeStart, rangeEnd, true);
      for (const occ of occurrences) {
        // rrule floating time stores local time in UTC fields — adjust to real UTC
        const adjusted = new Date(occ.getTime() + occ.getTimezoneOffset() * 60000);
        // Deduplicate by uid + start time to prevent expired recurring entries
        // from producing duplicate events
        const key = `${ev.uid}:${adjusted.toISOString()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({
          uid: ev.uid,
          summary: ev.summary,
          startDate: adjusted.toISOString(),
          endDate: new Date(adjusted.getTime() + duration).toISOString(),
          location: ev.location,
          allDay: ev.allDay,
          calendar: ev.calendar,
          source: "apple",
          recurring: true,
        });
      }
    } catch {
      // Skip events with unparseable recurrence rules
    }
  }
  return results;
}

/**
 * Fetch all Apple Calendar events in a date range.
 * Non-recurring events use .whose() query.
 * Recurring events are fetched separately and expanded via RRULE.
 *
 * Cancelled events are dropped at the source. When an Exchange organizer calls
 * a meeting off, Calendar.app doesn't delete its copy — it keeps the record and
 * flips `status` to "cancelled". Outlook hides those, so a cancelled series that
 * still sits in the local store shows up nowhere on Steve's calendar and
 * everywhere in ours: a meeting he'd see no trace of, on the planner every time
 * the rule comes round.
 */
export async function listEventsRaw(rangeStart, rangeEnd) {
  // Step 1: Non-recurring events via .whose()
  const oneshotRaw = await runJxa(`
    const app = Application("Calendar");
    const cals = ${calSelector(null)};
    const start = new Date(${JSON.stringify(rangeStart.toISOString())});
    const end = new Date(${JSON.stringify(rangeEnd.toISOString())});
    const results = [];
    for (const cal of cals) {
      const calName = cal.name();
      const events = cal.events.whose({
        _and: [
          { endDate: { _greaterThan: start } },
          { startDate: { _lessThan: end } }
        ]
      })();
      for (let j = 0; j < events.length; j++) {
        const e = events[j];
        if (e.status() === "cancelled") continue;
        if (!e.recurrence()) {
          results.push({
            uid: e.uid(), summary: e.summary(),
            startDate: e.startDate().toISOString(), endDate: e.endDate().toISOString(),
            location: e.location() || null, allDay: e.alldayEvent(),
            calendar: calName, source: "apple"
          });
        }
      }
    }
    JSON.stringify(results);
  `, TIMEOUT_LONG);
  const oneshot = JSON.parse(oneshotRaw);

  // Step 2: Recurring events — fetch per calendar sequentially, then expand with RRULE
  const allRecurring = [];
  for (const calName of DEFAULT_CALENDARS) {
    try {
      const raw = await runJxa(`
        const app = Application("Calendar");
        const names = app.calendars.name();
        const i = names.indexOf(${JSON.stringify(calName)});
        if (i < 0) { JSON.stringify([]); } else {
          const cal = app.calendars[i];
          const recs = cal.events.recurrence();
          const uids = cal.events.uid();
          const summaries = cal.events.summary();
          const starts = cal.events.startDate();
          const ends = cal.events.endDate();
          const locs = cal.events.location();
          const alldays = cal.events.alldayEvent();
          const exDates = cal.events.excludedDates();
          const statuses = cal.events.status();
          const results = [];
          for (let j = 0; j < recs.length; j++) {
            if (recs[j] && statuses[j] !== "cancelled") {
              results.push({
                uid: uids[j], summary: summaries[j],
                startDate: starts[j].toISOString(), endDate: ends[j].toISOString(),
                location: locs[j] || null, allDay: alldays[j],
                recurrence: recs[j], calendar: ${JSON.stringify(calName)},
                excludedDates: (exDates[j] || []).map(d => d.toISOString())
              });
            }
          }
          JSON.stringify(results);
        }
      `, TIMEOUT_LONG);
      allRecurring.push(...JSON.parse(raw));
    } catch (err) {
      console.error(`  ❌ Calendar cache: recurring fetch failed for "${calName}":`, err.message);
    }
  }

  // Exchange calendars return multiple instances of the same recurring event
  // (master + modified occurrences), each with the recurrence rule attached.
  // Group by UID — keep the earliest startDate as the series master for RRULE
  // expansion, and collect modified occurrences (different start times) to
  // handle rescheduled/moved meetings.
  const masterByUid = new Map();
  const modifiedByUid = new Map();
  for (const ev of allRecurring) {
    const existing = masterByUid.get(ev.uid);
    if (!existing || new Date(ev.startDate) < new Date(existing.startDate)) {
      if (existing) {
        if (!modifiedByUid.has(ev.uid)) modifiedByUid.set(ev.uid, []);
        modifiedByUid.get(ev.uid).push(existing);
      }
      masterByUid.set(ev.uid, ev);
    } else {
      if (!modifiedByUid.has(ev.uid)) modifiedByUid.set(ev.uid, []);
      modifiedByUid.get(ev.uid).push(ev);
    }
  }

  // Merge excludedDates from all instances of each UID onto the master
  const toLocalDate = (iso) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  for (const [uid, master] of masterByUid) {
    const allExDates = new Set((master.excludedDates || []).map(toLocalDate));
    const mods = modifiedByUid.get(uid) || [];
    for (const mod of mods) {
      for (const d of (mod.excludedDates || [])) allExDates.add(toLocalDate(d));
    }
    master._excludedLocalDates = allExDates;
  }

  const expanded = expandRecurring([...masterByUid.values()], rangeStart, rangeEnd);

  // For each UID with modifications, reconcile RRULE occurrences:
  // 1. Remove RRULE occurrences on excludedDates (cancelled)
  // 2. Remove RRULE occurrences replaced by modified instances (moved)
  // 3. Add modified instances that fall in range
  const additions = [];
  const removals = new Set(); // indices to remove from expanded
  for (let i = 0; i < expanded.length; i++) {
    const ev = expanded[i];
    const master = masterByUid.get(ev.uid);

    // Check excludedDates — remove cancelled occurrences
    if (master?._excludedLocalDates?.has(toLocalDate(ev.startDate))) {
      removals.add(i);
      continue;
    }

    // Check modified instances — replace same-day reschedules
    const mods = modifiedByUid.get(ev.uid);
    if (!mods) continue;
    const evLocalDate = toLocalDate(ev.startDate);
    for (const mod of mods) {
      if (toLocalDate(mod.startDate) === evLocalDate) {
        const modStart = new Date(mod.startDate);
        const duration = new Date(mod.endDate) - modStart;
        expanded[i] = {
          ...ev,
          summary: mod.summary,
          startDate: modStart.toISOString(),
          endDate: new Date(modStart.getTime() + duration).toISOString(),
          location: mod.location,
        };
        mod._matched = true;
        break;
      }
    }
  }

  // For unmatched modified instances (moved to a different day), find and
  // remove the nearest RRULE occurrence they replaced, then add them if in range
  for (const [uid, mods] of modifiedByUid) {
    for (const mod of mods) {
      if (mod._matched) continue;
      const modStart = new Date(mod.startDate);

      // A modified instance sitting on a day the rule already generates is a
      // same-day edit — it replaces its own occurrence and displaces nothing.
      // The same-day match above only sees occurrences inside the query range,
      // so past edits arrive here unmatched: without this check, last Tuesday's
      // retimed pickup deleted *this* Tuesday's occurrence as the "closest" one.
      const master = masterByUid.get(uid);
      const displaced = !master || !ruleHasOccurrenceOnLocalDate(master, mod.startDate);

      if (displaced) {
        // Find the closest RRULE occurrence for this UID to remove
        let closestIdx = -1;
        let closestDist = Infinity;
        for (let i = 0; i < expanded.length; i++) {
          if (removals.has(i)) continue;
          if (expanded[i].uid !== uid) continue;
          const dist = Math.abs(new Date(expanded[i].startDate) - modStart);
          if (dist < closestDist) {
            closestDist = dist;
            closestIdx = i;
          }
        }
        // Only remove if the closest occurrence is within the RRULE pattern interval
        // (14 days covers weekly/bi-weekly patterns, generous for edge cases)
        if (closestIdx >= 0 && closestDist < 14 * 86400000) {
          removals.add(closestIdx);
        }
      }

      // Add the modified instance if it falls in the query range
      if (modStart >= rangeStart && modStart < rangeEnd) {
        const duration = new Date(mod.endDate) - modStart;
        additions.push({
          uid,
          summary: mod.summary,
          startDate: modStart.toISOString(),
          endDate: new Date(modStart.getTime() + duration).toISOString(),
          location: mod.location,
          allDay: mod.allDay,
          calendar: mod.calendar,
          source: "apple",
          recurring: true,
        });
      }
    }
  }

  const filtered = expanded.filter((_, i) => !removals.has(i));
  const all = [...oneshot, ...filtered, ...additions];
  all.sort((a, b) => new Date(a.startDate) - new Date(b.startDate));

  // Strip sensitive fields from work calendars
  for (const e of all) {
    if (SANITIZED_CALENDARS.includes(e.calendar)) {
      e.location = null;
    }
  }

  return all;
}

// ── Calendar ────────────────────────────────────────────

export async function listCalendars() {
  const raw = await runJxa(`
    const app = Application("Calendar");
    const names = app.calendars.name();
    JSON.stringify(names.map(n => ({ name: n })));
  `);
  return JSON.parse(raw);
}

export async function listEvents(calendarName, startDate, endDate) {
  // Lazy import to avoid circular dependency with calendar-cache
  const { getCachedEvents, getCacheTimestamp } = await import("../jobs/calendar-cache.js");

  // Use the unified cache if it's been populated — returns events from all sources
  if (getCacheTimestamp() > 0) {
    return getCachedEvents({
      startDate,
      endDate,
      calendarName,
    });
  }

  // Fallback: direct query if cache hasn't warmed yet
  const rangeStart = new Date(startDate || Date.now());
  const rangeEnd = new Date(endDate || Date.now() + 7 * 86400000);
  return listEventsRaw(rangeStart, rangeEnd);
}

export async function getEvent(eventUid, calendarName) {
  const raw = await runJxa(`
    const app = Application("Calendar");
    const cals = ${calSelector(calendarName)};
    let found = null;
    for (const cal of cals) {
      const events = cal.events.whose({uid: ${JSON.stringify(eventUid)}})();
      if (events.length > 0) {
        const e = events[0];
        found = {
          uid: e.uid(),
          summary: e.summary(),
          startDate: e.startDate().toISOString(),
          endDate: e.endDate().toISOString(),
          location: e.location() || null,
          description: e.description() || null,
          allDay: e.alldayEvent(),
          calendar: cal.name(),
          url: e.url() || null
        };
        break;
      }
    }
    JSON.stringify(found);
  `, TIMEOUT_LONG);
  const event = JSON.parse(raw);
  if (event && SANITIZED_CALENDARS.includes(event.calendar)) {
    event.location = null;
    event.description = null;
    event.url = null;
  }
  return event;
}

export async function createEvent(calendarName, summary, startDate, endDate, { location, description, allDay } = {}) {
  const raw = await runJxa(`
    const app = Application("Calendar");
    const cal = ${calendarName ? `app.calendars.whose({name: ${JSON.stringify(calendarName)}})[0]` : `app.calendars[0]`};
    const props = {
      summary: ${JSON.stringify(summary)},
      startDate: new Date(${JSON.stringify(startDate)}),
      endDate: new Date(${JSON.stringify(endDate)})
    };
    ${location ? `props.location = ${JSON.stringify(location)};` : ""}
    ${description ? `props.description = ${JSON.stringify(description)};` : ""}
    ${allDay ? `props.alldayEvent = true;` : ""}
    const e = app.Event(props);
    cal.events.push(e);
    JSON.stringify({ uid: e.uid(), summary: e.summary(), startDate: e.startDate().toISOString(), endDate: e.endDate().toISOString(), calendar: cal.name() });
  `, TIMEOUT_LONG);
  return JSON.parse(raw);
}

export async function deleteEvent(eventUid, calendarName) {
  await runJxa(`
    const app = Application("Calendar");
    const cals = ${calSelector(calendarName)};
    for (const cal of cals) {
      const events = cal.events.whose({uid: ${JSON.stringify(eventUid)}})();
      if (events.length > 0) {
        app.delete(events[0]);
        break;
      }
    }
    "ok";
  `, TIMEOUT_LONG);
  return "Event deleted.";
}
