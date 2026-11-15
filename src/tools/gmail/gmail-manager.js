import { google } from "googleapis";

// Gmail hands back a page of ids and nothing else, so a 200-row inbox is 200
// more calls. These two keep that affordable: a bounded number in flight at
// once, and a back-off for the rate limit that fanning out invites.
const HARD_RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const RATE_LIMIT_REASONS = /rateLimitExceeded|userRateLimitExceeded|quotaExceeded|backendError/i;

function isRetryable(err) {
  const status = err?.code ?? err?.response?.status;
  if (HARD_RETRY_STATUS.has(status)) return true;
  // A 403 is usually permanent (wrong scope, no access) — only the rate-limit
  // flavour of it is worth a second go, so it's matched by reason, not status.
  if (status !== 403) return false;
  const reasons = err?.errors?.map((e) => e.reason).join(" ") || err?.message || "";
  return RATE_LIMIT_REASONS.test(reasons);
}

async function withRetry(fn, attempts = 4) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts - 1 || !isRetryable(err)) throw err;
      await new Promise((r) => setTimeout(r, 250 * 2 ** i + Math.random() * 200));
    }
  }
}

/** Run `fn` over every item with at most `limit` outstanding at a time. */
async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function decodeBody(data) {
  return Buffer.from(data, "base64url").toString("utf-8");
}

/**
 * Mail headers are ASCII. A subject with an accent, a dash or an emoji in it
 * has to travel as an RFC 2047 encoded-word or it arrives as mojibake — which
 * only started mattering once a person could type one into the composer.
 */
function encodeHeaderValue(value) {
  const s = value || "";
  if (!/[^\x20-\x7E]/.test(s)) return s;
  return `=?utf-8?B?${Buffer.from(s, "utf-8").toString("base64")}?=`;
}

/**
 * RFC 2369's List-Unsubscribe: a comma-separated list of <URI>s, each a mailto:
 * or an https: endpoint. RFC 8058's List-Unsubscribe-Post is the sender saying
 * the https one takes a POST and needs no confirmation page — that's the only
 * case that can be done in one click without landing on their website.
 *
 * Plain http is ignored on purpose: an unsubscribe URL identifies the reader,
 * and that shouldn't travel in the clear.
 */
