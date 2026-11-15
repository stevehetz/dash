import { llmOneShot } from "./llm/one-shot.js";

// Enough of the message being answered for the model to know what it's
// answering, without paying for a whole newsletter.
const MAX_REPLY_CONTEXT = 6000;
const MAX_BODY = 20000;
const MAX_SUBJECT = 300;

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

function buildEmailPrompt({ question, draft, reply, from, imageCount }) {
  const replyBlock = reply
    ? `He is replying to this message:
From: ${reply.from}
Subject: ${reply.subject}

${String(reply.text || "").slice(0, MAX_REPLY_CONTEXT)}

`
    : "";

  const draftBlock = `The compose form currently holds:
To: ${draft.to || "(empty)"}
Cc: ${draft.cc || "(empty)"}
Subject: ${draft.subject || "(empty)"}
Body:
${draft.body?.trim() ? draft.body : "(empty)"}

`;

  const imageIntro = imageCount
    ? `Steve attached ${imageCount} image${imageCount === 1 ? "" : "s"}. Read ${imageCount === 1 ? "it" : "them"} as part of the request — something he wants described, quoted or replied to.\n\n`
    : "";

  return `You are drafting an email for Steve, in his voice, first person. You are writing a draft only: you cannot send anything, and Steve reads and sends it himself.

Steve is sending from ${from || "his own account"}.

${replyBlock}${draftBlock}${imageIntro}Steve's instruction: ${question || "(none — work from the draft and the message above)"}

Rules:
- Plain text only. No markdown, no HTML, no asterisks for emphasis — this sends as text/plain and any markup arrives literally.
- Write the finished body, ready to send. Not a description of what could be written, and no preamble like "Here's a draft".
- Match the register of the thread — brief and direct for most things, warmer where the message he's answering is.
- Never invent a fact. No dates, times, prices, commitments, addresses or names that Steve hasn't given you here. If the email needs one he hasn't supplied, leave it as an obvious [placeholder] and say so in the note.
- If the body already has content, treat the instruction as an edit to it and keep whatever still applies.
- If the body ends in quoted text (lines beginning with ">"), leave that block exactly where it is at the bottom and write above it.
- Sign off as Steve.

Return JSON and nothing else:
{"subject": "the subject line", "body": "the full message body", "note": "one short sentence on what you did, or what you still need from him"}

If the existing subject is already right, echo it back unchanged.`;
}

/**
 * Draft or revise the body (and subject) of an email from a plain-language
 * instruction. Deliberately runs through llmOneShot, which attaches none of
 * Dash's tools: the composer's job is to produce text for Steve to read, and a
 * drafting assistant with gmail_send within reach is a drafting assistant that
 * can send mail on its own.
 */
export async function emailAssist({
  question = "",
  imagePaths = [],
  draft = {},
  reply = null,
  from = "",
  signal,
} = {}) {
  const paths = (Array.isArray(imagePaths) ? imagePaths : []).filter(Boolean);
  if (!question.trim() && !paths.length && !reply) {
    throw new Error("Tell Dash what to write, attach a photo, or both");
  }

  const raw = await llmOneShot({
    user: buildEmailPrompt({
      question: question.trim(),
      draft: draft || {},
      reply,
      from,
      imageCount: paths.length,
    }),
    images: paths,
    source: "email-assist",
    signal,
  });

  const parsed = parseJsonResponse(raw);
  return {
    subject: typeof parsed.subject === "string" ? parsed.subject.slice(0, MAX_SUBJECT) : "",
    body: typeof parsed.body === "string" ? parsed.body.slice(0, MAX_BODY) : "",
    note: typeof parsed.note === "string" ? parsed.note : "",
  };
}
