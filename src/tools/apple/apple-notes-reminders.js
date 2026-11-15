import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const TIMEOUT = 30000;
const TIMEOUT_LONG = 90000;
const TIMEOUT_BULK = 5 * 60 * 1000;

/**
 * Run a JXA (JavaScript for Automation) script via osascript.
 */
async function runJxa(script, timeout = TIMEOUT) {
  try {
    const { stdout } = await exec("osascript", ["-l", "JavaScript", "-e", script], {
      timeout,
    });
    return stdout.trim();
  } catch (err) {
    if (err.killed) {
      throw new Error(`osascript timed out after ${timeout / 1000}s (killed by ${err.signal})`);
    }
    const stderr = (err.stderr || "").trim();
    if (stderr) {
      const wrapped = new Error(`osascript failed: ${stderr}`);
      wrapped.cause = err;
      throw wrapped;
    }
    throw err;
  }
}

// ── Notes ────────────────────────────────────────────────

export async function listNoteFolders() {
  const raw = await runJxa(`
    const app = Application("Notes");
    const folders = app.folders();
    JSON.stringify(folders.map(f => ({
      name: f.name(),
      count: f.notes.length
    })));
  `);
  return JSON.parse(raw);
}

export async function listNotes(folderName) {
  const folderFilter = folderName
    ? `app.folders.byName(${JSON.stringify(folderName)}).notes()`
    : `app.notes()`;

  const raw = await runJxa(`
    const app = Application("Notes");
    const notes = ${folderFilter};
    JSON.stringify(notes.slice(0, 50).map(n => ({
      id: n.id(),
      name: n.name(),
      modificationDate: n.modificationDate().toISOString(),
      folder: n.container().name()
    })));
  `);
  return JSON.parse(raw);
}

export async function readNote(noteId) {
  const raw = await runJxa(`
    const app = Application("Notes");
    const note = app.notes.byId(${JSON.stringify(noteId)});
    JSON.stringify({
      name: note.name(),
      folder: note.container().name(),
      modificationDate: note.modificationDate().toISOString(),
      body: note.plaintext()
    });
  `);
  return JSON.parse(raw);
}

export async function createNote(title, body, folderName) {
  const raw = await runJxa(`
    const app = Application("Notes");
    const folder = ${folderName ? `app.folders.byName(${JSON.stringify(folderName)})` : `app.defaultAccount().defaultFolder()`};
    const note = app.Note({
      name: ${JSON.stringify(title)},
      body: ${JSON.stringify(body || "")}
    });
    folder.notes.push(note);
    JSON.stringify({ id: note.id(), name: note.name(), folder: folder.name() });
  `);
  return JSON.parse(raw);
}

export async function deleteNote(noteId) {
  await runJxa(`
    const app = Application("Notes");
    const note = app.notes.byId(${JSON.stringify(noteId)});
    app.delete(note);
    "ok";
  `);
}

export async function searchNotes(query) {
  const raw = await runJxa(`
    const app = Application("Notes");
    const notes = app.notes().filter(n => {
      const q = ${JSON.stringify(query.toLowerCase())};
      return n.name().toLowerCase().includes(q) ||
             n.plaintext().toLowerCase().includes(q);
    });
    JSON.stringify(notes.slice(0, 20).map(n => ({
      id: n.id(),
      name: n.name(),
      folder: n.container().name(),
      snippet: n.plaintext().substring(0, 200)
    })));
  `);
  return JSON.parse(raw);
}

// ── Reminders ────────────────────────────────────────────

export async function listReminderLists() {
  const raw = await runJxa(`
    const app = Application("Reminders");
    const lists = app.lists();
    JSON.stringify(lists.map(l => ({
      name: l.name(),
      id: l.id()
    })));
  `, TIMEOUT_LONG);
  return JSON.parse(raw);
}

