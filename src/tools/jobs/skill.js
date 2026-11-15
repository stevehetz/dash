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

async function readSystemConfig() {
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
  } catch {
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

/**
 * Start all system background jobs.
 * Reads JOBS_SYSTEM.json to determine which jobs are enabled.
 * Called by index.js after the bot is ready.
 */
async function start({ agent, userId, bot, deliver, googleCalendarManager, dashbotGmailManager, gmailManager, personalGmailManager }) {
  const config = await readSystemConfig();
  const jobs = config.jobs || {};
  const stops = [];

  // Ahead of reminder-cleanup: the snapshot is what preserves completed tasks
  // before cleanup deletes them.
  if (isEnabled(jobs, "tasks-snapshot")) stops.push(startTasksSnapshot({ interval: getInterval(jobs, "tasks-snapshot") }));
  if (isEnabled(jobs, "reminder-cleanup")) stops.push(startReminderCleanup({ interval: getInterval(jobs, "reminder-cleanup") }));
  if (isEnabled(jobs, "calendar-cache")) stops.push(startCalendarCache({ googleCalendarManager, interval: getInterval(jobs, "calendar-cache") }));
  if (isEnabled(jobs, "inbox-poll")) stops.push(startInboxPoll({ dashbotGmailManager, agent, userId, deliver, interval: getInterval(jobs, "inbox-poll") }));
  if (isEnabled(jobs, "email-dig")) stops.push(startEmailDig({ gmailManager, personalGmailManager, userId, deliver, interval: getInterval(jobs, "email-dig") }));
  if (isEnabled(jobs, "dynamic-jobs")) stops.push(startDynamicJobsRunner(agent, userId, deliver, getInterval(jobs, "dynamic-jobs")));
  if (isEnabled(jobs, "pnc-csv-export")) stops.push(startPncCsvExport({ interval: getInterval(jobs, "pnc-csv-export") }));
  if (isEnabled(jobs, "weather-csv-export")) stops.push(startWeatherCsvExport({ interval: getInterval(jobs, "weather-csv-export") }));
  if (isEnabled(jobs, "calendar-history")) stops.push(startCalendarHistoryExport({ interval: getInterval(jobs, "calendar-history") }));
  if (isEnabled(jobs, "calendar-planner-sync")) stops.push(startCalendarPlannerSync({ interval: getInterval(jobs, "calendar-planner-sync") }));

  return () => stops.forEach((stop) => stop());
}

export default { name: "jobs", tools, systemPrompt, createHandler, start };
