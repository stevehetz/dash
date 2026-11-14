import { createJob } from "./create-job.js";
import { readConfig, writeConfig } from "../dynamic-jobs/skill.js";

const DAY_MAP = { 0: "sun", 1: "mon", 2: "tue", 3: "wed", 4: "thu", 5: "fri", 6: "sat" };

/**
 * Background job that checks JOBS_DYNAMIC.json every minute
 * and fires any jobs whose time has come.
 *
 * - "once" jobs are removed after firing.
 * - "recurring" jobs fire on matching day + time.
 * - Jobs execute via agent.chat(), which always uses the Codex CLI backend.
 * - Results are sent to Telegram.
 */
export function startDynamicJobsRunner(agent, userId, deliver, interval) {
  return createJob({
    name: "dynamic-jobs",
    interval: interval ?? 60 * 1000,
    runOnStart: false,
    sequential: true,
    async fn() {
      const now = new Date();
      const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
      const currentTime = `${String(et.getHours()).padStart(2, "0")}:${String(et.getMinutes()).padStart(2, "0")}`;
      const currentDate = `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, "0")}-${String(et.getDate()).padStart(2, "0")}`;
      const currentDay = DAY_MAP[et.getDay()];

      const config = await readConfig();
      if (config.jobs.length === 0) return;

      const toFire = [];
      const toKeep = [];

      for (const job of config.jobs) {
        let shouldFire = false;

        if (job.enabled === false) {
          toKeep.push(job);
          continue;
        }

        if (job.time === currentTime) {
          if (job.type === "once") {
            shouldFire = job.date === currentDate;
          } else if (job.type === "recurring") {
            shouldFire = !job.days || job.days.length === 0 || job.days.includes(currentDay);
          } else if (job.type === "monthly") {
            shouldFire = job.day_of_month === et.getDate();
          }
        }

        if (shouldFire) {
          toFire.push(job);
          // Only keep recurring and monthly jobs
          if (job.type === "recurring" || job.type === "monthly") toKeep.push(job);
        } else {
          toKeep.push(job);
        }
      }

      // Update config if any one-time jobs were removed
      if (toKeep.length !== config.jobs.length) {
        config.jobs = toKeep;
        await writeConfig(config);
      }

      // Fire each job
      for (const job of toFire) {
        try {
          console.log(`  🚀 Firing job "${job.id}" (codex): ${job.prompt.slice(0, 60)}...`);
          const coordinatorPrompt = `You are executing a scheduled job RIGHT NOW. This is not a hypothetical request and there is no human in the loop to confirm with — your final text response will be delivered to Steve automatically as a Telegram message. Do NOT ask for confirmation, do NOT say you have no scheduled job, do NOT offer to send it later, do NOT mention scheduled jobs, delivery, tools, or platforms. The job prompt may refer to Steve in the third person ("Send Steve a message…"); treat that as the instruction for THIS execution and just produce the message. You do NOT need a tool to send it. Output ONLY the final polished message — no preamble, confirmation, framing, meta-commentary, narration of your own process, intermediate calculations, scratch work, or "thinking out loud" (e.g. "Got it", "Sure!", "Here's the message:", "Now let me calculate...", "Based on my research...", showing raw math/sums). Do all computation silently and only output the finished result. Never wrap any message, sentence, or phrase in quotes. If the task is purely file-based and Steve should NOT get a Telegram message, your final response must be EXACTLY the literal token [NO-TELEGRAM] and nothing else. Here is the job:\n\n${job.prompt}`;

          // No history passed — a scheduled job runs on its own terms and must not
          // pick up whatever Steve happened to be chatting about.
          const result = await agent.chat(`${userId}_job_${job.id}`, coordinatorPrompt);

          const trimmed = (result || "").trim();
          if (trimmed && !trimmed.includes("[NO-TELEGRAM]")) {
            await deliver(trimmed);
          }
        } catch (err) {
          console.error(`  ❌ Job "${job.id}" failed:`, err.message);
          await deliver(`⚠️ Job failed: ${job.prompt.slice(0, 100)}\nError: ${err.message}`)
            .catch(() => {});
        }
      }
    },
  });
}
