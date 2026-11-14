/**
 * One-time Plaid Link setup script.
 *
 * Spins up a local HTTP server with the Plaid Link widget and an HTTPS
 * server for the OAuth redirect. After linking, it prints the
 * access_token to add to your .env file.
 *
 * Usage: node scripts/plaid-link.js
 */

import dotenv from "dotenv";
dotenv.config({ path: new URL("../config/.env", import.meta.url) });
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { PlaidApi, PlaidEnvironments, Configuration, Products, CountryCode } from "plaid";

const CLIENT_ID = process.env.PLAID_CLIENT_ID;
const SECRET = process.env.PLAID_SECRET;
const ENV = process.env.PLAID_ENV || "sandbox";
const HTTP_PORT = 3456;
const HTTPS_PORT = 3457;
const REDIRECT_URI = `https://localhost:${HTTPS_PORT}/oauth`;

if (!CLIENT_ID || !SECRET) {
  console.error("Missing PLAID_CLIENT_ID or PLAID_SECRET in .env");
  process.exit(1);
}

const client = new PlaidApi(
  new Configuration({
    basePath: PlaidEnvironments[ENV],
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": CLIENT_ID,
        "PLAID-SECRET": SECRET,
      },
    },
  })
);

const HTML = (linkToken) => `<!DOCTYPE html>
<html>
<head>
  <title>Plaid Link Setup</title>
  <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
  <style>
    body { font-family: -apple-system, sans-serif; max-width: 500px; margin: 80px auto; text-align: center; }
    button { padding: 12px 24px; font-size: 16px; background: #0052ff; color: white; border: none; border-radius: 8px; cursor: pointer; }
    button:hover { background: #003ecf; }
    #status { margin-top: 20px; color: #666; }
    .success { color: #0a8; font-weight: bold; }
    pre { text-align: left; font-size: 12px; background: #f5f5f5; padding: 10px; border-radius: 4px; overflow: auto; }
  </style>
</head>
<body>
  <h2>Connect Your Bank Account</h2>
  <p>Click below to link your bank account via Plaid.</p>
  <button id="link-btn">Connect Bank Account</button>
  <div id="status"></div>
  <script>
    const handler = Plaid.create({
      token: '${linkToken}',
      onSuccess: async (publicToken, metadata) => {
        document.getElementById('status').innerHTML = 'Exchanging token...';
        const res = await fetch('/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ public_token: publicToken }),
        });
        const data = await res.json();
        document.getElementById('status').innerHTML =
          '<p class="success">Linked successfully!</p>' +
          '<p>Access token has been printed to your terminal.<br>Add it to your .env as PLAID_ACCESS_TOKEN.</p>';
        document.getElementById('link-btn').disabled = true;
      },
      onExit: (err, metadata) => {
        console.log('Plaid Link exit:', JSON.stringify({ err, metadata }, null, 2));
        if (err) document.getElementById('status').innerHTML = 'Error: ' + err.error_code + ' — ' + err.display_message + '<br><pre>' + JSON.stringify(err, null, 2) + '</pre>';
      },
      onEvent: (eventName, metadata) => {
        console.log('Plaid event:', eventName, JSON.stringify(metadata, null, 2));
        if (eventName === 'ERROR') document.getElementById('status').innerHTML = '<pre>' + JSON.stringify(metadata, null, 2) + '</pre>';
      },
    });
    document.getElementById('link-btn').addEventListener('click', () => handler.open());
  </script>
</body>
</html>`;

