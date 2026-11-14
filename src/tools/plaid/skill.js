import { PlaidApi, PlaidEnvironments, Configuration } from "plaid";

const tools = [
  {
    name: "plaid_get_balances",
    description:
      "Get current account balances for Steve's linked bank accounts (checking, savings, credit cards).",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "plaid_get_transactions",
    description:
      "Get recent bank transactions. Can filter by date range. Returns the most recent transactions first.",
    input_schema: {
      type: "object",
      properties: {
        start_date: {
          type: "string",
          description:
            "Start date in YYYY-MM-DD format. Defaults to 30 days ago.",
        },
        end_date: {
          type: "string",
          description: "End date in YYYY-MM-DD format. Defaults to today.",
        },
        count: {
          type: "number",
          description: "Max number of transactions to return. Defaults to 25.",
        },
      },
      required: [],
    },
  },
  {
    name: "plaid_search_transactions",
    description:
      "Search bank transactions by merchant name, category, or amount. Searches the last 90 days.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Search term to match against merchant name or category (case-insensitive).",
        },
        min_amount: {
          type: "number",
          description: "Minimum transaction amount (absolute value).",
        },
        max_amount: {
          type: "number",
          description: "Maximum transaction amount (absolute value).",
        },
        count: {
          type: "number",
          description: "Max results to return. Defaults to 25.",
        },
      },
      required: [],
    },
  },
];

const systemPrompt = `

## Banking / Finance
- Transaction amounts: **positive = money spent, negative = deposit or credit.**
- Keep financial answers concise — the useful figures, not every field.
`;

function createHandler() {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  const accessToken = process.env.PLAID_ACCESS_TOKEN;

  if (!clientId || !secret || !accessToken) {
    return async () =>
      "Plaid not configured — missing PLAID_CLIENT_ID, PLAID_SECRET, or PLAID_ACCESS_TOKEN env vars.";
  }

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

  return async (toolName, toolInput) => {
    switch (toolName) {
      case "plaid_get_balances": {
        // Use transactionsGet to fetch account balances — the balance product
        // isn't enabled, but accounts come back with balances in this response.
        const now = new Date();
        const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
        const { data } = await client.transactionsGet({
          access_token: accessToken,
          start_date: weekAgo.toISOString().split("T")[0],
          end_date: now.toISOString().split("T")[0],
          options: { count: 1, offset: 0 },
        });

        const accounts = data.accounts.map((a) => ({
          name: a.name,
          official_name: a.official_name,
          type: a.type,
          subtype: a.subtype,
          current: a.balances.current,
          available: a.balances.available,
          limit: a.balances.limit,
          currency: a.balances.iso_currency_code,
        }));

        return JSON.stringify(accounts, null, 2);
      }

      case "plaid_get_transactions": {
        const now = new Date();
        const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

        const startDate =
          toolInput.start_date || thirtyDaysAgo.toISOString().split("T")[0];
        const endDate =
          toolInput.end_date || now.toISOString().split("T")[0];
        const count = toolInput.count || 25;

        const { data } = await client.transactionsGet({
          access_token: accessToken,
          start_date: startDate,
          end_date: endDate,
          options: { count, offset: 0 },
        });

        const transactions = data.transactions.map((t) => ({
          date: t.date,
          name: t.name,
          merchant: t.merchant_name,
          amount: t.amount,
          category: t.personal_finance_category?.primary,
          subcategory: t.personal_finance_category?.detailed,
          account: data.accounts.find((a) => a.account_id === t.account_id)
            ?.name,
          pending: t.pending,
        }));

        return JSON.stringify(
          { total: data.total_transactions, transactions },
          null,
          2
        );
      }

      case "plaid_search_transactions": {
        const now = new Date();
        const ninetyDaysAgo = new Date(now - 90 * 24 * 60 * 60 * 1000);

        const startDate = ninetyDaysAgo.toISOString().split("T")[0];
        const endDate = now.toISOString().split("T")[0];

        // Fetch up to 500 transactions to search through
        const { data } = await client.transactionsGet({
          access_token: accessToken,
          start_date: startDate,
          end_date: endDate,
          options: { count: 500, offset: 0 },
        });

        let results = data.transactions;
        const query = toolInput.query?.toLowerCase();
        const maxResults = toolInput.count || 25;

        if (query) {
          results = results.filter(
            (t) =>
              t.name?.toLowerCase().includes(query) ||
              t.merchant_name?.toLowerCase().includes(query) ||
              t.personal_finance_category?.primary
                ?.toLowerCase()
                .includes(query) ||
              t.personal_finance_category?.detailed
                ?.toLowerCase()
                .includes(query)
          );
        }

        if (toolInput.min_amount != null) {
          results = results.filter(
            (t) => Math.abs(t.amount) >= toolInput.min_amount
          );
        }
        if (toolInput.max_amount != null) {
          results = results.filter(
            (t) => Math.abs(t.amount) <= toolInput.max_amount
          );
        }

        const transactions = results.slice(0, maxResults).map((t) => ({
          date: t.date,
          name: t.name,
          merchant: t.merchant_name,
          amount: t.amount,
          category: t.personal_finance_category?.primary,
          account: data.accounts.find((a) => a.account_id === t.account_id)
            ?.name,
        }));

        return JSON.stringify(
          { matches: transactions.length, transactions },
          null,
          2
        );
      }
    }
  };
}

export default { name: "plaid", tools, systemPrompt, createHandler };
