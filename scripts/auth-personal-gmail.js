#!/usr/bin/env node
/**
 * Run the OAuth flow for Steve's personal Gmail (shetzel84@gmail.com).
 * This creates config/google-token-personal.json.
 *
 * Usage: node scripts/auth-personal-gmail.js
 *
 * It will print a URL — open it in a browser, sign in with shetzel84@gmail.com,
 * and authorize. The token will be saved automatically.
 */
import dotenv from "dotenv";
dotenv.config({ path: new URL("../config/.env", import.meta.url) });

import { getGoogleAuth } from "../src/utils/google-auth.js";

const credentialsPath = process.env.GOOGLE_CREDENTIALS_PATH;
if (!credentialsPath) {
  console.error("GOOGLE_CREDENTIALS_PATH not set in .env");
  process.exit(1);
}

console.log("Starting OAuth flow for shetzel84@gmail.com...");
console.log("Make sure to sign in with the PERSONAL account (shetzel84@gmail.com).\n");

try {
  await getGoogleAuth(credentialsPath, {
    tokenPath: "./config/google-token-personal.json",
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
  });
  console.log("\n✅ Personal Gmail token saved to config/google-token-personal.json");
  console.log("Restart Dash: pm2 restart dash");
} catch (err) {
  console.error("❌ Auth failed:", err.message);
  process.exit(1);
}
