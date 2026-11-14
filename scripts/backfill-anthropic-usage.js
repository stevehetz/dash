#!/usr/bin/env node
// One-time script to backfill historical Anthropic usage data.
// Usage: node scripts/backfill-anthropic-usage.js
import dotenv from "dotenv";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config({ path: new URL("../config/.env", import.meta.url) });

const adminKey = process.env.ANTHROPIC_ADMIN_KEY;
if (!adminKey) { console.error("ANTHROPIC_ADMIN_KEY not set"); process.exit(1); }

const ONEDRIVE = process.env.ONEDRIVE_PATH;
const usageFile = join(ONEDRIVE, "dashbook", "data", "reports", "anthropic", "usage.json");

const headers = { "anthropic-version": "2023-06-01", "x-api-key": adminKey };

async function fetchMonth(year, month) {
  const m = String(month).padStart(2, "0");
  let ey = year, em = month + 1;
  if (em > 12) { em = 1; ey++; }
  const start = `${year}-${m}-01T00:00:00Z`;
  const end = `${ey}-${String(em).padStart(2, "0")}-01T00:00:00Z`;
  console.log(`Fetching ${year}-${m}...`);
  const r = await fetch(
    `https://api.anthropic.com/v1/organizations/cost_report?starting_at=${start}&ending_at=${end}&bucket_width=1d&limit=31`,
    { headers }
  );
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`HTTP ${r.status}: ${body}`);
  }
  const d = await r.json();
  return d.data.map(b => ({
    date: b.starting_at.slice(0, 10),
    cents: b.results.reduce((a, r) => a + parseFloat(r.amount), 0),
  }));
}

async function main() {
  let stored = {};
  try { stored = JSON.parse(await readFile(usageFile, "utf8")); } catch {}

  // Backfill months that have no data yet. Adjust range as needed.
  const now = new Date();
  const curYear = now.getUTCFullYear();
  const curMonth = now.getUTCMonth() + 1;

  // Go back 12 months
  for (let i = 11; i >= 0; i--) {
    let y = curYear, m = curMonth - i;
    while (m <= 0) { m += 12; y--; }
    const key = `${y}-${String(m).padStart(2, "0")}`;
    if (stored[key] && stored[key].length > 0) {
      // Skip current month (always re-fetch) but keep completed months
      if (key === `${curYear}-${String(curMonth).padStart(2, "0")}`) continue;
      console.log(`  ${key}: already stored (${stored[key].length} days), skipping`);
      continue;
    }
    try {
      const days = await fetchMonth(y, m);
      const total = days.reduce((s, d) => s + d.cents, 0);
      if (total > 0) {
        stored[key] = days;
        console.log(`  ${key}: ${days.length} days, $${(total / 100).toFixed(2)}`);
      } else {
        console.log(`  ${key}: no data`);
      }
    } catch (err) {
      console.error(`  ${key}: ERROR ${err.message}`);
      if (err.message.includes("429")) {
        console.error("Rate limited — try again later.");
        break;
      }
    }
  }

  await mkdir(join(ONEDRIVE, "dashbook", "data", "reports", "anthropic"), { recursive: true }).catch(() => {});
  await writeFile(usageFile, JSON.stringify(stored, null, 2));
  console.log(`Saved to ${usageFile}`);
}

main().catch(console.error);
