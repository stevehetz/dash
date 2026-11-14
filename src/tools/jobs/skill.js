import { readFile, stat } from "node:fs/promises";
import { startDynamicJobsRunner } from "./dynamic-jobs-runner.js";
import { startPncCsvExport } from "./pnc-csv-export.js";

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
async function start({ agent, userId, deliver }) {
  const config = await readSystemConfig();
  const jobs = config.jobs || {};
  const stops = [];

  if (isEnabled(jobs, "dynamic-jobs")) stops.push(startDynamicJobsRunner(agent, userId, deliver, getInterval(jobs, "dynamic-jobs")));
  if (isEnabled(jobs, "pnc-csv-export")) stops.push(startPncCsvExport({ interval: getInterval(jobs, "pnc-csv-export") }));

  return () => stops.forEach((stop) => stop());
}

export default { name: "jobs", tools, systemPrompt, createHandler, start };
