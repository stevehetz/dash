import { createJob } from "./create-job.js";
import { cleanupCompletedReminders } from "../apple/apple-notes-reminders.js";
import { snapshotTasks } from "./tasks-snapshot.js";

export function startReminderCleanup({ interval } = {}) {
  return createJob({
    name: "reminder-cleanup",
    interval: interval ?? 24 * 60 * 60 * 1000, // once per day
    runOnStart: true,
    sequential: true,
    async fn() {
      // Deleting is destructive and irreversible — record the day's completed
      // tasks first, or the history loses everything finished since last run.
      await snapshotTasks();
      const result = await cleanupCompletedReminders(0);
      if (result.deleted > 0) {
        console.log(`  🧹 Reminder cleanup: deleted ${result.deleted} completed reminders`);
      }
    },
  });
}