function parseUnsubscribe(header, postHeader) {
  if (!header) return null;
  let uris = [...header.matchAll(/<([^>]+)>/g)].map((m) => m[1].trim());
  // The RFC wants <angle brackets>, and enough senders skip them — Microsoft
  // among them — that a bare URI has to be read too, or their mail quietly
  // loses the button. Only as a fallback: a bracketed header is unambiguous,
  // and splitting that one on commas would break a URI containing one.
  if (!uris.length) uris = header.split(",").map((s) => s.trim()).filter(Boolean);
  const url = uris.find((u) => /^https:\/\//i.test(u)) || null;
  const mailto = uris.find((u) => /^mailto:/i.test(u)) || null;
  if (!url && !mailto) return null;
  return { url, mailto, oneClick: !!url && /one-click/i.test(postHeader || "") };
}

/** Base64 wrapped at 76 chars, which is what a MIME body part requires. */
function base64Lines(text) {
  return (Buffer.from(text, "utf-8").toString("base64").match(/.{1,76}/g) || []).join("\r\n");
}

/**
 * Walk a payload for the parts worth showing. Mail nests — a multipart/mixed
 * holding a multipart/alternative holding the text and the HTML is the normal
 * shape — so this recurses rather than reading the top level and stopping.
 */
function collectParts(part, acc = { text: "", html: "", attachments: [] }) {
  if (!part) return acc;
  const mime = (part.mimeType || "").toLowerCase();
  const data = part.body?.data;
  if (part.filename && part.body?.attachmentId) {
    acc.attachments.push({
      filename: part.filename,
      mimeType: part.mimeType || "",
      size: part.body.size || 0,
    });
  } else if (data && mime === "text/plain") {
    acc.text += decodeBody(data);
  } else if (data && mime === "text/html") {
    acc.html += decodeBody(data);
  }
  for (const child of part.parts || []) collectParts(child, acc);
  return acc;
}

export class GmailManager {
  constructor(auth) {
    this.gmail = google.gmail({ version: "v1", auth });
    this.userEmail = null;
  }

  async _getUserEmail() {
    if (!this.userEmail) {
      const profile = await this.gmail.users.getProfile({ userId: "me" });
      this.userEmail = profile.data.emailAddress;
    }
    return this.userEmail;
  }

  async listMessages({ query, maxResults = 10, labelIds } = {}) {
    const params = {
      userId: "me",
      maxResults,
    };
    if (query) params.q = query;
    if (labelIds) params.labelIds = labelIds;

    const res = await this.gmail.users.messages.list(params);
    const messages = res.data.messages || [];

    // Fetch details for each message
    const detailed = await Promise.all(
      messages.map((m) => this._getMessageSummary(m.id))
    );
    return detailed;
  }

  /** The address this manager is signed in as, for labelling a view of it. */
  async getEmailAddress() {
    return this._getUserEmail();
  }

  /**
   * A deep slice of a label — the inbox by default — for reading rather than
   * for the agent: `listMessages` fetches its rows in one unbounded
   * `Promise.all`, which is fine for ten and a rate-limit error for two
   * hundred. Rows that fail their own fetch are dropped rather than failing
   * the batch: a partial inbox beats none.
   */
  async listInbox({ maxResults = 200, labelIds = ["INBOX"], query, concurrency = 8 } = {}) {
    const ids = [];
    let pageToken;
    while (ids.length < maxResults) {
      const params = { userId: "me", maxResults: Math.min(500, maxResults - ids.length) };
      if (labelIds) params.labelIds = labelIds;
      if (query) params.q = query;
      if (pageToken) params.pageToken = pageToken;

      const res = await withRetry(() => this.gmail.users.messages.list(params));
      for (const m of res.data.messages || []) ids.push(m.id);
      pageToken = res.data.nextPageToken;
      if (!pageToken) break;
    }

    const rows = await mapWithConcurrency(ids.slice(0, maxResults), concurrency, (id) =>
      withRetry(() => this._getMessageSummary(id)).catch(() => null)
    );
    return rows.filter(Boolean);
  }

  /**
   * `includeHtml` is off by default on purpose: the agent reads this straight
   * into its context, and an HTML body is often 20x the text one. Only the
   * dashapp's reader, which renders it, asks for it.
   */
  async getMessage(messageId, { includeHtml = false } = {}) {
    const res = await withRetry(() => this.gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    }));
    return this._parseMessage(res.data, { includeHtml });
  }

  async searchMessages(query, maxResults = 10) {
    return this.listMessages({ query, maxResults });
  }

  async sendMessage({ to, subject, body, cc, bcc, replyToMessageId }) {
    const from = await this._getUserEmail();
    const headers = [
      `From: ${from}`,
      `To: ${to}`,
    ];
    if (cc) headers.push(`Cc: ${cc}`);
    if (bcc) headers.push(`Bcc: ${bcc}`);
    headers.push(`Subject: ${encodeHeaderValue(subject)}`);

    // If replying, add threading headers
    let threadId;
    if (replyToMessageId) {
      const original = await this.gmail.users.messages.get({
        userId: "me",
        id: replyToMessageId,
        format: "metadata",
        metadataHeaders: ["Message-ID", "Subject"],
      });
      const messageIdHeader = original.data.payload.headers.find(
        (h) => h.name.toLowerCase() === "message-id"
      );
      if (messageIdHeader) {
        headers.push(`In-Reply-To: ${messageIdHeader.value}`);
        headers.push(`References: ${messageIdHeader.value}`);
      }
      threadId = original.data.threadId;
    }

    // The body goes out base64 rather than raw 8-bit: an em dash or an emoji
    // typed into the composer is otherwise an out-of-range octet in a message
    // that claims to be 7-bit, and what the recipient sees is mojibake.
    headers.push("MIME-Version: 1.0");
    headers.push("Content-Type: text/plain; charset=utf-8");
    headers.push("Content-Transfer-Encoding: base64");
    headers.push("");
    headers.push(base64Lines(body || ""));

    const raw = Buffer.from(headers.join("\r\n")).toString("base64url");

    const params = { userId: "me", requestBody: { raw } };
    if (threadId) params.requestBody.threadId = threadId;

    const res = await this.gmail.users.messages.send(params);
    return {
      id: res.data.id,
      threadId: res.data.threadId,
      to,
      subject,
    };
  }

  async trashMessage(messageId) {
    await this.gmail.users.messages.trash({ userId: "me", id: messageId });
    return { trashed: messageId };
  }

  /** Add or drop the UNREAD label. Opening a message in the reader clears it. */
  async setRead(messageId, read) {
    await withRetry(() => this.gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: read ? { removeLabelIds: ["UNREAD"] } : { addLabelIds: ["UNREAD"] },
    }));
    return { id: messageId, unread: !read };
  }

  async markAsRead(messageId) {
    await this.setRead(messageId, true);
    return { markedRead: messageId };
  }

  async listLabels() {
    const res = await this.gmail.users.labels.list({ userId: "me" });
    return (res.data.labels || []).map((l) => ({
      id: l.id,
      name: l.name,
      type: l.type,
    }));
  }

  // ── Internal helpers ──

  async _getMessageSummary(messageId) {
    const res = await this.gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "metadata",
      metadataHeaders: ["From", "To", "Subject", "Date"],
    });

    const headers = res.data.payload.headers;
    const get = (name) => headers.find((h) => h.name === name)?.value || "";

    return {
      id: res.data.id,
      threadId: res.data.threadId,
      from: get("From"),
      to: get("To"),
      subject: get("Subject"),
      date: get("Date"),
      // Gmail's own receipt time, in ms. The Date header is whatever the sender
      // wrote — missing, malformed and wrong are all common — so sorting and
      // grouping go by this instead.
      internalDate: Number(res.data.internalDate) || null,
      snippet: res.data.snippet,
      unread: (res.data.labelIds || []).includes("UNREAD"),
      labels: res.data.labelIds || [],
    };
  }

  _parseMessage(data, { includeHtml = false } = {}) {
    const headers = data.payload.headers || [];
    const get = (name) =>
      headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";

    const { text, html, attachments } = collectParts(data.payload);
    // Plain text when the sender provided it, the HTML source when they didn't
    // — same preference as before, now found however deep it's nested.
    const body = text || html;

    const message = {
      id: data.id,
      threadId: data.threadId,
      from: get("From"),
      to: get("To"),
      cc: get("Cc"),
      replyTo: get("Reply-To"),
      subject: get("Subject"),
      date: get("Date"),
      internalDate: Number(data.internalDate) || null,
      snippet: data.snippet || "",
      body: body.substring(0, 50000), // truncate for token limits
      attachments,
      unread: (data.labelIds || []).includes("UNREAD"),
      labels: data.labelIds || [],
    };
    // `body` collapses text and HTML into one field for the agent. The reader
    // needs them apart: HTML to render, and the *real* plain text — not the
    // markup standing in for it — to quote into a reply.
    if (includeHtml) {
      message.html = html.substring(0, 2_000_000);
      message.text = text.substring(0, 50000);
      message.unsubscribe = parseUnsubscribe(
        get("List-Unsubscribe"),
        get("List-Unsubscribe-Post"),
      );
    }
    return message;
  }
}
