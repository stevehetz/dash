/**
 * File helper — the Ask Dash panel on the dashapp's Library tab.
 *
 * The Library is whatever file is open in its browser. This module answers
 * questions about that file and, when asked for a change, returns the whole
 * rewritten file for review.
 *
 * Nothing is written here. A proposed file comes back to the dashapp, is
 * editable there, and is saved through the ordinary save endpoint once Steve
 * applies it.
 */
import { codexP } from "./llm/codex-p.js";

function parseJsonResponse(text) {
  let s = String(text || "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Model did not return a JSON object");
  }
  return JSON.parse(s.slice(start, end + 1));
}

// The prompt fences the file between marker lines, and a model handed an empty
// file has been known to copy a marker into its answer as if it were content.
// The prompt says not to; this makes sure one can't reach the file either way.
// Only ever at the edges — a marker in the middle would be Steve's own text.
const MARKER_RE = /^\s*(-{4,}8<-{4,}.*|<{2,}\/?FILE|FILE|```[a-z]*)\s*$/i;

function stripPromptMarkers(text) {
  const lines = String(text).split("\n");
  while (lines.length && MARKER_RE.test(lines[0])) lines.shift();
  while (lines.length && MARKER_RE.test(lines[lines.length - 1])) lines.pop();
  return lines.join("\n");
}


// Run a built prompt through whichever backend is configured and pull the
// {answer, content} pair out of it. `content` is only ever a proposal — a
// rewrite identical to what's on disk isn't one, since there'd be nothing for
// Steve to approve, and neither is anything at all when the file can't be
// edited.
async function runAssist({ prompt, paths, source, content, editable = true, signal }) {
  let raw = await codexP(prompt, {
    dashTools: true,
    imagePaths: paths,
    timeoutMs: 5 * 60 * 1000,
    source,
    signal,
  });

  const parsed = parseJsonResponse(raw);
  const proposed = editable && typeof parsed.content === "string" ? stripPromptMarkers(parsed.content) : null;
  return {
    answer: typeof parsed.answer === "string" ? parsed.answer : String(parsed.answer ?? ""),
    content: proposed === null || proposed === content ? null : proposed,
  };
}

function nowParts() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
  };
}

function requireQuestion(question, paths) {
  if (!question.trim() && !paths.length) {
    throw new Error("Ask a question, attach a photo, or both");
  }
}

// The Library's Ask Dash sees whatever its browser has open, which is one of
// three situations: a text file it could also rewrite, a file it can only look
// at (an image or a PDF), or nothing at all. Each gets its own account of what
// the model is actually holding — a prompt that claims a file is present when
// none is invites an answer made up about it.
function buildLibraryPrompt({ file, content, kind, listing, question, imageCount, date, time }) {
  const imageIntro = imageCount
    ? `Steve attached ${imageCount} image${imageCount === 1 ? "" : "s"}. Read ${imageCount === 1 ? "it" : "them"} as part of the request.\n\n`
    : "";

  const context = !file
    ? `NOTHING IS OPEN
No file is selected in the browser. These are the files there are, by path:
${listing}

Answer from the paths alone — say which file you'd look in, and ask him to open
it if the answer needs what's inside. Never guess at a file's contents.`
    : kind === "text"
      ? `THE FILE AS IT STANDS
Its exact contents sit between the two marker lines below. The markers are this
prompt's punctuation, not part of the file — never carry one into your output.
--------8<-------- begin ${file} --------8<--------
${content}
--------8<-------- end ${file} --------8<--------
${content.trim() ? "" : "\nThe file is empty. Whatever you return is its entire contents.\n"}`
      : kind === "image"
        ? `THE FILE
${file} — an image, attached to this request. It is what he's looking at.
It cannot be edited from here, so propose no change to it: "content" is null.`
        : `THE FILE
${file} — a ${kind}. Its contents are not available to you and it cannot be
edited from here, so answer from its name and location, and say plainly when
that isn't enough. "content" is null.`;

  const changeRules = file && kind === "text"
    ? `- When he asks for a change, make it and return the complete file with the change in it. Never return a fragment, a patch, or only the part you touched.
- Change only what he asked you to change. Every other line comes through byte for byte: same wording, same order, same blank lines, same capitalization, same shorthand.
- Do not tidy, reword, sort, reformat, or "improve" anything he did not ask about. His shape and his phrasing are deliberate.
- Keep the file's format: a CSV stays a valid CSV with its header, JSON stays valid JSON, markdown keeps its headings.
- "content" is the file's own text and nothing else — no marker lines, no heading naming the file, no preamble, no code fence around it.`
    : `- Return null for "content". Nothing here is editable.`;

  return `You are Steve's assistant for his dashbook — the folder of notes, data, reports and images behind his dashboard. He is on its Library page${file ? `, looking at ${file}` : ""}.

${imageIntro}REQUEST FROM STEVE
${question || "(no text — work from the attached images)"}

RIGHT NOW
${date} ${time}

${context}

HOW TO WORK
- Answer what he actually asked. A question about what's in the file is answered from what's above and changes nothing.
${changeRules}
- Do not invent items, details, or facts.

OUTPUT
Return ONLY a JSON object — no markdown fence around the whole thing, no commentary outside it:
{
  "answer": string,           // markdown; short. What you did, or the answer to his question.
  "content": string | null    // the complete new file, or null when nothing should change
}`;
}

/**
 * The Library page's Ask Dash: a question about the file its browser has open,
 * and, for a text file, that file rewritten with a requested change. Writes
 * nothing — a proposal comes back for review and is saved through
 * /api/library/save.
 *
 * @param {object} opts
 * @param {string}   [opts.question]   Steve's prompt.
 * @param {string[]} [opts.imagePaths] Photos he attached.
 * @param {string}   [opts.file]       Path of the open file, relative to
 *                                     dashbook/. Empty when nothing is open.
 * @param {string}   [opts.content]    The file as it stands, for a text file.
 * @param {"text"|"image"|"PDF"|"file"} [opts.kind] What the open file is.
 * @param {string}   [opts.openImagePath] The open file itself, when it's an
 *                                     image the model can be handed.
 * @param {string}   [opts.listing]    Every library path, one per line — used
 *                                     only when nothing is open.
 * @param {AbortSignal} [opts.signal]  Cancel the run — kills the model process.
 */
export async function libraryAssist({
  question = "",
  imagePaths = [],
  file = "",
  content = "",
  kind = "text",
  openImagePath = "",
  listing = "",
  signal,
} = {}) {
  const attachments = (Array.isArray(imagePaths) ? imagePaths : []).filter(Boolean);
  requireQuestion(question, attachments);

  const prompt = buildLibraryPrompt({
    file,
    content,
    kind,
    listing,
    question: question.trim(),
    // His own photos only — the open file is described by the prompt itself,
    // and counting it here would have the model looking for one photo too many.
    imageCount: attachments.length,
    ...nowParts(),
  });

  return runAssist({
    prompt,
    // The open image rides along last, so it lands after his attachments in
    // the order the prompt describes them.
    paths: openImagePath ? [...attachments, openImagePath] : attachments,
    source: "library-assist",
    content,
    editable: Boolean(file) && kind === "text",
    signal,
  });
}
