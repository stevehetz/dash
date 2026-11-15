import dotenv from "dotenv";
import { applyBackendEnv } from "./llm/backend.js";
dotenv.config({ path: new URL("../config/.env", import.meta.url) });
applyBackendEnv();
import { FileManager } from "./tools/onedrive/file-manager.js";
import { GmailManager } from "./tools/gmail/gmail-manager.js";
import { getGoogleAuth } from "./utils/google-auth.js";

/**
 * Initialize all services from env vars.
 * Returns { fileManager, gmailManager, dashbotGmailManager, personalGmailManager }.
 */
export async function createServices() {
  const ONEDRIVE_PATH = process.env.ONEDRIVE_PATH;
  const GOOGLE_CREDENTIALS_PATH = process.env.GOOGLE_CREDENTIALS_PATH;

  const fileManager = ONEDRIVE_PATH ? new FileManager(ONEDRIVE_PATH) : null;

  let gmailManager = null;
  let dashbotGmailManager = null;
  let personalGmailManager = null;

  if (GOOGLE_CREDENTIALS_PATH) {
    const auth = await getGoogleAuth(GOOGLE_CREDENTIALS_PATH);
    gmailManager = new GmailManager(auth);

    // Dashbot Gmail (dashbot.assistant@gmail.com) — only needs Gmail scope
    try {
      const dashbotAuth = await getGoogleAuth(GOOGLE_CREDENTIALS_PATH, {
        tokenPath: "./config/google-token-dashbot.json",
        scopes: ["https://www.googleapis.com/auth/gmail.modify"],
      });
      dashbotGmailManager = new GmailManager(dashbotAuth);
    } catch (err) {
      console.log("  ⏭️  Dashbot Gmail not configured (run OAuth flow for dashbot.assistant@gmail.com)");
    }

    // Personal Gmail (shetzel84@gmail.com) — only needs Gmail scope
    try {
      const personalAuth = await getGoogleAuth(GOOGLE_CREDENTIALS_PATH, {
        tokenPath: "./config/google-token-personal.json",
        scopes: ["https://www.googleapis.com/auth/gmail.modify"],
      });
      personalGmailManager = new GmailManager(personalAuth);
    } catch (err) {
      console.log("  ⏭️  Personal Gmail not configured (run OAuth flow for shetzel84@gmail.com)");
    }
  }

  return { fileManager, gmailManager, dashbotGmailManager, personalGmailManager };
}
