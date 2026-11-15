import {
  listNoteFolders, listNotes, readNote, createNote, searchNotes,
  listReminderLists, listReminders, createReminder, completeReminder,
} from "./apple-notes-reminders.js";
import {
  listCalendars, listEvents, getEvent, createEvent, deleteEvent,
} from "./apple-calendar.js";
import { withLocalTimes } from "../../utils/format-event-times.js";

const tools = [
  {
    name: "apple_list_note_folders",
    description: "List all folders in Apple Notes with note counts.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "apple_list_notes",
    description: "List notes, optionally filtered by folder name.",
    input_schema: {
      type: "object",
      properties: {
        folder: {
          type: "string",
          description: "Folder name to list notes from. Omit to list all notes.",
        },
      },
    },
  },
  {
    name: "apple_read_note",
    description: "Read the full text content of a specific note by its ID.",
    input_schema: {
      type: "object",
      properties: {
        note_id: {
          type: "string",
          description: "The note ID (from apple_list_notes or apple_search_notes).",
        },
      },
      required: ["note_id"],
    },
  },
  {
    name: "apple_search_notes",
    description: "Search notes by keyword across titles and content.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search term to match against note titles and content.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "apple_create_note",
    description: "Create a new note in Apple Notes.",
    input_schema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Title of the note.",
        },
        body: {
          type: "string",
          description: "Text content of the note.",
        },
        folder: {
          type: "string",
          description: "Folder name to create the note in. Omit for the default folder.",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "apple_list_reminder_lists",
    description: "List all Reminder lists with counts of incomplete reminders.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "apple_list_reminders",
    description: "List reminders in a specific list.",
    input_schema: {
      type: "object",
      properties: {
        list_name: {
          type: "string",
          description: "Reminder list name. Omit for the default list.",
        },
        show_completed: {
          type: "boolean",
          description: "Include completed reminders. Default false.",
        },
      },
    },
  },
  {
    name: "apple_create_reminder",
    description: "Create a new reminder.",
    input_schema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Title of the reminder.",
        },
        list_name: {
          type: "string",
          description: "Reminder list name. Omit for the default list.",
        },
        notes: {
          type: "string",
          description: "Optional notes/details.",
        },
        due_date: {
          type: "string",
          description: "Optional due date (ISO 8601).",
        },
        priority: {
          type: "number",
          description: "Priority: 0 (none), 1 (high), 5 (medium), 9 (low).",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "apple_complete_reminder",
    description: "Mark a reminder as completed.",
    input_schema: {
      type: "object",
      properties: {
        reminder_id: {
          type: "string",
          description: "The reminder ID to mark complete.",
        },
      },
      required: ["reminder_id"],
    },
  },
  // ── Calendar ──────────────────────────────────────────
  {
    name: "apple_list_calendars",
    description: "List all calendars in Apple Calendar.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "apple_list_events",
    description: "List events from Apple Calendar within a date range.",
    input_schema: {
      type: "object",
      properties: {
        calendar_name: {
          type: "string",
          description: "Calendar name to filter by. Omit to search all calendars.",
        },
        start_date: {
          type: "string",
          description: "Start of date range (ISO 8601). Defaults to now.",
        },
        end_date: {
          type: "string",
          description: "End of date range (ISO 8601). Defaults to 7 days from now.",
        },
      },
    },
  },
  {
    name: "apple_get_event",
    description: "Get full details of a specific calendar event by ID.",
    input_schema: {
      type: "object",
      properties: {
        event_uid: {
          type: "string",
          description: "The event UID.",
        },
        calendar_name: {
          type: "string",
          description: "Calendar name to search in. Omit to search all calendars.",
        },
      },
      required: ["event_uid"],
    },
  },
  {
    name: "apple_create_event",
    description: "Create a new event in Apple Calendar.",
    input_schema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "Title of the event.",
        },
        start_date: {
          type: "string",
          description: "Start date/time (ISO 8601 with UTC offset).",
        },
        end_date: {
          type: "string",
          description: "End date/time (ISO 8601 with UTC offset).",
        },
        calendar_name: {
          type: "string",
          description: "Calendar name. Omit for the default calendar.",
        },
        location: {
          type: "string",
          description: "Location of the event.",
        },
        description: {
          type: "string",
          description: "Description/notes for the event.",
        },
        all_day: {
          type: "boolean",
          description: "Whether this is an all-day event.",
        },
      },
      required: ["summary", "start_date", "end_date"],
    },
  },
  {
    name: "apple_delete_event",
    description: "Delete a calendar event by ID.",
    input_schema: {
      type: "object",
      properties: {
        event_uid: {
          type: "string",
          description: "The event UID to delete.",
        },
        calendar_name: {
          type: "string",
          description: "Calendar name to search in. Omit to search all calendars.",
        },
      },
      required: ["event_uid"],
    },
  },
];

