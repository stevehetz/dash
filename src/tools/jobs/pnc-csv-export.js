import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createJob } from "./create-job.js";
import { PlaidApi, PlaidEnvironments, Configuration } from "plaid";

const COLUMNS = [
  "date",
  "account",
  "account_type",
  "name",
  "merchant",
  "amount",
  "category",
  "subcategory",
  "pending",
  "exclude",
];

// Primary categories that represent internal transfers between accounts.
const EXCLUDE_PRIMARY = new Set(["TRANSFER_IN", "TRANSFER_OUT"]);

// Credit-card payoff line ("thank you for your payment") on the CC side.
// Other LOAN_PAYMENTS subcategories on the CC — mortgage, Third Federal,
// etc. — are real external spend and stay visible.
const EXCLUDE_SUBCATEGORY_CREDIT = new Set(["LOAN_PAYMENTS_CREDIT_CARD_PAYMENT"]);

// On depository accounts, treat all LOAN_PAYMENTS as internal CC payments —
// Plaid often tags the checking-side payoff as LOAN_PAYMENTS_OTHER_PAYMENT
// rather than _CREDIT_CARD_PAYMENT, so subcategory alone isn't enough.
const EXCLUDE_SUBCATEGORY_DEPOSITORY = new Set([
  "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
  "LOAN_PAYMENTS_OTHER_PAYMENT",
]);

// Pending CC payments often arrive miscategorized — Plaid doesn't fully tag
// personal_finance_category until the transaction posts. Catch the obvious
// shapes by transaction name as a fallback.
//
// Depository side: "ONLINE PAYMENT TO *3005" / "ONLINE PAYMENT TO XXXXX3005"
const EXCLUDE_NAME_PATTERN_DEPOSITORY = /^\s*ONLINE\s+PAYMENT\s+TO\s+(?:X{3,}|\*+)\d+/i;
// Credit side: bare "PAYMENT", or PNC's "THANK YOU FOR YOUR PMT MM /DD XXXXNNNN"
// receipt (Plaid sometimes mis-tags this as INCOME_SALARY instead of LOAN_PAYMENTS).
const EXCLUDE_NAME_PATTERN_CREDIT = /^\s*(?:PAYMENT\s*$|THANK\s+YOU\s+FOR\s+YOUR\s+PMT\b)/i;

// Transfers that are real external payments and must stay visible even though
// Plaid tags them TRANSFER_OUT. Matched against transaction name; `merchant`
// is used as the display label when Plaid gives none.
const KEEP_OVERRIDES = [
  // Monthly mortgage ACH from checking to Third Federal (THFSLA SV WEBXFR).
  { pattern: /\bTHFSLA\b/i, merchant: "Third Federal Mortgage" },
];

function keepOverride(t) {
  const name = t.name || "";
  return KEEP_OVERRIDES.find((o) => o.pattern.test(name)) || null;
}

function shouldExclude(t, acct) {
  if (keepOverride(t)) return false;
  const category = t.personal_finance_category?.primary;
  const subcategory = t.personal_finance_category?.detailed;
  const isDepository = acct?.type === "depository";
  const subExcludes = isDepository
    ? EXCLUDE_SUBCATEGORY_DEPOSITORY
    : EXCLUDE_SUBCATEGORY_CREDIT;
  if (EXCLUDE_PRIMARY.has(category)) return true;
  if (subExcludes.has(subcategory)) return true;
  const name = t.name || "";
  if (isDepository && EXCLUDE_NAME_PATTERN_DEPOSITORY.test(name)) return true;
  if (!isDepository && EXCLUDE_NAME_PATTERN_CREDIT.test(name)) return true;
  return false;
}

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function txnToRow(t, accountMap) {
  const acct = accountMap.get(t.account_id);
  const category = t.personal_finance_category?.primary;
  const subcategory = t.personal_finance_category?.detailed;
  const exclude = shouldExclude(t, acct);
  return [
    t.date,
    acct?.name ?? "",
    acct?.type ?? "",
    t.name,
    t.merchant_name || keepOverride(t)?.merchant,
    t.amount,
    category,
    subcategory,
    t.pending,
    exclude,
  ]
    .map(csvEscape)
    .join(",");
}

function createPlaidClient() {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  const accessToken = process.env.PLAID_ACCESS_TOKEN;

  if (!clientId || !secret || !accessToken) return null;

  const env = process.env.PLAID_ENV || "production";
  const client = new PlaidApi(
    new Configuration({
      basePath: PlaidEnvironments[env],
      baseOptions: {
        headers: {
          "PLAID-CLIENT-ID": clientId,
          "PLAID-SECRET": secret,
        },
      },
    })
  );

  return { client, accessToken };
}

