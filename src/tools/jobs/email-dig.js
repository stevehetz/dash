import { llmOneShot } from "../../llm/one-shot.js";
import { createJob } from "./create-job.js";

async function runTriage(systemPrompt, userContent) {
  let text = (await llmOneShot({
    system: systemPrompt,
    user: userContent,
    model: "haiku",
    maxTokens: 2048,
    source: "email-dig",
  })) || "{}";
  text = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) text = jsonMatch[0];
  return { triage: JSON.parse(text), via: "claude" };
}

const DIGEST_PROMPT = `You are an email triage assistant for Steve. You'll receive a batch of unread emails from one of Steve's Gmail accounts. For each email, decide:

1. **Needs attention** — leave UNREAD. These are emails from real people who expect a reply, or things Steve genuinely needs to act on (e.g. a friend/family member writing, a question from someone, a bill that's due, a meeting invite requiring response, something unusual or unexpected).
2. **Auto-read** — mark as READ. Most automated/transactional emails fall here:
   - Delivery/shipping notifications and order confirmations (Amazon, DoorDash, etc.)
   - Return confirmations, refund notices, return label emails
   - Payment receipts and transaction confirmations (PayPal, Venmo, etc.)
   - Security alerts and login notifications (Google, Apple, etc.)
   - Marketing, promotions, newsletters, social media notifications
   - Account linking reminders, verification emails
   - Subscription receipts, app notifications
   - Emails with deadlines that are just informational (e.g. "drop off by April 22") — Steve can see these in his email if needed
   - Basically anything from a no-reply address or automated system
   - ANY email from a company/service/brand — even if it mentions a deadline or action

The bar for "needs attention" is HIGH — only keep unread if Steve personally needs to do something or a real human is reaching out. When in doubt, mark as read. Steve wants a clean inbox.

Respond with valid JSON only, no markdown fences. Format:
{
  "results": [
    { "id": "message_id", "action": "keep_unread" | "mark_read", "summary": "one-line summary" }
  ]
}`;

/**
 * Polls Steve's personal and professional Gmail inboxes every N minutes,
 * triages unread emails via Claude directly (no agent), marks trivial ones as read,
 * and sends a Telegram digest only when emails need attention.
 */
export function startEmailDig({ gmailManager, personalGmailManager, userId, deliver, interval }) {
  const accounts = [];
  if (gmailManager) accounts.push({ name: "stevehetzel2@gmail.com", label: "Professional", manager: gmailManager });
  if (personalGmailManager) accounts.push({ name: "shetzel84@gmail.com", label: "Personal", manager: personalGmailManager });

  if (accounts.length === 0) {
    console.log("   ⏭️  Email dig skipped (no Gmail accounts configured)");
    return () => {};
  }

  const processedIds = new Map(accounts.map((a) => [a.name, new Set()]));

  return createJob({
    name: "email-dig",
    interval: interval ?? 10 * 60 * 1000,
    runOnStart: true,
    sequential: true,
    async fn() {
      const digestLines = [];

      for (const account of accounts) {
        try {
          const messages = await account.manager.listMessages({ query: "is:unread", maxResults: 20 });
          const seen = processedIds.get(account.name);
          const newMessages = messages.filter((msg) => !seen.has(msg.id));
          if (messages.length === 0 && newMessages.length === 0) continue;
          console.log(`   📧 ${account.label}: ${messages.length} unread, ${newMessages.length} new`);
          if (newMessages.length === 0) continue;

          for (const msg of newMessages) seen.add(msg.id);

          const fullMessages = await Promise.all(
            newMessages.map(async (msg) => {
              try {
                const full = await account.manager.getMessage(msg.id);
                return {
                  id: msg.id,
                  from: full.from || "Unknown",
                  subject: full.subject || "(no subject)",
                  date: full.date || "",
                  body: (full.body || "").substring(0, 2000),
                };
              } catch {
                return { id: msg.id, from: msg.from, subject: msg.subject, date: msg.date, body: msg.snippet || "" };
              }
            })
          );

          const emailList = fullMessages
            .map((m, i) => `--- Email ${i + 1} (id: ${m.id}) ---\nFrom: ${m.from}\nSubject: ${m.subject}\nDate: ${m.date}\n\n${m.body}`)
            .join("\n\n");

          let triage;
          let via;
          try {
            ({ triage, via } = await runTriage(DIGEST_PROMPT, `Account: ${account.name}\n\n${emailList}`));
          } catch (err) {
            console.error(`  ⚠️ Email dig: triage failed for ${account.name}:`, err.message);
            continue;
          }

          const results = triage.results || [];
          const keptUnread = [];
          const markedRead = [];

          for (const result of results) {
            if (result.action === "mark_read") {
              await account.manager.markAsRead(result.id).catch(() => {});
              markedRead.push(result);
            } else {
              keptUnread.push(result);
            }
          }

          console.log(`   📧 ${account.label}: ${keptUnread.length} need attention, ${markedRead.length} auto-read (via ${via})`);

          if (keptUnread.length > 0 || markedRead.length > 0) {
            digestLines.push(`\n*${account.label}* (${account.name}):`);

            if (keptUnread.length > 0) {
              digestLines.push(`  _Needs your attention (${keptUnread.length}):_`);
              for (const r of keptUnread) digestLines.push(`  • ${r.summary}`);
            }

            if (markedRead.length > 0) {
              digestLines.push(`  _Auto-read (${markedRead.length}):_`);
              for (const r of markedRead) digestLines.push(`  • ${r.summary}`);
            }
          }

          // Prune old processed IDs
          const currentIds = new Set(messages.map((m) => m.id));
          for (const id of seen) {
            if (!currentIds.has(id)) seen.delete(id);
          }
        } catch (err) {
          console.error(`  ❌ Email dig error for ${account.name}:`, err.message);
        }
      }

      if (digestLines.length > 0) {
        const message = `📧 *Email Digest*\n${digestLines.join("\n")}`;
        await deliver(message);
      }
    },
  });
}