const systemPrompt = `

## Apple Notes, Reminders & Calendar
- Dates for new reminders/events: ISO 8601 with the correct America/New_York offset (see "Today's date and time" for EST/-05:00 vs EDT/-04:00).
- When SHOWING event times to Steve, ALWAYS use the \`startLocal\`/\`endLocal\` (or \`startTimeLocal\`/\`endTimeLocal\`) fields. Never format the raw \`startDate\`/\`endDate\` yourself — they are UTC and will display 4–5 hours off.
- "What's on my calendar", or anything about upcoming events, uses apple_list_events.
`;

function createHandler() {
  return async (toolName, toolInput) => {
    switch (toolName) {
      case "apple_list_note_folders": {
        const folders = await listNoteFolders();
        return JSON.stringify(folders, null, 2);
      }
      case "apple_list_notes": {
        const notes = await listNotes(toolInput.folder);
        return JSON.stringify(notes, null, 2);
      }
      case "apple_read_note": {
        const note = await readNote(toolInput.note_id);
        return JSON.stringify(note, null, 2);
      }
      case "apple_create_note": {
        const note = await createNote(toolInput.title, toolInput.body, toolInput.folder);
        return JSON.stringify(note, null, 2);
      }
      case "apple_search_notes": {
        const notes = await searchNotes(toolInput.query);
        return JSON.stringify(notes, null, 2);
      }
      case "apple_list_reminder_lists": {
        const lists = await listReminderLists();
        return JSON.stringify(lists, null, 2);
      }
      case "apple_list_reminders": {
        const reminders = await listReminders(toolInput.list_name, toolInput.show_completed);
        return JSON.stringify(reminders, null, 2);
      }
      case "apple_create_reminder": {
        const reminder = await createReminder(toolInput.list_name, toolInput.title, {
          notes: toolInput.notes,
          dueDate: toolInput.due_date,
          priority: toolInput.priority,
        });
        return JSON.stringify(reminder, null, 2);
      }
      case "apple_complete_reminder": {
        return await completeReminder(toolInput.reminder_id);
      }
      // ── Calendar ──────────────────────────────────────
      case "apple_list_calendars": {
        const cals = await listCalendars();
        return JSON.stringify(cals, null, 2);
      }
      case "apple_list_events": {
        const events = await listEvents(toolInput.calendar_name, toolInput.start_date, toolInput.end_date);
        return JSON.stringify(withLocalTimes(events), null, 2);
      }
      case "apple_get_event": {
        const event = await getEvent(toolInput.event_uid, toolInput.calendar_name);
        return JSON.stringify(event, null, 2);
      }
      case "apple_create_event": {
        const event = await createEvent(toolInput.calendar_name, toolInput.summary, toolInput.start_date, toolInput.end_date, {
          location: toolInput.location,
          description: toolInput.description,
          allDay: toolInput.all_day,
        });
        return JSON.stringify(event, null, 2);
      }
      case "apple_delete_event": {
        return await deleteEvent(toolInput.event_uid, toolInput.calendar_name);
      }
    }
  };
}

export default { name: "apple", tools, systemPrompt, createHandler };