async function fetchAllTransactions(client, accessToken, startDate, endDate) {
  const txns = [];
  let offset = 0;
  const batchSize = 250;

  while (true) {
    const { data } = await client.transactionsGet({
      access_token: accessToken,
      start_date: startDate,
      end_date: endDate,
      options: { count: batchSize, offset },
    });

    txns.push(...data.transactions);

    // Build account map from first response (accounts are the same each call)
    const accountMap =
      txns.accountMap ??
      new Map(data.accounts.map((a) => [a.account_id, a]));
    txns.accountMap = accountMap;

    if (txns.length >= data.total_transactions) break;
    offset += batchSize;
  }

  return { transactions: txns, accountMap: txns.accountMap };
}

const round = (n) => Math.round(n * 100) / 100;

const INCOME_LABELS = {
  INCOME_SALARY: "Salary",
  INCOME_CONTRACTOR: "Contractor",
  INCOME_INTEREST_EARNED: "Interest",
  INCOME_DIVIDENDS: "Dividends",
  INCOME_OTHER_INCOME: "Other Income",
};

function buildSummary(transactions, accountMap) {
  const incomeItems = new Map();
  const expenseItems = new Map();
  let totalIncome = 0;
  let totalExpenses = 0;

  for (const t of transactions) {
    const category = t.personal_finance_category?.primary;
    const subcategory = t.personal_finance_category?.detailed;
    const acct = accountMap.get(t.account_id);
    if (shouldExclude(t, acct)) continue;

    const amount = t.amount;
    const label =
      t.merchant_name ||
      keepOverride(t)?.merchant ||
      INCOME_LABELS[subcategory] ||
      t.name ||
      "(unknown)";

    if (amount < 0 && category === "INCOME") {
      const abs = Math.abs(amount);
      incomeItems.set(label, (incomeItems.get(label) || 0) + abs);
      totalIncome += abs;
    } else if (amount > 0) {
      expenseItems.set(label, (expenseItems.get(label) || 0) + amount);
      totalExpenses += amount;
    }
  }

  const sortDesc = (m) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, total]) => ({ name, total: round(total) }));

  return {
    income: sortDesc(incomeItems),
    totalIncome: round(totalIncome),
    expenses: sortDesc(expenseItems),
    totalExpenses: round(totalExpenses),
    profit: round(totalIncome - totalExpenses),
  };
}

const TRAILING_MONTHS = 0;

async function exportPncCsv() {
  const onedrive = process.env.ONEDRIVE_PATH;
  if (!onedrive) {
    console.log("  ⏭️  pnc-csv-export: ONEDRIVE_PATH not set, skipping");
    return;
  }

  const plaid = createPlaidClient();
  if (!plaid) {
    console.log("  ⏭️  pnc-csv-export: Plaid not configured, skipping");
    return;
  }

  const now = new Date();
  const dir = join(onedrive, "dashbook/data/reports/pnc");
  await mkdir(dir, { recursive: true });

  for (let i = TRAILING_MONTHS; i >= 0; i--) {
    const target = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const year = target.getFullYear();
    const month = String(target.getMonth() + 1).padStart(2, "0");

    const startDate = `${year}-${month}-01`;
    const monthEnd = new Date(year, target.getMonth() + 1, 0);
    const endDate = (i === 0 ? now : monthEnd).toISOString().split("T")[0];

    const { transactions, accountMap } = await fetchAllTransactions(
      plaid.client,
      plaid.accessToken,
      startDate,
      endDate
    );

    transactions.sort((a, b) => a.date.localeCompare(b.date));

    const rows = transactions.map((t) => txnToRow(t, accountMap));
    const out = [COLUMNS.join(","), ...rows].join("\n") + "\n";

    const csvPath = join(dir, `pnc-${year}.${month}.csv`);
    await writeFile(csvPath, out, "utf-8");

    const summary = buildSummary(transactions, accountMap);
    const summaryPath = join(dir, `pnc-${year}.${month}-summary.json`);
    await writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf-8");

    console.log(
      `  💰 pnc-csv-export: ${transactions.length} transactions → pnc-${year}.${month}.csv`
    );
  }
}

export function startPncCsvExport({ interval } = {}) {
  return createJob({
    name: "pnc-csv-export",
    interval: interval ?? 6 * 60 * 60 * 1000, // every 6 hours
    runOnStart: true,
    sequential: true,
    fn: exportPncCsv,
  });
}
