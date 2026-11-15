import { Resend } from "resend";

const tools = [
  {
    name: "send_email",
    description:
      "Send an email from dash@dashbot.dev using Resend. Supports plain text and HTML bodies.",
    input_schema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description:
            "Recipient email address(es). Comma-separated for multiple recipients.",
        },
        subject: {
          type: "string",
          description: "Email subject line.",
        },
        body: {
          type: "string",
          description: "Plain text email body.",
        },
        html: {
          type: "string",
          description: "HTML email body. Optional — if omitted, plain text body is used.",
        },
        cc: {
          type: "string",
          description: "CC recipients (comma-separated). Optional.",
        },
        bcc: {
          type: "string",
          description: "BCC recipients (comma-separated). Optional.",
        },
        reply_to: {
          type: "string",
          description: "Reply-to email address. Optional.",
        },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "dashbot_inbox_list",
    description:
      "List recent emails in the dash@dashbot.dev inbox. Can filter by Gmail search query.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Gmail search query (e.g. 'is:unread', 'from:someone@example.com'). Omit to list recent emails.",
        },
        max_results: {
          type: "number",
          description: "Max number of emails to return. Default 10.",
        },
      },
    },
  },
  {
    name: "dashbot_inbox_read",
    description: "Read the full content of an email in the dash@dashbot.dev inbox by message ID.",
    input_schema: {
      type: "object",
      properties: {
        message_id: {
          type: "string",
          description: "The Gmail message ID (from dashbot_inbox_list or dashbot_inbox_search).",
        },
      },
      required: ["message_id"],
    },
  },
  {
    name: "dashbot_inbox_search",
    description:
      "Search emails in the dash@dashbot.dev inbox using Gmail search syntax.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Gmail search query (e.g. 'from:alice subject:receipt').",
        },
        max_results: {
          type: "number",
          description: "Max results to return. Default 10.",
        },
      },
      required: ["query"],
    },
  },
];

const systemPrompt = `

## Email (dash@dashbot.dev)
- Default recipient is stevehetzel2@gmail.com.
- Send when asked; don't ask for confirmation first.
- In Telegram, report only that it was sent — never the full email body.
- dashbot_inbox_* reads mail sent TO dash@dashbot.dev. That is not Steve's personal mail, which is gmail_* / personal_gmail_*.
`;

function createHandler({ dashbotGmailManager }) {
  const resend = new Resend(process.env.RESEND_API_KEY);

  return async (toolName, toolInput) => {
    switch (toolName) {
      case "send_email": {
        const split = (s) => s ? s.split(",").map((e) => e.trim()) : undefined;

        const { data, error } = await resend.emails.send({
          from: "Dash <dash@dashbot.dev>",
          to: split(toolInput.to),
          subject: toolInput.subject,
          text: toolInput.body,
          html: toolInput.html || undefined,
          cc: split(toolInput.cc),
          bcc: split(toolInput.bcc),
          reply_to: toolInput.reply_to || undefined,
        });

        if (error) {
          return JSON.stringify({ error }, null, 2);
        }
        return JSON.stringify({ success: true, id: data.id }, null, 2);
      }
      case "dashbot_inbox_list": {
        if (!dashbotGmailManager) return "Dashbot inbox not configured. Run the OAuth flow for dashbot.assistant@gmail.com first.";
        const messages = await dashbotGmailManager.listMessages({
          query: toolInput.query,
          maxResults: toolInput.max_results,
        });
        return JSON.stringify(messages, null, 2);
      }
      case "dashbot_inbox_read": {
        if (!dashbotGmailManager) return "Dashbot inbox not configured. Run the OAuth flow for dashbot.assistant@gmail.com first.";
        const message = await dashbotGmailManager.getMessage(toolInput.message_id);
        return JSON.stringify(message, null, 2);
      }
      case "dashbot_inbox_search": {
        if (!dashbotGmailManager) return "Dashbot inbox not configured. Run the OAuth flow for dashbot.assistant@gmail.com first.";
        const results = await dashbotGmailManager.searchMessages(
          toolInput.query,
          toolInput.max_results,
        );
        return JSON.stringify(results, null, 2);
      }
    }
  };
}

export default { name: "email", tools, systemPrompt, createHandler };
