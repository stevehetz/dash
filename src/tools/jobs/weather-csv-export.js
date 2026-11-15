import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createJob } from "./create-job.js";

const MACEDONIA_LAT = 41.3134;
const MACEDONIA_LON = -81.4984;
const REPORT_REL = "dashbook/data/reports/weather/macedonia_ohio.csv";
const HEADER = "date,low_temp_f,high_temp_f,conditions,humidity_pct,wind_mph,alerts,icon";

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function todayISO() {
  // Eastern Time date
  return new Date()
    .toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

async function exportWeatherCsv() {
  const apiKey = process.env.OPENWEATHER_API_KEY;
  if (!apiKey) {
    console.log("  ⏭️  weather-csv-export: OPENWEATHER_API_KEY not set, skipping");
    return;
  }
  const onedrive = process.env.ONEDRIVE_PATH;
  if (!onedrive) {
    console.log("  ⏭️  weather-csv-export: ONEDRIVE_PATH not set, skipping");
    return;
  }

  const today = todayISO();

  // Fetch current weather + forecast in parallel
  const [currentRes, forecastRes] = await Promise.all([
    fetch(
      `https://api.openweathermap.org/data/2.5/weather?lat=${MACEDONIA_LAT}&lon=${MACEDONIA_LON}&appid=${apiKey}&units=imperial`
    ),
    fetch(
      `https://api.openweathermap.org/data/2.5/forecast?lat=${MACEDONIA_LAT}&lon=${MACEDONIA_LON}&appid=${apiKey}&units=imperial`
    ),
  ]);

  if (!currentRes.ok || !forecastRes.ok) {
    throw new Error(`OpenWeatherMap API error: current=${currentRes.status} forecast=${forecastRes.status}`);
  }

  const current = await currentRes.json();
  const forecast = await forecastRes.json();

  // Extract today's high/low from forecast entries
  const todayEntries = forecast.list.filter(
    (e) => e.dt_txt.startsWith(today)
  );
  const allTemps = [current.main.temp, ...todayEntries.map((e) => e.main.temp)];
  let highTemp = Math.round(Math.max(...allTemps));
  let lowTemp = Math.round(Math.min(...allTemps));

  const conditions = current.weather[0]?.description ?? "";
  const icon = current.weather[0]?.icon ?? "";
  const humidity = current.main.humidity;
  const windMph = current.wind.speed;

  // Check for weather alerts (current API doesn't include them, but note if rain/snow)
  const alerts = "";

  // Read existing or create new
  const filePath = join(onedrive, REPORT_REL);
  await mkdir(dirname(filePath), { recursive: true });

  let existing = "";
  try {
    existing = await readFile(filePath, "utf-8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  const lines = existing ? existing.trimEnd().split("\n") : [HEADER];
  lines[0] = HEADER; // rewrite the header in case columns were added
  const idx = lines.findIndex((l) => l.startsWith(today + ","));

  // The job runs several times a day and rewrites today's row. Each run only
  // sees now plus the rest of the day, so widen the range with what we already
  // recorded — otherwise the morning low is lost by the afternoon run.
  if (idx >= 0) {
    const [, prevLow, prevHigh] = lines[idx].split(",");
    if (Number.isFinite(Number(prevLow))) lowTemp = Math.min(lowTemp, Number(prevLow));
    if (Number.isFinite(Number(prevHigh))) highTemp = Math.max(highTemp, Number(prevHigh));
  }

  const row = [today, lowTemp, highTemp, conditions, humidity, windMph, alerts, icon]
    .map(csvEscape)
    .join(",");

  if (idx >= 0) lines[idx] = row;
  else lines.push(row);
  await writeFile(filePath, lines.join("\n") + "\n", "utf-8");

  console.log(`  🌤️  weather-csv-export: ${today} → ${highTemp}°F / ${lowTemp}°F, ${conditions}`);
}

export function startWeatherCsvExport({ interval } = {}) {
  return createJob({
    name: "weather-csv-export",
    interval: interval ?? 6 * 60 * 60 * 1000,
    runOnStart: true,
    sequential: true,
    fn: exportWeatherCsv,
  });
}
