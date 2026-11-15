import { createJob } from "./create-job.js";

/**
 * Polls the dashbot.assistant@gmail.com inbox for new unread emails
 * and processes them through the agent, just like a Telegram or voice message.
 */
export function startInboxPoll({ dashbotGmailManager, agent, userId, deliver, interval }) {
  if (!dashbotGmailManager) {
    console.log("   ⏭️  Inbox poll skipped (dashbot Gmail not configured)");
    return () => {};
  }

  const processedIds = new Set();
  let initialized = false;

  return createJob({
    name: "inbox-poll",
    interval: interval ?? 30 * 1000, // every 30 seconds
    runOnStart: true,
    sequential: true,
    async fn() {
      const messages = await dashbotGmailManager.listMessages({
        query: "is:unread",
        maxResults: 10,
      });

      if (!initialized) {
        // First run: seed the set so we don't process old unread emails
        for (const msg of messages) {
          processedIds.add(msg.id);
        }
        initialized = true;
        console.log(`   📬 Inbox poll initialized (${messages.length} existing unread)`);
        return;
      }

      const newMessages = messages.filter((msg) => !processedIds.has(msg.id));
      if (newMessages.length === 0) return;

      for (const msg of newMessages) {
        processedIds.add(msg.id);

        // Fetch full email content
        const full = await dashbotGmailManager.getMessage(msg.id);
        const from = full.from || "Unknown sender";
        const subject = full.subject || "(no subject)";
        const body = full.body || "";

        // Mark as read so we don't keep picking it up
        await dashbotGmailManager.markAsRead(msg.id).catch(() => {});

        // Feed the email to the agent as a system-contextualized message
        const prompt = `[System: You received an email at dashbot.assistant@gmail.com. Process it like a normal message from Steve. If it asks you to do things, do them. Respond naturally.]\n\nFrom: ${from}\nSubject: ${subject}\n\n${body}`;

        // No history passed — each email is answered on its own, not as part of
        // Steve's running conversation.
        const response = await agent.chat(`${userId}_email`, prompt);

        // Deliver the agent's response
        if (response && response !== "Done! (no text response)") {
          if (response.length <= 4096) {
            await deliver(response);
          } else {
            const chunks = response.match(/[\s\S]{1,4000}/g) || [response];
            for (const chunk of chunks) {
              await deliver(chunk);
            }
          }
        }

        console.log(`   📬 Processed email from ${from}: "${subject}"`);
      }

      // Prune processedIds to prevent unbounded growth
      const currentIds = new Set(messages.map((m) => m.id));
      for (const id of processedIds) {
        if (!currentIds.has(id)) processedIds.delete(id);
      }
    },
  });
}
