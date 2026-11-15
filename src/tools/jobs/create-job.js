/**
 * Creates a scheduled job that runs a function on an interval.
 *
 * Options:
 *   name        — display name for logging
 *   interval    — milliseconds between runs
 *   fn          — async function to execute
 *   runOnStart  — run immediately on start (default: false)
 *   sequential  — prevent overlapping runs (default: false)
 *   activeHours — { start, end, timezone } to restrict when the job runs
 *
 * Returns a stop() function.
 */
export function createJob({ name, interval, fn, runOnStart = false, sequential = false, activeHours }) {
  let running = false;

  const isActive = () => {
    if (!activeHours) return true;
    const now = new Date();
    const local = new Date(now.toLocaleString("en-US", { timeZone: activeHours.timezone }));
    const hour = local.getHours();
    return hour >= activeHours.start && hour < activeHours.end;
  };

  const execute = async () => {
    if (!isActive()) return;
    if (sequential && running) return;
    running = true;
    try {
      await fn();
    } catch (err) {
      // Network errors (node-fetch FetchError) often carry an empty reason —
      // the useful bit is the code (ETIMEDOUT, ECONNRESET, ENOTFOUND…).
      const code = err.code || err.cause?.code;
      console.error(`  ❌ Job "${name}" failed:`, err.message + (code ? ` [${code}]` : ""));
    } finally {
      running = false;
    }
  };

  if (runOnStart) execute();
  const id = setInterval(execute, interval);

  const label = interval >= 60000 ? `${interval / 60000}m` : `${interval / 1000}s`;
  console.log(`   ⏰ Job "${name}": every ${label}`);

  return () => clearInterval(id);
}