export async function listReminders(listName, showCompleted = false) {
  const raw = await runJxa(`
    const app = Application("Reminders");
    const targets = ${listName ? `[app.lists.byName(${JSON.stringify(listName)})]` : `app.lists()`};
    const results = [];
    for (const list of targets) {
      const names = list.reminders.name();
      const completed = list.reminders.completed();
      const ids = list.reminders.id();
      const dueDates = list.reminders.dueDate();
      const priorities = list.reminders.priority();
      const bodies = list.reminders.body();
      for (let i = 0; i < names.length; i++) {
        if (${showCompleted ? `true` : `!completed[i]`}) {
          results.push({ id: ids[i], name: names[i], completed: completed[i], dueDate: dueDates[i] ? dueDates[i].toISOString() : null, priority: priorities[i], body: bodies[i] || "" });
        }
        if (results.length >= 500) break;
      }
      if (results.length >= 500) break;
    }
    JSON.stringify(results);
  `, TIMEOUT_LONG);
  return JSON.parse(raw);
}

export async function createReminder(listName, title, { notes, dueDate, priority } = {}) {
  await runJxa(`
    const app = Application("Reminders");
    const list = ${listName ? `app.lists.byName(${JSON.stringify(listName)})` : `app.lists[0]`};
    const props = { name: ${JSON.stringify(title)} };
    ${notes ? `props.body = ${JSON.stringify(notes)};` : ""}
    ${dueDate ? `props.dueDate = new Date(${JSON.stringify(dueDate)});` : ""}
    ${priority ? `props.priority = ${priority};` : ""}
    const r = app.Reminder(props);
    list.reminders.push(r);
    "ok";
  `, TIMEOUT_LONG);
  return { name: title, created: true };
}

export async function completeReminder(reminderId) {
  await runJxa(`
    const app = Application("Reminders");
    const allLists = app.lists();
    for (const list of allLists) {
      try {
        const r = list.reminders.byId(${JSON.stringify(reminderId)});
        r.completed = true;
        break;
      } catch(e) {}
    }
  `, TIMEOUT_LONG);
  return "Reminder marked complete.";
}

/**
 * Every reminder in every list, open and completed, with the fields the daily
 * task history needs — list name and completion date, which listReminders drops.
 */
export async function snapshotReminders() {
  const raw = await runJxa(`
    const app = Application("Reminders");
    const results = [];
    for (const list of app.lists()) {
      const listName = list.name();
      const ids = list.reminders.id();
      const names = list.reminders.name();
      const completed = list.reminders.completed();
      const completionDates = list.reminders.completionDate();
      const dueDates = list.reminders.dueDate();
      const priorities = list.reminders.priority();
      for (let i = 0; i < ids.length; i++) {
        results.push({
          id: ids[i],
          name: names[i],
          list: listName,
          completed: completed[i],
          completionDate: completionDates[i] ? completionDates[i].toISOString() : null,
          dueDate: dueDates[i] ? dueDates[i].toISOString() : null,
          priority: priorities[i],
        });
      }
    }
    JSON.stringify(results);
  `, TIMEOUT_BULK);
  return JSON.parse(raw);
}

/**
 * Delete completed reminders older than the given number of days.
 * Returns the count of deleted reminders.
 *
 * Reminders' scripting bridge is very slow (~10-30s per bulk query on a list of
 * a few hundred), so this issues one filtered delete per list instead of
 * fetching properties and deleting reminders one by one — the old per-item loop
 * blew past the timeout once a couple hundred completed reminders piled up.
 */
export async function cleanupCompletedReminders(olderThanDays = 7) {
  const raw = await runJxa(`
    const app = Application("Reminders");
    const cutoff = new Date(Date.now() - ${olderThanDays} * 86400000);
    const filter = ${olderThanDays} > 0
      ? { _and: [{ completed: true }, { completionDate: { _lessThan: cutoff } }] }
      : { completed: true };
    let deleted = 0;
    for (const list of app.lists()) {
      const matches = list.reminders.whose(filter);
      const count = matches.id().length;
      if (count === 0) continue;
      app.delete(matches);
      deleted += count;
    }
    JSON.stringify({ deleted });
  `, TIMEOUT_BULK);
  return JSON.parse(raw);
}
