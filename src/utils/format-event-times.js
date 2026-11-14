const TZ = "America/New_York";

const dateTimeFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  weekday: "short",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const timeFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

function formatLocal(value) {
  if (!value) return null;
  // All-day Google events come through as "YYYY-MM-DD" (no T) — leave as-is.
  if (typeof value === "string" && !value.includes("T")) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return dateTimeFmt.format(d);
}

function formatLocalTimeOnly(value) {
  if (!value || (typeof value === "string" && !value.includes("T"))) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return timeFmt.format(d);
}

/**
 * Add ET-formatted local-time fields to calendar event objects so models
 * don't have to do timezone math on raw ISO strings.
 *
 * Adds: startLocal, endLocal (full date+time in America/New_York),
 *       startTimeLocal, endTimeLocal (time-only convenience fields).
 *
 * Preserves the original start/end (or startDate/endDate) ISO fields.
 */
export function withLocalTimes(events) {
  if (!Array.isArray(events)) return events;
  return events.map((e) => {
    const start = e.start ?? e.startDate;
    const end = e.end ?? e.endDate;
    return {
      ...e,
      startLocal: formatLocal(start),
      endLocal: formatLocal(end),
      startTimeLocal: formatLocalTimeOnly(start),
      endTimeLocal: formatLocalTimeOnly(end),
    };
  });
}
