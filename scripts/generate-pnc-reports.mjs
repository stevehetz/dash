import { PlaidApi, PlaidEnvironments, Configuration } from "plaid";
import { writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

// Load env
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "../config/.env");
const envVars = readFileSync(envPath, "utf-8");
for (const line of envVars.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq === -1) continue;
  const key = trimmed.slice(0, eq).trim();
  let val = trimmed.slice(eq + 1).trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  process.env[key] = val;
}

const { PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ACCESS_TOKEN, PLAID_ENV, ONEDRIVE_PATH } = process.env;
const OUTPUT_DIR = `${ONEDRIVE_PATH}/dashbook/data/reports/pnc`;

const client = new PlaidApi(
  new Configuration({
    basePath: PlaidEnvironments[PLAID_ENV || "production"],
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": PLAID_CLIENT_ID,
        "PLAID-SECRET": PLAID_SECRET,
      },
    },
  })
);

async function fetchAllTransactions(startDate, endDate) {
  const all = [];
  let offset = 0;
  let total = null;
  let accounts = null;

  while (total === null || all.length < total) {
    const { data } = await client.transactionsGet({
      access_token: PLAID_ACCESS_TOKEN,
      start_date: startDate,
      end_date: endDate,
      options: { count: 500, offset },
    });

    if (accounts === null) accounts = data.accounts;
    total = data.total_transactions;
    all.push(...data.transactions);
    offset += data.transactions.length;

    console.log(`  Fetched ${all.length} / ${total}`);
    if (data.transactions.length === 0) break;
  }

  return { transactions: all, accounts };
}

function escapeCSV(val) {
  if (val == null) return "";
  const str = String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCSV(rows) {
  const headers = ["date", "account", "account_type", "name", "merchant", "amount", "category", "subcategory", "pending"];
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCSV(row[h])).join(","));
  }
  return lines.join("\n") + "\n";
}

const months = [
  ["2026-01-01", "2026-01-31"],
  ["2026-02-01", "2026-02-28"],
  ["2026-03-01", "2026-03-31"],
];

for (const [start, end] of months) {
  const month = start.slice(0, 7); // e.g. 2025-01
  const label = month.replace("-", "."); // e.g. 2025.01
  console.log(`\nFetching ${month}...`);

  const { transactions, accounts } = await fetchAllTransactions(start, end);

  const accountMap = Object.fromEntries(accounts.map((a) => [a.account_id, a]));

  const rows = transactions
    .filter((t) => !t.pending)
    .map((t) => {
      const acct = accountMap[t.account_id];
      return {
        date: t.date,
        account: acct?.name ?? "",
        account_type: acct?.subtype ?? "",
        name: t.name,
        merchant: t.merchant_name ?? "",
        amount: t.amount,
        category: t.personal_finance_category?.primary ?? "",
        subcategory: t.personal_finance_category?.detailed ?? "",
        pending: t.pending,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  const csv = toCSV(rows);
  const outPath = `${OUTPUT_DIR}/pnc-${label}.csv`;  // e.g. pnc-2026.01.csv
  await writeFile(outPath, csv, "utf-8");
  console.log(`  Wrote ${rows.length} transactions → ${outPath}`);
}

console.log("\nDone.");
