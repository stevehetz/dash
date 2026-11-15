import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const CONFIG_PATH = `${process.env.ONEDRIVE_PATH}/dashbook/dash/config/JOBS_DYNAMIC.json`;

const tools = [
  {
    name: "add_job",
    description:
      "Add a job for Dash to execute later. Supports one-time jobs (fires once then is removed) and recurring jobs (fires daily, weekly, or monthly).",
    input_schema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "The instruction Dash will execute when the job fires. Can be anything Dash can do — send a message, check weather, etc.",
        },
        type: {
          type: "string",
          enum: ["once", "recurring", "monthly"],
          description: '"once" fires a single time then is removed. "recurring" fires on a weekly/daily schedule. "monthly" fires once per month on a specific day of the month.',
        },
        time: {
          type: "string",
          description: "Time to fire in HH:mm format (24-hour, Eastern Time). e.g. \"20:00\" for 8 PM.",
        },
        date: {
          type: "string",
          description:
            'For "once" jobs: the date to fire in YYYY-MM-DD format. Required for type "once".',
        },
        days: {
          type: "array",
          items: {
            type: "string",
            enum: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
          },
          description:
            'For "recurring" jobs: which days of the week to fire. Omit or pass all 7 for daily. Supports shortcuts in the prompt — the agent should expand "weekdays" to ["mon","tue","wed","thu","fri"].',
        },
        day_of_month: {
          type: "number",
          description: 'For "monthly" jobs: the day of the month to fire (1–28). e.g. 1 for the 1st of every month.',
        },
        title: {
          type: "string",
          description:
            "Optional short label for the job (e.g. \"Markets\", \"Hacker News\"), used for display/logging.",
        },
      },
      required: ["prompt", "type", "time"],
    },
  },
  {
    name: "list_jobs",
    description: "List all jobs from the dynamic jobs config.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "remove_job",
    description: "Remove a job by its ID.",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The ID of the job to remove.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "toggle_job",
    description: "Enable or disable a job by its ID. Disabled jobs remain in the list but won't fire.",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The ID of the job to toggle.",
        },
        enabled: {
          type: "boolean",
          description: "Set to true to enable, false to disable.",
        },
      },
      required: ["id", "enabled"],
    },
  },
];

const systemPrompt = `

## Jobs
add_job schedules **Dash to run something later** — weather checks, emails, messages, file ops. It is not a to-do list.

When Steve's message has a future time reference AND the action is something Dash would run itself ("in 10 minutes", "at 5pm", "tomorrow morning"), call add_job. Adding the job IS the task — do not perform the action now.

If he says "remind me", "reminder", "task", or "add a task" — even with a time — that is apple_create_reminder, never add_job.

Examples:
- "in 2 minutes send me the weather" → add_job at the ET time 2 minutes out, NOT weather_current now.
- "every weekday at 8pm say good night" → add_job, type "recurring", days ["mon","tue","wed","thu","fri"].
- "at 5pm remind me to call mom" → apple_create_reminder.
- "send me the weather" (no time reference) → just do it now.

Scheduling:
- "in X hours/minutes" → type "once", target time in ET, today's or tomorrow's date.
- "every day at X" → type "recurring", omit days.
- "on the 1st of every month at X" → type "monthly" with day_of_month.
- The prompt must be a full instruction you can execute later, e.g. "Check the weather in Macedonia and send Steve the forecast".
- list_jobs shows what's scheduled; remove_job cancels one.
- After calling add_job, write no confirmation preamble. Call the tool and stop — the tool result is the confirmation.
`;

async function readConfig() {
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { jobs: [] };
  }
}

async function writeConfig(config) {
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function createHandler() {
  return async (toolName, toolInput) => {
    switch (toolName) {
      case "add_job": {
        const config = await readConfig();
        const job = {
          id: randomUUID().slice(0, 8),
          type: toolInput.type,
          prompt: toolInput.prompt,
          time: toolInput.time,
          ...(toolInput.date && { date: toolInput.date }),
          ...(toolInput.days && toolInput.days.length > 0 && { days: toolInput.days }),
          ...(toolInput.day_of_month != null && { day_of_month: toolInput.day_of_month }),
          ...(toolInput.title && { title: toolInput.title }),
          createdAt: new Date().toISOString(),
        };
        config.jobs.push(job);
        await writeConfig(config);

        const schedule =
          job.type === "once"
            ? `once on ${job.date} at ${job.time} ET`
            : job.type === "monthly"
            ? `monthly on day ${job.day_of_month} at ${job.time} ET`
            : `recurring at ${job.time} ET${job.days ? ` on ${job.days.join(", ")}` : " daily"}`;

        return JSON.stringify({ success: true, id: job.id, schedule }, null, 2);
      }

      case "list_jobs": {
        const config = await readConfig();
        if (config.jobs.length === 0) return "No jobs.";
        return JSON.stringify(config.jobs, null, 2);
      }

      case "remove_job": {
        const config = await readConfig();
        const before = config.jobs.length;
        config.jobs = config.jobs.filter((j) => j.id !== toolInput.id);
        if (config.jobs.length === before) return `Job ${toolInput.id} not found.`;
        await writeConfig(config);
        return JSON.stringify({ success: true, removed: toolInput.id });
      }

      case "toggle_job": {
        const config = await readConfig();
        const job = config.jobs.find((j) => j.id === toolInput.id);
        if (!job) return `Job ${toolInput.id} not found.`;
        job.enabled = toolInput.enabled;
        await writeConfig(config);
        return JSON.stringify({ success: true, id: job.id, enabled: job.enabled });
      }
    }
  };
}

export default { name: "dynamic-jobs", tools, systemPrompt, createHandler };
export { readConfig, writeConfig, CONFIG_PATH };
