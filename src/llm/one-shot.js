import { codexP } from "./codex-p.js";

/**
 * Run a simple text-in / text-out prompt with no Dash tools attached. Used by the
 * small helpers (TTS summarization, email triage) that only need the model itself.
 *
 * @param {object} opts
 * @param {string} [opts.system]   Prepended to the user content.
 * @param {string} opts.user       User content.
 * @param {string} [opts.model]    Model hint; Codex uses its configured default
 *                                 unless CODEX_MODEL names one explicitly.
 * @param {string[]} [opts.images] Local image file paths to attach.
 * @param {string} [opts.source]   Tag for the usage log.
 * @param {AbortSignal} [opts.signal] Cancel the run.
 * @returns {Promise<string>}
 */
export async function llmOneShot({ system = "", user, model, images = [], source = "one-shot", signal }) {
  const prompt = system ? `${system}\n\n${user}` : user;
  return codexP(prompt, { model, source, imagePaths: images, signal });
}
