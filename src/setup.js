import dotenv from "dotenv";
import { applyBackendEnv } from "./llm/backend.js";
dotenv.config({ path: new URL("../config/.env", import.meta.url) });
applyBackendEnv();
import { FileManager } from "./tools/onedrive/file-manager.js";

/**
 * Initialize all services from env vars.
 * Returns { fileManager }.
 */
export async function createServices() {
  const ONEDRIVE_PATH = process.env.ONEDRIVE_PATH;
  const fileManager = ONEDRIVE_PATH ? new FileManager(ONEDRIVE_PATH) : null;

  return { fileManager };
}
