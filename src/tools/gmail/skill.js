const personalTools = [
  {
    name: "personal_gmail_list_messages",
    description:
      "List recent emails from Steve's personal Gmail (shetzel84@gmail.com). Can filter by Gmail search query.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Gmail search query. Examples: 'is:unread', 'from:boss@work.com', 'newer_than:1d', 'subject:meeting'. Omit to list recent emails.",
        },
        max_results: {
          type: "number",
          description: "Max number of emails to return. Default 10.",
        },
      },
    },
  },
  {
    name: "personal_gmail_read_message",
    description: "Read the full content of an email from Steve's personal Gmail (shetzel84@gmail.com).",
    input_schema: {
      type: "object",
      properties: {
        message_id: {
          type: "string",
          description: "The Gmail message ID.",
        },
      },
      required: ["message_id"],
    },
  },
  {
    name: "personal_gmail_search",
    description:
      "Search emails in Steve's personal Gmail (shetzel84@gmail.com) using Gmail search syntax.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Gmail search query.",
        },
        max_results: {
          type: "number",
          description: "Max results to return. Default 10.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "personal_gmail_send",
    description: "Send an email from Steve's personal Gmail (shetzel84@gmail.com).",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address." },
        subject: { type: "string", description: "Email subject line." },
        body: { type: "string", description: "Email body text." },
        cc: { type: "string", description: "CC recipients (comma-separated). Optional." },
        bcc: { type: "string", description: "BCC recipients (comma-separated). Optional." },
        reply_to_message_id: {
          type: "string",
          description: "Message ID to reply to. Optional.",
        },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "personal_gmail_trash",
    description: "Move an email to the trash in Steve's personal Gmail (shetzel84@gmail.com).",
    input_schema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "The message ID to trash." },
      },
      required: ["message_id"],
    },
  },
  {
    name: "personal_gmail_mark_read",
    description: "Mark an email as read in Steve's personal Gmail (shetzel84@gmail.com).",
    input_schema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "The message ID to mark as read." },
      },
      required: ["message_id"],
    },
  },
  {
    name: "personal_gmail_list_labels",
    description: "List all Gmail labels in Steve's personal Gmail (shetzel84@gmail.com).",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
];

const professionalTools = [
  {
    name: "gmail_list_messages",
    description:
      "List recent emails from Steve's professional Gmail (stevehetzel2@gmail.com). Can filter by Gmail search query.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Gmail search query. Examples: 'is:unread', 'from:boss@work.com', 'newer_than:1d', 'subject:meeting'. Omit to list recent emails.",
        },
        max_results: {
          type: "number",
          description: "Max number of emails to return. Default 10.",
        },
      },
    },
  },
  {
    name: "gmail_read_message",
    description: "Read the full content of an email from Steve's professional Gmail (stevehetzel2@gmail.com).",
    input_schema: {
      type: "object",
      properties: {
        message_id: {
          type: "string",
          description: "The Gmail message ID.",
        },
      },
      required: ["message_id"],
    },
  },
  {
    name: "gmail_search",
    description:
      "Search emails in Steve's professional Gmail (stevehetzel2@gmail.com) using Gmail search syntax.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Gmail search query.",
        },
        max_results: {
          type: "number",
          description: "Max results to return. Default 10.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "gmail_send",
    description: "Send an email from Steve's professional Gmail (stevehetzel2@gmail.com).",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address." },
        subject: { type: "string", description: "Email subject line." },
        body: { type: "string", description: "Email body text." },
        cc: { type: "string", description: "CC recipients (comma-separated). Optional." },
        bcc: { type: "string", description: "BCC recipients (comma-separated). Optional." },
        reply_to_message_id: {
          type: "string",
          description: "Message ID to reply to. Optional.",
        },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "gmail_trash",
    description: "Move an email to the trash in Steve's professional Gmail (stevehetzel2@gmail.com).",
    input_schema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "The message ID to trash." },
      },
      required: ["message_id"],
    },
  },
  {
    name: "gmail_mark_read",
    description: "Mark an email as read in Steve's professional Gmail (stevehetzel2@gmail.com).",
    input_schema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "The message ID to mark as read." },
      },
      required: ["message_id"],
    },
  },
  {
    name: "gmail_list_labels",
    description: "List all Gmail labels in Steve's professional Gmail (stevehetzel2@gmail.com).",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
];

const tools = [...personalTools, ...professionalTools];

const systemPrompt = `

## Gmail
Steve has two accounts. **Default to personal unless he says "professional" or "work".**
- Personal (shetzel84@gmail.com) → \`personal_gmail_*\`
- Professional (stevehetzel2@gmail.com) → \`gmail_*\`
- Search takes Gmail syntax: "is:unread", "from:someone", "newer_than:1d".
- Always show Steve the draft and confirm before sending.
`;

const requires = "gmailManager";

function createHandler({ gmailManager, personalGmailManager }) {
  const getManager = (toolName) =>
    toolName.startsWith("personal_gmail_") ? personalGmailManager : gmailManager;

  return async (toolName, toolInput) => {
    const manager = getManager(toolName);
    if (!manager) {
      const account = toolName.startsWith("personal_gmail_") ? "personal (shetzel84@gmail.com)" : "professional (stevehetzel2@gmail.com)";
      return `${account} Gmail not configured. Run the OAuth flow first.`;
    }

    // Normalize tool name to the base action
    const action = toolName.replace(/^personal_gmail_/, "gmail_");

    switch (action) {
      case "gmail_list_messages": {
        const messages = await manager.listMessages({
          query: toolInput.query,
          maxResults: toolInput.max_results,
        });
        return JSON.stringify(messages, null, 2);
      }
      case "gmail_read_message": {
        const message = await manager.getMessage(toolInput.message_id);
        return JSON.stringify(message, null, 2);
      }
      case "gmail_search": {
        const results = await manager.searchMessages(
          toolInput.query,
          toolInput.max_results,
        );
        return JSON.stringify(results, null, 2);
      }
      case "gmail_send": {
        const result = await manager.sendMessage({
          to: toolInput.to,
          subject: toolInput.subject,
          body: toolInput.body,
          cc: toolInput.cc,
          bcc: toolInput.bcc,
          replyToMessageId: toolInput.reply_to_message_id,
        });
        return JSON.stringify(result, null, 2);
      }
      case "gmail_trash": {
        const result = await manager.trashMessage(toolInput.message_id);
        return JSON.stringify(result, null, 2);
      }
      case "gmail_mark_read": {
        const result = await manager.markAsRead(toolInput.message_id);
        return JSON.stringify(result, null, 2);
      }
      case "gmail_list_labels": {
        const labels = await manager.listLabels();
        return JSON.stringify(labels, null, 2);
      }
    }
  };
}

export default { name: "gmail", tools, systemPrompt, requires, createHandler };