// OAuth redirect page — served over HTTPS, re-initializes Link to finish
const OAUTH_HTML = (linkToken) => `<!DOCTYPE html>
<html>
<head>
  <title>Plaid Link - Completing...</title>
  <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
  <style>
    body { font-family: -apple-system, sans-serif; max-width: 500px; margin: 80px auto; text-align: center; }
    .success { color: #0a8; font-weight: bold; }
    #status { margin-top: 20px; color: #666; }
  </style>
</head>
<body>
  <h2>Completing bank connection...</h2>
  <div id="status">Please wait...</div>
  <script>
    const handler = Plaid.create({
      token: '${linkToken}',
      receivedRedirectUri: window.location.href,
      onSuccess: async (publicToken, metadata) => {
        document.getElementById('status').innerHTML = 'Exchanging token...';
        const res = await fetch('/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ public_token: publicToken }),
        });
        const data = await res.json();
        document.getElementById('status').innerHTML =
          '<p class="success">Linked successfully!</p>' +
          '<p>Access token has been printed to your terminal.<br>Add it to your .env as PLAID_ACCESS_TOKEN.</p>';
      },
      onExit: (err) => {
        if (err) document.getElementById('status').innerHTML = 'Error: ' + err.display_message;
      },
    });
    handler.open();
  </script>
</body>
</html>`;

function shutdown() {
  console.log("Shutting down link server.");
  process.exit(0);
}

async function main() {
  const linkConfig = {
    user: { client_user_id: "steve" },
    client_name: "Dash",
    products: [Products.Transactions],
    country_codes: [CountryCode.Us],
    language: "en",
  };

  if (ENV === "production") {
    linkConfig.redirect_uri = REDIRECT_URI;
  }

  const { data } = await client.linkTokenCreate(linkConfig);

  const linkToken = data.link_token;
  console.log(`\n🔗 Plaid Link ready (${ENV} mode)`);
  console.log(`   Open http://localhost:${HTTP_PORT} in your browser\n`);

  // HTTP server for main page + exchange endpoint
  const httpHandler = async (req, res) => {
    const url = new URL(req.url, `http://localhost:${HTTP_PORT}`);

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(HTML(linkToken));
    } else if (req.method === "POST" && url.pathname === "/exchange") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const { public_token } = JSON.parse(body);
          const { data: exchangeData } = await client.itemPublicTokenExchange({
            public_token,
          });

          console.log("\n✅ Bank account linked successfully!");
          console.log(`\n   PLAID_ACCESS_TOKEN=${exchangeData.access_token}\n`);
          console.log("   Add this to your config/.env file, then restart Dash.\n");

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
          setTimeout(shutdown, 5000);
        } catch (err) {
          console.error("Exchange error:", err.response?.data || err.message);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  };

  createHttpServer(httpHandler).listen(HTTP_PORT);

  // HTTPS server for OAuth redirect only (production)
  if (ENV === "production") {
    const sslOpts = {
      key: readFileSync(new URL("./plaid-key.pem", import.meta.url)),
      cert: readFileSync(new URL("./plaid-cert.pem", import.meta.url)),
    };

    const httpsHandler = async (req, res) => {
      const url = new URL(req.url, `https://localhost:${HTTPS_PORT}`);

      if (url.pathname === "/oauth") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(OAUTH_HTML(linkToken));
      } else if (req.method === "POST" && url.pathname === "/exchange") {
        // Same exchange handler for HTTPS
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", async () => {
          try {
            const { public_token } = JSON.parse(body);
            const { data: exchangeData } = await client.itemPublicTokenExchange({
              public_token,
            });

            console.log("\n✅ Bank account linked successfully!");
            console.log(`\n   PLAID_ACCESS_TOKEN=${exchangeData.access_token}\n`);
            console.log("   Add this to your config/.env file, then restart Dash.\n");

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true }));
            setTimeout(shutdown, 5000);
          } catch (err) {
            console.error("Exchange error:", err.response?.data || err.message);
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    };

    createHttpsServer(sslOpts, httpsHandler).listen(HTTPS_PORT);
    console.log(`   OAuth redirect server on https://localhost:${HTTPS_PORT}\n`);
  }
}

main().catch((err) => {
  if (err.response?.data) {
    console.error("Failed to start:", JSON.stringify(err.response.data, null, 2));
  } else {
    console.error("Failed to start:", err.message);
  }
  process.exit(1);
});
