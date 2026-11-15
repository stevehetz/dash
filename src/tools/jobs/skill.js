import { readFile, stat } from "node:fs/promises";
import { startReminderCleanup } from "./reminder-cleanup.js";
import { startTasksSnapshot } from "./tasks-snapshot.js";
import { startCalendarCache } from "./calendar-cache.js";
import { startInboxPoll } from "./inbox-poll.js";
import { startEmailDig } from "./email-dig.js";
import { startDynamicJobsRunner } from "./dynamic-jobs-runner.js";
import { startPncCsvExport } from "./pnc-csv-export.js";
import { startWeatherCsvExport } from "./weather-csv-export.js";
import { startCalendarHistoryExport } from "./calendar-history-export.js";
import { startCalendarPlannerSync } from "./calendar-planner-sync.js";

const SYSTEM_CONFIG_PATHS = [
  `${process.env.ONEDRIVE_PATH}/dashbook/dash/config/JOBS_SYSTEM.json`,
  `${process.env.ONEDRIVE_PATH}/dashbook/dash/config/jobs_system.json`,
];

const tools = [];
const systemPrompt = "";

function createHandler() {
  return async () => {};
}

// strict: throw on a missing/unparseable file instead of falling back to
// defaults — used by the live poll, so a half-synced file can't re-enable jobs.
async function readSystemConfig({ strict = false } = {}) {
  try {
    let configPath = SYSTEM_CONFIG_PATHS[0];
    for (const path of SYSTEM_CONFIG_PATHS) {
      try {
        const info = await stat(path);
        if (info.isFile()) {
          configPath = path;
          break;
        }
      } catch {}
    }
    const raw = await readFile(configPath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    if (strict) throw err;
    return { jobs: {} };
  }
}

function isEnabled(jobs, name) {
  return jobs[name]?.enabled !== false;
}

function getInterval(jobs, name) {
  const seconds = jobs[name]?.interval;
  return seconds != null ? seconds * 1000 : undefined;
}

// How often to check JOBS_SYSTEM.json for changes. A stat per tick is cheap,
// and polling (unlike fs.watch) is reliable on the OneDrive-synced folder.
const CONFIG_POLL_MS = 10 * 1000;

/**
 * Start all system background jobs.
 * Reads JOBS_SYSTEM.json to determine which jobs are enabled, then keeps
 * watching it: toggling a job or changing its interval in the file (e.g. from
 * the dashapp's System page) stops/starts just that job — no bot restart.
 * Called by index.js after the bot is ready.
 */
async function start({ agent, userId, bot, deliver, googleCalendarManager, dashbotGmailManager, gmailManager, personalGmailManager }) {
  // Order matters on boot: tasks-snapshot runs ahead of reminder-cleanup, since
  // the snapshot is what preserves completed tasks before cleanup deletes them.
  const starters = {
    "tasks-snapshot": (interval) => startTasksSnapshot({ interval }),
    "reminder-cleanup": (interval) => startReminderCleanup({ interval }),
    "calendar-cache": (interval) => startCalendarCache({ googleCalendarManager, interval }),
    "inbox-poll": (interval) => startInboxPoll({ dashbotGmailManager, agent, userId, deliver, interval }),
    "email-dig": (interval) => startEmailDig({ gmailManager, personalGmailManager, userId, deliver, interval }),
    "dynamic-jobs": (interval) => startDynamicJobsRunner(agent, userId, deliver, interval),
    "pnc-csv-export": (interval) => startPncCsvExport({ interval }),
    "weather-csv-export": (interval) => startWeatherCsvExport({ interval }),
    "calendar-history": (interval) => startCalendarHistoryExport({ interval }),
    "calendar-planner-sync": (interval) => startCalendarPlannerSync({ interval }),
  };

  // name -> { stop, key }, where key captures the settings it was started with.
  const running = new Map();

  function apply(jobs, { log }) {
    for (const [name, startJob] of Object.entries(starters)) {
      const enabled = isEnabled(jobs, name);
      const interval = getInterval(jobs, name);
      const key = `${enabled}:${interval ?? "default"}`;
      const current = running.get(name);
      if (current?.key === key) continue;

      if (current) {
        current.stop();
        running.delete(name);
      }
      if (enabled) {
        running.set(name, { stop: startJob(interval), key });
        if (log) console.log(`   🔁 Job "${name}" ${current ? "restarted" : "started"} (config change)`);
      } else if (log && current) {
        console.log(`   ⏹️  Job "${name}" stopped (config change)`);
      }
    }
  }

  let lastRaw = JSON.stringify(await readSystemConfig());
  apply(JSON.parse(lastRaw).jobs || {}, { log: false });

  const poll = setInterval(async () => {
    let config;
    try {
      config = await readSystemConfig({ strict: true });
    } catch {
      return; // unreadable mid-sync; keep current jobs and retry next tick
    }
    const raw = JSON.stringify(config);
    if (raw === lastRaw) return;
    lastRaw = raw;
    apply(config.jobs || {}, { log: true });
  }, CONFIG_POLL_MS);

  return () => {
    clearInterval(poll);
    for (const { stop } of running.values()) stop();
    running.clear();
  };
}

export default { name: "jobs", tools, systemPrompt, createHandler, start };
