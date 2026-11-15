import { google } from "googleapis";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { createServer } from "http";

const SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/tasks",
  "https://www.googleapis.com/auth/gmail.modify",
];

const DEFAULT_TOKEN_PATH = "./config/google-token-professional.json";

/**
 * Get an authenticated OAuth2 client.
 * On first run, opens a browser for consent. Saves the token for future use.
 */
export async function getGoogleAuth(credentialsPath, { tokenPath, scopes } = {}) {
  const resolvedTokenPath = tokenPath || DEFAULT_TOKEN_PATH;
  const resolvedScopes = scopes || SCOPES;
  const credentials = JSON.parse(readFileSync(credentialsPath, "utf8"));

  // OAuth2 credentials can be in .installed or .web
  const { client_id, client_secret, redirect_uris } =
    credentials.installed || credentials.web;

  const oauth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    "http://localhost:3000"
  );

  // Check for saved token
  if (existsSync(resolvedTokenPath)) {
    const token = JSON.parse(readFileSync(resolvedTokenPath, "utf8"));
    oauth2Client.setCredentials(token);

    // Set up auto-refresh
    oauth2Client.on("tokens", (tokens) => {
      const existing = JSON.parse(readFileSync(resolvedTokenPath, "utf8"));
      const updated = { ...existing, ...tokens };
      writeFileSync(resolvedTokenPath, JSON.stringify(updated, null, 2));
    });

    return oauth2Client;
  }

  // No token — need to authorize
  const token = await authorizeInteractively(oauth2Client, resolvedScopes);
  oauth2Client.setCredentials(token);
  writeFileSync(resolvedTokenPath, JSON.stringify(token, null, 2));
  console.log("   Google token saved to", resolvedTokenPath);

  oauth2Client.on("tokens", (tokens) => {
    const existing = JSON.parse(readFileSync(resolvedTokenPath, "utf8"));
    const updated = { ...existing, ...tokens };
    writeFileSync(resolvedTokenPath, JSON.stringify(updated, null, 2));
  });

  return oauth2Client;
}

/**
 * Start a temporary local server to handle the OAuth callback.
 */
function authorizeInteractively(oauth2Client, scopes = SCOPES) {
  return new Promise((resolve, reject) => {
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: scopes,
      prompt: "consent",
    });

    console.log("\n   ===================================");
    console.log("   Google OAuth: Authorize this app");
    console.log("   ===================================");
    console.log("   Open this URL in your browser:\n");
    console.log(`   ${authUrl}\n`);

    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, "http://localhost");

        const code = url.searchParams.get("code");
        if (!code) {
          res.end("No code received");
          reject(new Error("No authorization code received"));
          return;
        }

        const { tokens } = await oauth2Client.getToken(code);
        res.end("Authorization successful! You can close this tab and go back to the terminal.");
        server.close();
        resolve(tokens);
      } catch (err) {
        res.end("Authorization failed: " + err.message);
        reject(err);
      }
    });

    server.listen(3000, () => {
      console.log("   Waiting for authorization on http://localhost:3000 ...\n");
    });

    // Timeout after 2 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("OAuth authorization timed out after 2 minutes"));
    }, 120000);
  });
}
