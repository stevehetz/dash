// Dash dashapp — jobs/system config UI with SSE live updates.

// Disable browser scroll restoration so deep-linking to #messages doesn't
// fight our scroll-to-bottom logic on reload.
if ("scrollRestoration" in history) history.scrollRestoration = "manual";

if (window.marked) marked.setOptions({ breaks: true });

const statusEl = document.getElementById("status");
const listEl = document.getElementById("jobs-list");
const countEl = document.getElementById("jobs-count");
const hideInactiveEl = document.getElementById("jobs-hide-inactive");
const addJobBtn = document.getElementById("add-job-btn");

const DAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

let jobsById = {};
let activePromptEdit = null; // { el, jobId, isDirty, cancel, save }
let lastJobsConfig = null;

// "Hide inactive" toggle — persisted in localStorage, defaults to true.
let hideInactiveJobs = (() => {
  const stored = localStorage.getItem("jobs-hide-inactive");
  return stored === null ? true : stored === "true";
})();
if (hideInactiveEl) {
  hideInactiveEl.checked = hideInactiveJobs;
  hideInactiveEl.addEventListener("change", () => {
    hideInactiveJobs = hideInactiveEl.checked;
    try { localStorage.setItem("jobs-hide-inactive", String(hideInactiveJobs)); } catch {}
    if (lastJobsConfig) render(lastJobsConfig);
  });
}

// Intercept clicks into a different job while a prompt edit is open.
// No changes → silently cancel. Dirty → confirm() before discarding.
listEl.addEventListener("click", (e) => {
  if (!activePromptEdit) return;
  const clickedJob = e.target.closest(".job");
  if (!clickedJob) return;
  if (clickedJob.contains(activePromptEdit.el)) return; // click inside active job
  if (activePromptEdit.isDirty()) {
    if (!confirm("Discard unsaved changes to this job?")) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
  }
  activePromptEdit.cancel();
}, true);

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = "status" + (cls ? " " + cls : "");
}

function timeToMinutes(t) {
  if (!t) return Infinity;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + (m || 0);
}

function formatTime(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const hh = ((h + 11) % 12) + 1;
  return `${hh}:${String(m).padStart(2, "0")} ${period}`;
}

function formatDays(days) {
  if (!days || days.length === 0) return null;
  if (days.length === 7) return "daily";
  const sorted = [...days].sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));
  // weekdays / weekends shortcuts
  const set = new Set(sorted);
  if (set.size === 5 && ["mon","tue","wed","thu","fri"].every((d) => set.has(d))) return "weekdays";
  if (set.size === 2 && set.has("sat") && set.has("sun")) return "weekends";
  return sorted.join(" · ");
}

async function updateJob(id, fields) {
  const res = await fetch("/api/jobs/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, ...fields }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

function renderJob(job) {
  const tags = [];
  tags.push(`<span class="tag ${job.type} editable" data-field="type" data-job-id="${job.id}">${job.type}</span>`);

  if (job.type === "recurring") {
    const days = formatDays(job.days);
    tags.push(`<span class="tag day editable" data-field="days" data-job-id="${job.id}">${days || "daily"}</span>`);
  } else if (job.type === "once") {
    tags.push(`<span class="tag day editable" data-field="date" data-job-id="${job.id}">${job.date || ""}</span>`);
  } else if (job.type === "monthly") {
    tags.push(`<span class="tag day editable" data-field="day_of_month" data-job-id="${job.id}">day ${job.day_of_month ?? ""}</span>`);
  }

  const enabled = job.enabled !== false;
  return `
    <div class="job${enabled ? "" : " disabled"}" data-id="${job.id}">
      <label class="job-toggle" title="${enabled ? "Disable" : "Enable"} job">
        <input type="checkbox" data-job-id="${job.id}" ${enabled ? "checked" : ""} />
      </label>
      <div class="job-time editable" data-field="time" data-job-id="${job.id}" title="Click to edit">${formatTime(job.time)}</div>
      <div class="job-body">
        <div class="job-meta">${tags.join("")}</div>
        <div class="job-prompt" data-prompt-id="${job.id}" title="Click to edit"></div>
      </div>
      <button class="job-delete" data-job-id="${job.id}" title="Delete job">&times;</button>
    </div>
  `;
}

function render(config) {
  lastJobsConfig = config;
  const jobs = (config && config.jobs) || [];
  countEl.textContent = jobs.length ? `${jobs.length} job${jobs.length === 1 ? "" : "s"}` : "";

  const visibleJobs = hideInactiveJobs ? jobs.filter((j) => j.enabled !== false) : jobs;

  if (jobs.length === 0) {
    listEl.innerHTML = `<div class="empty">No jobs.</div>`;
    return;
  }

  if (visibleJobs.length === 0) {
    listEl.innerHTML = `<div class="empty">No active jobs. Uncheck "Hide inactive" to see all.</div>`;
    jobsById = {};
    jobs.forEach((j) => (jobsById[j.id] = j));
    return;
  }

  const sorted = [...visibleJobs].sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time));
  jobsById = {};
  jobs.forEach((j) => (jobsById[j.id] = j));
  listEl.innerHTML = sorted.map(renderJob).join("");

  // Set prompt textContent (avoid HTML injection from the JSON file)
  const promptEls = listEl.querySelectorAll(".job-prompt");
  sorted.forEach((job, i) => {
    promptEls[i].textContent = (job.prompt || "").trim();
  });

  // Wire up click-to-edit on prompts
  listEl.querySelectorAll('.job-prompt[data-prompt-id]').forEach((el) => {
    el.addEventListener("click", () => {
      if (el.querySelector("textarea")) return; // already editing
      const id = el.dataset.promptId;
      const original = el.textContent;
      const wrapper = document.createElement("div");
      wrapper.className = "job-prompt-edit-wrap";
      const ta = document.createElement("textarea");
      ta.className = "job-prompt-edit";
      ta.value = original;
      const btns = document.createElement("div");
      btns.className = "job-prompt-edit-btns";
      btns.innerHTML = '<button class="job-prompt-save">Save</button><button class="job-prompt-cancel">Cancel</button>';
      wrapper.appendChild(ta);
      wrapper.appendChild(btns);
      el.textContent = "";
      el.appendChild(wrapper);
      ta.rows = 1;
      function autosizeEdit() { ta.style.height = "0"; ta.style.height = ta.scrollHeight + "px"; }
      autosizeEdit();
      ta.addEventListener("input", autosizeEdit);
      ta.focus();

      function cancel() {
        el.textContent = original;
        if (activePromptEdit && activePromptEdit.el === el) activePromptEdit = null;
      }

      async function save() {
        const newVal = ta.value.trim();
        if (newVal === original.trim() || !newVal) { cancel(); return; }
        try {
          const res = await fetch("/api/jobs/update-prompt", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, prompt: newVal }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          el.textContent = newVal;
        } catch (err) {
          console.error("Failed to update prompt", err);
          cancel();
          return;
        }
        if (activePromptEdit && activePromptEdit.el === el) activePromptEdit = null;
      }

      activePromptEdit = {
        el,
        jobId: id,
        isDirty: () => ta.value.trim() !== original.trim(),
        cancel,
        save,
      };

      btns.querySelector(".job-prompt-save").addEventListener("click", (e) => { e.stopPropagation(); save(); });
      btns.querySelector(".job-prompt-cancel").addEventListener("click", (e) => { e.stopPropagation(); cancel(); });
      ta.addEventListener("keydown", (e) => {
        if (e.key === "Escape") cancel();
      });
    });
  });

  // Wire up enable/disable toggles
  listEl.querySelectorAll('input[data-job-id]').forEach((cb) => {
    cb.addEventListener("change", async (e) => {
      const id = e.target.dataset.jobId;
      const enabled = e.target.checked;
      try {
        const res = await fetch("/api/jobs/toggle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, enabled }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (err) {
        console.error("Failed to toggle job", err);
        e.target.checked = !enabled; // revert on failure
      }
    });
  });

  // Wire up editable time
  listEl.querySelectorAll('.job-time.editable').forEach((el) => {
    el.addEventListener("click", () => {
      if (el.querySelector("input")) return;
      const id = el.dataset.jobId;
      const job = jobsById[id];
      const originalText = el.textContent;
      const input = document.createElement("input");
      input.type = "time";
      input.className = "job-field-edit";
      input.value = job.time || "";
      el.textContent = "";
      el.appendChild(input);
      input.focus();
      let done = false;
      async function save() {
        if (done) return;
        done = true;
        const val = input.value;
        if (!val || val === job.time) { el.textContent = originalText; return; }
        try {
          await updateJob(id, { time: val });
          job.time = val;
          el.textContent = formatTime(val);
        } catch (err) { console.error("Failed to update time", err); el.textContent = originalText; }
      }
      function cancel() {
        if (done) return;
        done = true;
        el.textContent = originalText;
      }
      input.addEventListener("blur", save);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") cancel();
        else if (e.key === "Enter") input.blur();
      });
    });
  });

  // Wire up editable type tags
  listEl.querySelectorAll('.tag.editable[data-field="type"]').forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      if (el.querySelector("select")) return;
      const id = el.dataset.jobId;
      const job = jobsById[id];
      const originalHTML = el.innerHTML;
      const sel = document.createElement("select");
      sel.className = "job-field-edit";
      ["once", "recurring", "monthly"].forEach((v) => {
        const opt = document.createElement("option");
        opt.value = v; opt.textContent = v;
        if (v === job.type) opt.selected = true;
        sel.appendChild(opt);
      });
      el.textContent = "";
      el.appendChild(sel);
      sel.focus();
      async function save() {
        const val = sel.value;
        if (val === job.type) { el.innerHTML = originalHTML; return; }
        try {
          const fields = { type: val };
          if (val === "recurring") { fields.date = null; fields.day_of_month = null; }
          else if (val === "once") { fields.days = null; fields.day_of_month = null; }
          else if (val === "monthly") { fields.days = null; fields.date = null; }
          await updateJob(id, fields);
        } catch (err) { console.error("Failed to update type", err); el.innerHTML = originalHTML; }
      }
      sel.addEventListener("change", save);
      sel.addEventListener("blur", () => { if (el.contains(sel)) el.innerHTML = originalHTML; });
      sel.addEventListener("keydown", (e) => { if (e.key === "Escape") el.innerHTML = originalHTML; });
    });
  });

  // Wire up editable days (recurring)
  listEl.querySelectorAll('.tag.editable[data-field="days"]').forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      if (el.querySelector(".days-picker")) return;
      const id = el.dataset.jobId;
      const job = jobsById[id];
      const originalHTML = el.innerHTML;
      const currentDays = new Set(job.days || []);
      const picker = document.createElement("div");
      picker.className = "days-picker";
      DAY_ORDER.forEach((d) => {
        const label = document.createElement("label");
        label.className = "day-check" + (currentDays.has(d) ? " checked" : "");
        label.textContent = d;
        const cb = document.createElement("input");
        cb.type = "checkbox"; cb.value = d; cb.checked = currentDays.has(d);
        cb.addEventListener("change", () => label.classList.toggle("checked", cb.checked));
        label.prepend(cb);
        picker.appendChild(label);
      });
      const btns = document.createElement("div");
      btns.className = "job-prompt-edit-btns";
      btns.innerHTML = '<button class="job-prompt-save">Save</button><button class="job-prompt-cancel">Cancel</button>';
      el.textContent = "";
      el.appendChild(picker);
      el.appendChild(btns);
      function cancel() { el.innerHTML = originalHTML; }
      async function save() {
        const selected = [...picker.querySelectorAll("input:checked")].map((c) => c.value);
        const newDays = selected.length === 7 ? [] : selected;
        try {
          await updateJob(id, { days: newDays });
          job.days = newDays;
          el.innerHTML = formatDays(newDays) || "daily";
        } catch (err) { console.error("Failed to update days", err); cancel(); }
      }
      btns.querySelector(".job-prompt-save").addEventListener("click", (ev) => { ev.stopPropagation(); save(); });
      btns.querySelector(".job-prompt-cancel").addEventListener("click", (ev) => { ev.stopPropagation(); cancel(); });
    });
  });

  // Wire up editable date (once)
  listEl.querySelectorAll('.tag.editable[data-field="date"]').forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      if (el.querySelector("input")) return;
      const id = el.dataset.jobId;
      const job = jobsById[id];
      const originalText = el.textContent;
      const input = document.createElement("input");
      input.type = "date";
      input.className = "job-field-edit";
      input.value = job.date || "";
      el.textContent = "";
      el.appendChild(input);
      input.focus();
      async function save() {
        const val = input.value;
        if (!val || val === job.date) { el.textContent = originalText; return; }
        try { await updateJob(id, { date: val }); }
        catch (err) { console.error("Failed to update date", err); el.textContent = originalText; }
      }
      input.addEventListener("change", save);
      input.addEventListener("blur", save);
      input.addEventListener("keydown", (e2) => { if (e2.key === "Escape") el.textContent = originalText; });
    });
  });

  // Wire up editable day_of_month (monthly)
  listEl.querySelectorAll('.tag.editable[data-field="day_of_month"]').forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      if (el.querySelector("input")) return;
      const id = el.dataset.jobId;
      const job = jobsById[id];
      const originalText = el.textContent;
      const input = document.createElement("input");
      input.type = "number"; input.min = 1; input.max = 28;
      input.className = "job-field-edit";
      input.value = job.day_of_month ?? "";
      el.textContent = "";
      el.appendChild(input);
      input.focus();
      async function save() {
        const val = parseInt(input.value, 10);
        if (!val || val === job.day_of_month) { el.textContent = originalText; return; }
        try { await updateJob(id, { day_of_month: val }); }
        catch (err) { console.error("Failed to update day_of_month", err); el.textContent = originalText; }
      }
      input.addEventListener("change", save);
      input.addEventListener("blur", save);
      input.addEventListener("keydown", (e2) => { if (e2.key === "Escape") el.textContent = originalText; });
    });
  });

  // Wire up delete buttons
  listEl.querySelectorAll('.job-delete').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.jobId;
      const job = jobsById[id];
      const preview = (job?.prompt || "").slice(0, 40);
      if (!confirm(`Delete job "${preview}…"?`)) return;
      try {
        const res = await fetch("/api/jobs/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (err) {
        console.error("Failed to delete job", err);
      }
    });
  });
}

// New job form
addJobBtn.addEventListener("click", () => {
  const existingForm = document.getElementById("new-job-form");
  if (existingForm) {
    existingForm.remove();
    addJobBtn.textContent = "+ New";
    addJobBtn.setAttribute("aria-label", "Add job");
    addJobBtn.classList.remove("is-cancel");
    return;
  }

  const form = document.createElement("div");
  form.id = "new-job-form";
  form.className = "new-job-form";
  form.innerHTML = `
    <div class="new-job-row">
      <label>Type
        <select name="type">
          <option value="recurring" selected>recurring</option>
          <option value="once">once</option>
          <option value="monthly">monthly</option>
        </select>
      </label>
      <label>Time <input type="time" name="time" required /></label>
    </div>
    <div class="new-job-row new-job-schedule" id="new-job-schedule"></div>
    <textarea name="prompt" class="job-prompt-edit" rows="2" placeholder="What should Dash do?"></textarea>
    <div class="job-prompt-edit-btns">
      <button class="job-prompt-save" id="new-job-save">Create</button>
      <button class="job-prompt-cancel" id="new-job-cancel">Cancel</button>
    </div>
  `;
  listEl.parentNode.insertBefore(form, listEl);
  addJobBtn.textContent = "Cancel";
  addJobBtn.setAttribute("aria-label", "Cancel new job");
  addJobBtn.classList.add("is-cancel");

  function closeForm() {
    form.remove();
    addJobBtn.textContent = "+ New";
    addJobBtn.setAttribute("aria-label", "Add job");
    addJobBtn.classList.remove("is-cancel");
  }

  const typeSelect = form.querySelector('[name="type"]');
  const scheduleEl = form.querySelector("#new-job-schedule");

  function renderSchedule() {
    const type = typeSelect.value;
    if (type === "recurring") {
      scheduleEl.innerHTML = DAY_ORDER.map((d) =>
        `<label class="day-check"><input type="checkbox" name="day" value="${d}" />${d}</label>`
      ).join("");
      scheduleEl.querySelectorAll(".day-check").forEach((label) => {
        const cb = label.querySelector("input");
        cb.addEventListener("change", () => label.classList.toggle("checked", cb.checked));
      });
    } else if (type === "once") {
      scheduleEl.innerHTML = `<label>Date <input type="date" name="date" required /></label>`;
    } else if (type === "monthly") {
      scheduleEl.innerHTML = `<label>Day of month <input type="number" name="day_of_month" min="1" max="28" required /></label>`;
    }
  }
  typeSelect.addEventListener("change", renderSchedule);
  renderSchedule();

  form.querySelector("#new-job-cancel").addEventListener("click", closeForm);
  form.querySelector("#new-job-save").addEventListener("click", async () => {
    const type = typeSelect.value;
    const time = form.querySelector('[name="time"]').value;
    const prompt = form.querySelector('[name="prompt"]').value.trim();
    if (!time || !prompt) return;
    const payload = { type, time, prompt };
    if (type === "recurring") {
      const days = [...form.querySelectorAll('[name="day"]:checked')].map((c) => c.value);
      if (days.length > 0 && days.length < 7) payload.days = days;
    } else if (type === "once") {
      payload.date = form.querySelector('[name="date"]').value;
      if (!payload.date) return;
    } else if (type === "monthly") {
      payload.day_of_month = parseInt(form.querySelector('[name="day_of_month"]').value, 10);
      if (!payload.day_of_month) return;
    }
    try {
      const res = await fetch("/api/jobs/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      closeForm();
    } catch (err) {
      console.error("Failed to create job", err);
    }
  });
});

// Initial fetch + SSE
async function loadInitial() {
  try {
    const res = await fetch("/api/jobs", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    render(data);
  } catch (err) {
    listEl.innerHTML = `<div class="empty">Failed to load: ${err.message}</div>`;
    setStatus("offline", "error");
  }
}

function connectStream() {
  const es = new EventSource("/api/jobs/stream");

  es.addEventListener("open", () => setStatus("live", "live"));
  es.addEventListener("update", (e) => {
    try {
      render(JSON.parse(e.data));
      setStatus("live", "live");
    } catch (err) {
      console.error("Failed to parse update", err);
    }
  });
  es.addEventListener("error", () => {
    setStatus("reconnecting…", "error");
    // EventSource auto-reconnects; nothing else to do.
  });
}

loadInitial().then(connectStream);

// ── System jobs config ─────────────────────────────────
const systemListEl = document.getElementById("system-list");
const systemCountEl = document.getElementById("system-count");
const systemStatusEl = document.getElementById("system-status");
const systemPathEl = document.getElementById("system-path");
const systemReloadBtn = document.getElementById("system-reload-btn");
const systemSaveBtn = document.getElementById("system-save-btn");
const systemRestartBtn = document.getElementById("system-restart-btn");
let systemConfig = null;
let systemLoaded = false;
let systemDirty = false;

function setSystemStatus(text, cls) {
  systemStatusEl.textContent = text || "";
  systemStatusEl.className = "system-status" + (cls ? " " + cls : "");
}

function refreshSystemButtons() {
  const hasInvalid = !!systemListEl.querySelector(".invalid");
  systemSaveBtn.disabled = !systemDirty || hasInvalid;
}

function setSystemDirty(dirty) {
  systemDirty = dirty;
  refreshSystemButtons();
  if (dirty) setSystemStatus("unsaved changes", "warn");
}

function cloneSystemConfig(config) {
  return JSON.parse(JSON.stringify(config || { jobs: {} }));
}

function systemFieldSort([a], [b]) {
  const order = { interval: 0 };
  return (order[a] ?? 10) - (order[b] ?? 10) || a.localeCompare(b);
}

function renderSystemField(jobName, key, value) {
  const safeJob = attrEscape(jobName);
  const safeKey = attrEscape(key);
  const label = escapeHtml(key.replace(/_/g, " "));
  if (typeof value === "boolean") {
    return `
      <label class="system-field">
        <span class="system-field-label">${label}</span>
        <input data-system-input data-job="${safeJob}" data-key="${safeKey}" data-type="boolean" type="checkbox" ${value ? "checked" : ""} />
      </label>
    `;
  }
  if (typeof value === "number") {
    return `
      <label class="system-field">
        <span class="system-field-label">${label}</span>
        <input data-system-input data-job="${safeJob}" data-key="${safeKey}" data-type="number" type="number" step="1" value="${attrEscape(value)}" />
      </label>
    `;
  }
  if (typeof value === "string") {
    return `
      <label class="system-field">
        <span class="system-field-label">${label}</span>
        <input data-system-input data-job="${safeJob}" data-key="${safeKey}" data-type="string" type="text" value="${attrEscape(value)}" />
      </label>
    `;
  }
  return `
    <label class="system-field">
      <span class="system-field-label">${label}</span>
      <textarea data-system-input data-job="${safeJob}" data-key="${safeKey}" data-type="json">${escapeHtml(JSON.stringify(value, null, 2))}</textarea>
    </label>
  `;
}

function renderSystemConfig(data) {
  systemConfig = cloneSystemConfig(data.config || { jobs: {} });
  const jobs = systemConfig.jobs || {};
  const names = Object.keys(jobs).sort();
  systemLoaded = true;
  systemDirty = false;
  systemCountEl.textContent = names.length ? `${names.length} job${names.length === 1 ? "" : "s"}` : "";
  systemPathEl.textContent = data.path ? data.path : "";

  if (names.length === 0) {
    systemListEl.innerHTML = `<div class="empty">No system jobs configured.</div>`;
    refreshSystemButtons();
    return;
  }

  systemListEl.innerHTML = names.map((name) => {
    const options = jobs[name] && typeof jobs[name] === "object" && !Array.isArray(jobs[name]) ? jobs[name] : {};
    const enabled = options.enabled !== false;
    const fields = Object.entries(options)
      .filter(([key]) => key !== "enabled")
      .sort(systemFieldSort)
      .map(([key, value]) => renderSystemField(name, key, value))
      .join("");
    return `
      <div class="system-job">
        <div class="system-job-head">
          <div class="system-job-name">${escapeHtml(name)}</div>
          <label class="system-job-enabled">
            <input data-system-input data-job="${attrEscape(name)}" data-key="enabled" data-type="boolean" type="checkbox" ${enabled ? "checked" : ""} />
            enabled
          </label>
        </div>
        <div class="system-fields">${fields || `<div class="count">No options.</div>`}</div>
      </div>
    `;
  }).join("");

  systemListEl.querySelectorAll("[data-system-input]").forEach((input) => {
    const eventName = input.type === "checkbox" ? "change" : "input";
    input.addEventListener(eventName, () => updateSystemInput(input));
  });
  setSystemStatus("loaded", "ok");
  refreshSystemButtons();
}

function updateSystemInput(input) {
  if (!systemConfig) return;
  const jobName = input.dataset.job;
  const key = input.dataset.key;
  const type = input.dataset.type;
  const field = input.closest(".system-field");
  let value;

  try {
    if (type === "boolean") {
      value = input.checked;
    } else if (type === "number") {
      value = input.value === "" ? null : Number(input.value);
      if (input.value !== "" && !Number.isFinite(value)) throw new Error("Invalid number");
    } else if (type === "json") {
      value = JSON.parse(input.value);
    } else {
      value = input.value;
    }
    field?.classList.remove("invalid");
  } catch {
    field?.classList.add("invalid");
    systemDirty = true;
    refreshSystemButtons();
    setSystemStatus(type === "json" ? "invalid JSON" : "invalid value", "err");
    return;
  }

  if (!systemConfig.jobs || typeof systemConfig.jobs !== "object") systemConfig.jobs = {};
  if (!systemConfig.jobs[jobName] || typeof systemConfig.jobs[jobName] !== "object") systemConfig.jobs[jobName] = {};
  systemConfig.jobs[jobName][key] = value;
  setSystemDirty(true);
}

async function loadSystemConfig() {
  systemListEl.innerHTML = `<div class="empty">Loading…</div>`;
  setSystemStatus("loading", "");
  try {
    const res = await fetch("/api/system/jobs-config", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderSystemConfig(data);
  } catch (err) {
    systemLoaded = false;
    systemListEl.innerHTML = `<div class="empty">Failed to load: ${escapeHtml(err.message)}</div>`;
    setSystemStatus("load failed", "err");
  }
}

async function saveSystemConfig() {
  if (!systemConfig) return false;
  if (systemListEl.querySelector(".invalid")) {
    setSystemStatus("fix invalid values", "err");
    return false;
  }
  systemSaveBtn.disabled = true;
  setSystemStatus("saving", "");
  try {
    const res = await fetch("/api/system/jobs-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: systemConfig }),
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const body = await res.json(); if (body.error) msg = body.error; } catch {}
      throw new Error(msg);
    }
    const data = await res.json();
    renderSystemConfig(data);
    setSystemStatus("saved", "ok");
    return true;
  } catch (err) {
    setSystemStatus("save failed", "err");
    alert("Save failed: " + err.message);
    refreshSystemButtons();
    return false;
  }
}

async function restartSystem() {
  if (systemDirty) {
    const saved = await saveSystemConfig();
    if (!saved) return;
  }
  systemRestartBtn.disabled = true;
  setSystemStatus("restarting", "warn");
  try {
    const res = await fetch("/api/system/restart", { method: "POST" });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const body = await res.json(); if (body.error) msg = body.error; } catch {}
      throw new Error(msg);
    }
    setStatus("restarting…", "error");
    setSystemStatus("restart requested", "ok");
    setTimeout(() => loadSystemConfig().catch(() => {}), 8000);
  } catch (err) {
    setSystemStatus("restart failed", "err");
    alert("Restart failed: " + err.message);
  } finally {
    setTimeout(() => { systemRestartBtn.disabled = false; }, 2500);
  }
}

systemReloadBtn.addEventListener("click", loadSystemConfig);
systemSaveBtn.addEventListener("click", saveSystemConfig);
systemRestartBtn.addEventListener("click", restartSystem);

// ── Tabs + Notes view ──────────────────────────────────
// Saved groups are switched off for now: no tab of their own, and no way to put
// one into a day (see logAddRow). Days that already hold one still
// render it and still total it — this only stops new ones being added.
//
// Hidden from here rather than in the markup so the one flag covers both, and so
// everything downstream of tabBtns — the page/tab maps, the home grid, path
// routing — drops the tab without being told about it separately.
const SAVED_GROUPS_ENABLED = false;
if (!SAVED_GROUPS_ENABLED) document.querySelector('.tab[data-tab="groups"]')?.setAttribute("hidden", "");
// `hidden` on a tab button means switched off, not merely not drawn — a tab left
// out here is out of the page maps, the sidebar, the home grid and path routing.
// A tab that simply has no place in the bar (Home, the only tab on its page)
// must not carry it.
const tabBtns = document.querySelectorAll(".tab:not([hidden])");
const tabPanels = {
  telegram: document.getElementById("tab-telegram"),
  jobs: document.getElementById("tab-jobs"),
  system: document.getElementById("tab-system"),
  reminders: document.getElementById("tab-reminders"),
  "email-personal": document.getElementById("tab-email-personal"),
  "email-professional": document.getElementById("tab-email-professional"),
  "email-dashbot": document.getElementById("tab-email-dashbot"),
  calendar: document.getElementById("tab-calendar"),
  finances: document.getElementById("tab-finances"),
  planner: document.getElementById("tab-timeline"),
  review: document.getElementById("tab-review"),
  library: document.getElementById("tab-library"),
  health: document.getElementById("tab-health"),
  nutrition: document.getElementById("tab-nutrition"),
  groups: document.getElementById("tab-groups"),
  "food-logs": document.getElementById("tab-food-logs"),
  "api-usage": document.getElementById("tab-api-usage"),
  chat: document.getElementById("tab-chat"),
  home: document.getElementById("tab-home"),
};

// ── Pages (primary nav) ────────────────────────────────
// The sidebar is the primary nav; tabs are secondary nav *within* a page.
// A page's sub-tabs are the `.tab` buttons in index.html carrying a matching
// data-page — DOM order there is both the tab order and the swipe order.
const PAGE_ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  planner: '<rect x="3" y="4" width="18" height="17" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/>',
  email: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M3 7.5 12 13l9-5.5"/>',
  health: '<path d="M20.8 6.6a5 5 0 0 0-7.1 0L12 8.3l-1.7-1.7a5 5 0 1 0-7.1 7.1L12 21l8.8-8.3a5 5 0 0 0 0-6.1z"/>',
  nutrition: '<path d="M6 3v7a2 2 0 0 0 4 0V3"/><line x1="8" y1="12" x2="8" y2="21"/><path d="M17 3c-1.7 1.2-2.5 3.2-2.5 5.6S15.3 12.8 17 13.5V21"/>',
  finances: '<line x1="12" y1="2" x2="12" y2="22"/><path d="M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  library: '<path d="M4 5a2 2 0 0 1 2-2h3v18H6a2 2 0 0 1-2-2z"/><path d="M11 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3z"/><path d="m17.5 5.6 2.2-.6 2.1 15.2-2.2.6z"/>',
  jobs: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/>',
  system: '<line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/><circle cx="9" cy="7" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="8" cy="17" r="2"/>',
};
const PAGES = [
  { key: "home", label: "Home" },
  // Review is a tab of Planner, not a page of its own — /review still routes,
  // it just lands on the Planner page now.
  { key: "planner", label: "Planner" },
  // All three Gmail inboxes, one tab each.
  { key: "email", label: "Email" },
  { key: "nutrition", label: "Nutrition" },
  { key: "finances", label: "Finances" },
  { key: "jobs", label: "Jobs" },
  // One browser over the whole of dashbook, rather than the four fixed corners
  // of it — reports, notes, images, dash — it used to be split into. The old
  // routes still land here (see TAB_ALIASES and routeLibraryPath).
  { key: "library", label: "Library" },
  { key: "health", label: "Health" },
  { key: "system", label: "System" },
];

const sideNavEl = document.getElementById("side-nav");
const homeGridEl = document.getElementById("home-grid");
const pageTitleEl = document.getElementById("page-title");
const tabsWrapEl = document.querySelector(".tabs-wrap");
const navToggleBtn = document.getElementById("nav-toggle");
const navBackdropEl = document.getElementById("nav-backdrop");

const pageOfTab = {};   // tab key → page key
const tabsOfPage = {};  // page key → [tab keys] in DOM order
for (const btn of tabBtns) {
  const page = btn.dataset.page || btn.dataset.tab;
  pageOfTab[btn.dataset.tab] = page;
  (tabsOfPage[page] ||= []).push(btn.dataset.tab);
}
// Where you left off on each page, so coming back lands on the same sub-tab.
const lastTabOfPage = {};
let currentPage = null;
// Set by setupTabsScroll — the tab set changes with the page, so the overflow
// arrows have to be re-evaluated after the bar is repopulated.
let refreshTabsScroll = () => {};

function pageIcon(key, size = 20) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PAGE_ICONS[key] || ""}</svg>`;
}
function tabLabel(tab) {
  return document.querySelector(`.tab[data-tab="${CSS.escape(tab)}"]`)?.textContent.trim() || tab;
}
function livePages() {
  return PAGES.filter((p) => (tabsOfPage[p.key] || []).length > 0);
}

function renderSideNav() {
  sideNavEl.innerHTML = livePages().map((p) => `
    <button class="side-nav-item" data-page="${p.key}" type="button">
      ${pageIcon(p.key)}<span>${escapeHtml(p.label)}</span>
    </button>`).join("");
  syncNavTitles();
}

// Collapsed to the icon rail the labels are off screen, so the only thing left
// naming a row is its tooltip. Expanded, the label is right there — a tooltip
// repeating it would just be noise, so the attribute comes back off.
function syncNavTitles() {
  const rail = navCollapsed && window.matchMedia(DESKTOP_NAV).matches;
  for (const btn of sideNavEl.querySelectorAll(".side-nav-item")) {
    if (rail) btn.title = btn.querySelector("span")?.textContent || "";
    else btn.removeAttribute("title");
  }
}

function renderHomeGrid() {
  homeGridEl.innerHTML = livePages().filter((p) => p.key !== "home").map((p) => {
    // Only list sub-tabs when there's more than one — otherwise the card would
    // just repeat its own title.
    const tabs = tabsOfPage[p.key];
    const subs = tabs.length > 1
      ? `<span class="home-card-subs">${escapeHtml(tabs.map(tabLabel).join(" · "))}</span>`
      : "";
    return `
      <button class="home-card" data-page="${p.key}" type="button">
        <span class="home-card-icon">${pageIcon(p.key, 24)}</span>
        <span class="home-card-label">${escapeHtml(p.label)}</span>
        ${subs}
      </button>`;
  }).join("");
}

// Reflect the active page in the sidebar, the header title, and which tab
// buttons the secondary bar shows. Single-tab pages hide the bar entirely.
function applyPage(page) {
  const from = currentPage;
  currentPage = page;
  // Nutrition's tables are the widest thing in the app, so it arrives with the
  // sidebar already down to the rail. It's a loan, not a setting: step off the
  // page and the saved choice comes back (setNavCollapsed's `remember: false`).
  if (page === "nutrition") setNavCollapsed(true, { remember: false });
  else if (from === "nutrition") setNavCollapsed(navCollapsedPref, { remember: false });
  document.body.dataset.page = page;
  pageTitleEl.textContent = PAGES.find((p) => p.key === page)?.label || "Dash";
  for (const btn of sideNavEl.querySelectorAll(".side-nav-item")) {
    const active = btn.dataset.page === page;
    btn.classList.toggle("active", active);
    if (active) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  }
  for (const btn of tabBtns) {
    btn.classList.toggle("tab-off-page", (btn.dataset.page || btn.dataset.tab) !== page);
  }
  tabsWrapEl.hidden = (tabsOfPage[page] || []).length < 2;
  requestAnimationFrame(refreshTabsScroll);
}

function goToPage(page) {
  const tab = lastTabOfPage[page] || (tabsOfPage[page] || [])[0];
  if (!tab) return;
  setTab(tab);
  setNavOpen(false);
}

function setNavOpen(open) {
  document.body.classList.toggle("nav-open", open);
  navToggleBtn.setAttribute("aria-expanded", String(open));
}

// At desktop widths the sidebar is permanent rather than a drawer, so the same
// button narrows it to an icon rail instead — most of the width back for the
// wide nutrient tables, without losing the nav. The choice sticks between
// visits.
// The key is read twice: here, and by the inline script at the top of the body
// that puts the class on before the first paint — keep the two in step.
const DESKTOP_NAV = "(min-width: 900px)";
const navCollapsedKey = "dash-nav-collapsed";
let navCollapsed = false;
try { navCollapsed = localStorage.getItem(navCollapsedKey) === "1"; } catch {}
// What the saved choice was, kept apart from what's on screen: Nutrition
// collapses the rail on arrival whatever the choice, and leaving it hands the
// choice back rather than making that one visit stick.
let navCollapsedPref = navCollapsed;

function applyNavCollapsed() {
  document.body.classList.toggle("nav-collapsed", navCollapsed);
  syncNavTitles();
  if (!window.matchMedia(DESKTOP_NAV).matches) return;
  navToggleBtn.setAttribute("aria-expanded", String(!navCollapsed));
  navToggleBtn.setAttribute("aria-label", navCollapsed ? "Expand navigation" : "Collapse navigation");
}

function setNavCollapsed(collapsed, { remember = true } = {}) {
  if (collapsed === navCollapsed && !remember) return;
  navCollapsed = collapsed;
  if (remember) {
    navCollapsedPref = collapsed;
    try { localStorage.setItem(navCollapsedKey, collapsed ? "1" : "0"); } catch {}
  }
  applyNavCollapsed();
  // A table sized to the old width would keep the page scrolling sideways.
  for (const wrap of document.querySelectorAll(".ntable-wrap")) {
    if (wrap.offsetParent) fitTableToViewport(wrap);
  }
}

applyNavCollapsed();
// Crossing the breakpoint swaps which control the button is, so relabel it.
window.matchMedia(DESKTOP_NAV).addEventListener("change", applyNavCollapsed);

renderSideNav();
renderHomeGrid();
sideNavEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".side-nav-item");
  if (btn) goToPage(btn.dataset.page);
});
homeGridEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".home-card");
  if (btn) goToPage(btn.dataset.page);
});
// Either logo — the sidebar's or the header's — is the way back to Home.
for (const el of [document.getElementById("sidebar-brand"), document.getElementById("header-brand")]) {
  el?.addEventListener("click", () => goToPage("home"));
}
navToggleBtn.addEventListener("click", () => {
  // Drawer below the breakpoint, collapse above it — same button, and at each
  // width it does the only thing the sidebar can do there.
  if (window.matchMedia(DESKTOP_NAV).matches) setNavCollapsed(!navCollapsed);
  else setNavOpen(!document.body.classList.contains("nav-open"));
});
navBackdropEl.addEventListener("click", () => setNavOpen(false));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.body.classList.contains("nav-open")) setNavOpen(false);
});

const libraryListEl = document.getElementById("library-list");
const libraryBodyEl = document.getElementById("library-body");
const libraryContentEl = document.getElementById("library-content");
const libraryPlaceholderEl = document.getElementById("library-placeholder");
const libraryEditBtn = document.getElementById("library-edit-btn");
const libraryFileNameEl = document.getElementById("library-file-name");
const librarySidebar = document.getElementById("library-sidebar");
const librarySidebarToggle = document.getElementById("library-sidebar-toggle");
const libraryExpandAllBtn = document.getElementById("library-expand-all");

// Sidebar collapse — expanded by default, and on mobile it folds itself away
// as soon as a file is opened.
let librarySidebarExpanded = true;
function applyLibrarySidebarState() {
  librarySidebar.classList.toggle("collapsed", !librarySidebarExpanded);
  librarySidebarToggle.classList.toggle("collapsed", !librarySidebarExpanded);
  librarySidebarToggle.setAttribute("aria-expanded", String(librarySidebarExpanded));
  libraryListEl.hidden = !librarySidebarExpanded;
  libraryExpandAllBtn.hidden = !librarySidebarExpanded;
}
applyLibrarySidebarState();
librarySidebarToggle.addEventListener("click", () => {
  librarySidebarExpanded = !librarySidebarExpanded;
  applyLibrarySidebarState();
});

// Expand/collapse all folders
function updateLibraryExpandAllIcon() {
  const allDirs = libraryListEl.querySelectorAll(".notes-dir-toggle");
  const anyExpanded = allDirs.length > 0 && [...allDirs].some((btn) => libraryExpandedDirs.has(btn.dataset.dir));
  const plusLine = libraryExpandAllBtn.querySelector(".library-expand-plus");
  if (plusLine) plusLine.style.display = anyExpanded ? "none" : "";
  libraryExpandAllBtn.title = anyExpanded ? "Collapse all" : "Expand all";
}
libraryExpandAllBtn.addEventListener("click", () => {
  const allDirs = libraryListEl.querySelectorAll(".notes-dir-toggle");
  const anyExpanded = [...allDirs].some((btn) => libraryExpandedDirs.has(btn.dataset.dir));
  if (!anyExpanded) {
    allDirs.forEach((btn) => libraryExpandedDirs.add(btn.dataset.dir));
  } else {
    libraryExpandedDirs.clear();
  }
  persistLibraryExpanded();
  renderLibraryList(knownLibraryTree);
  updateLibraryExpandAllIcon();
});

const mainEl = document.querySelector("main");

// Track <main>'s visible height so sticky desktop sidebars (notes/dash/reports/images)
// can cap themselves correctly — the dash panel above is collapsible.
function updateMainHeightVar() {
  document.documentElement.style.setProperty("--main-h", mainEl.clientHeight + "px");
}
if (typeof ResizeObserver !== "undefined") {
  new ResizeObserver(updateMainHeightVar).observe(mainEl);
}
updateMainHeightVar();

let currentTab = "home";
// The open library file, relative to dashbook: "notes/food/chili.md".
let currentLibraryPath = null;
let libraryLoaded = false;
let knownLibraryTree = { dirs: [], files: [] };
// Which folders are open. Remembered across visits — the tree is the whole
// notebook, and reopening it fully collapsed every time buries everything.
const libraryExpandedDirs = new Set();
try {
  const saved = JSON.parse(localStorage.getItem("library-expanded-dirs") || "[]");
  if (Array.isArray(saved)) for (const d of saved) libraryExpandedDirs.add(d);
} catch {}
function persistLibraryExpanded() {
  try { localStorage.setItem("library-expanded-dirs", JSON.stringify([...libraryExpandedDirs])); } catch {}
}
function findLibraryInTree(tree, path) {
  for (const f of tree.files) if (f.path === path) return f;
  for (const d of tree.dirs) {
    const hit = findLibraryInTree(d, path);
    if (hit) return hit;
  }
  return null;
}
// The open file's text as it is on disk — what Edit starts from and what
// Cancel puts back. Empty for anything that isn't text.
let libraryRawText = "";

function enterEditMode(bodyEl, editBtn, rawMd, onSave) {
  const ta = document.createElement("textarea");
  ta.className = "md-edit-textarea";
  ta.value = rawMd;
  bodyEl.innerHTML = "";
  bodyEl.appendChild(ta);
  ta.style.height = "0";
  ta.style.height = Math.max(300, ta.scrollHeight) + "px";
  ta.addEventListener("input", () => {
    ta.style.height = "0";
    ta.style.height = Math.max(300, ta.scrollHeight) + "px";
  });

  const actions = editBtn.parentElement;
  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = "Cancel";
  cancelBtn.className = "md-edit-btn";
  const saveBtn = document.createElement("button");
  saveBtn.textContent = "Save";
  saveBtn.className = "md-edit-btn md-save-btn";
  editBtn.hidden = true;
  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  setMdMobileEditingState(true);

  function cleanup() {
    cancelBtn.remove();
    saveBtn.remove();
    editBtn.hidden = false;
    setMdMobileEditingState(false);
  }
  cancelBtn.addEventListener("click", () => {
    cleanup();
    onSave(null);
  });
  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    cancelBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    const ok = await onSave(ta.value);
    if (ok) {
      cleanup();
    } else {
      saveBtn.disabled = false;
      cancelBtn.disabled = false;
      saveBtn.textContent = "Save";
    }
  });
}

const mdMobileFooterEl = document.getElementById("md-mobile-footer");
const mdMobileFooterNameEl = document.getElementById("md-mobile-footer-name");
const mdMobileCloseBtn = document.getElementById("md-mobile-close-btn");
const mdMobileEditBtn = document.getElementById("md-mobile-edit-btn");
const mdMobileCancelBtn = document.getElementById("md-mobile-cancel-btn");
const mdMobileSaveBtn = document.getElementById("md-mobile-save-btn");

function setMdMobileEditingState(editing) {
  mdMobileCloseBtn.hidden = editing;
  mdMobileEditBtn.hidden = editing;
  mdMobileCancelBtn.hidden = !editing;
  mdMobileSaveBtn.hidden = !editing;
}

// The mobile edit bar stands in for the in-tab one, so it's on screen exactly
// when there's something to edit — an open text file, never an image or a PDF.
// Editability, not the Edit button's own `hidden`: that goes down while the
// editor is open, and the bar has to stay up through it.
function activeMdContext() {
  if (currentTab !== "library" || !currentLibraryPath) return null;
  if (!isLibraryTextPath(currentLibraryPath)) return null;
  return { name: currentLibraryPath, editBtn: libraryEditBtn };
}

function updateMdFooterVisible() {
  const ctx = activeMdContext();
  document.body.classList.toggle("md-footer-visible", !!ctx);
  if (ctx) {
    mdMobileFooterEl.hidden = false;
    mdMobileFooterNameEl.textContent = ctx.name;
    setMdMobileEditingState(!!ctx.editBtn.parentElement.querySelector(".md-edit-btn:not(#library-edit-btn)"));
  } else {
    mdMobileFooterEl.hidden = true;
    setMdMobileEditingState(false);
  }
}

mdMobileCloseBtn.addEventListener("click", () => {
  if (currentTab !== "library") return;
  deselectLibraryItem();
  // Closing a file puts the browser back — otherwise you'd be left staring at
  // the placeholder with no way back to the list but the toggle.
  if (!librarySidebarExpanded) {
    librarySidebarExpanded = true;
    applyLibrarySidebarState();
  }
});
mdMobileEditBtn.addEventListener("click", () => {
  const ctx = activeMdContext();
  if (ctx) ctx.editBtn.click();
});
mdMobileCancelBtn.addEventListener("click", () => {
  const ctx = activeMdContext();
  if (!ctx) return;
  const cancel = [...ctx.editBtn.parentElement.querySelectorAll(".md-edit-btn")]
    .find((b) => b !== ctx.editBtn && b.textContent === "Cancel");
  cancel?.click();
});
mdMobileSaveBtn.addEventListener("click", () => {
  const ctx = activeMdContext();
  if (!ctx) return;
  const save = ctx.editBtn.parentElement.querySelector(".md-edit-btn.md-save-btn");
  save?.click();
});

// `updatePath: false` is for routing that came *from* the URL (initial load,
// Back/Forward) — rewriting the path there would clobber the deep-linked file
// in `/library/notes/foo.md`, which the Library only reads once its tree data
// arrives.
function setTab(tab, { updatePath = true } = {}) {
  currentTab = tab;
  document.body.dataset.tab = tab;
  if (updatePath) updatePathForTab(tab);
  applyPage(pageOfTab[tab] || tab);
  lastTabOfPage[currentPage] = tab;
  updateMdFooterVisible();
  for (const btn of tabBtns) {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", String(active));
  }
  for (const [key, el] of Object.entries(tabPanels)) {
    el.hidden = key !== tab;
  }
  // <main> is the app's single scroll container. Reset its scrollTop to 0 for
  // every tab except chat/messages, which scroll to their bottom below. This
  // happens synchronously after the panel swap so the first painted frame is
  // already at the correct scroll — no flash.
  if (tab === "chat" || tab === "telegram") {
    mainEl.scrollTop = mainEl.scrollHeight;
  } else {
    mainEl.scrollTop = 0;
  }
  if (tab === "library" && !libraryLoaded) loadLibraryItems();
  if (tab === "system" && !systemLoaded) loadSystemConfig();
  if (tab === "health" && !healthLoaded) loadHealth();
  if (tab === "nutrition" && !nutritionLoaded) loadNutrition();
  if (tab === "groups" && !groupsLoaded) loadGroups();
  if (tab === "food-logs" && !logsLoaded) loadLogs();
  if (tab === "chat") {
    if (!chatLoaded) loadChat();
    scheduleScrollChatToBottom();
  } else if (tab === "telegram") {
    if (!messagesLoaded) loadMessages();
    // Always jump to newest when navigating to the tab. If messages aren't
    // loaded yet, renderMessages() will trigger another scroll once content
    // arrives.
    scheduleScrollMessagesToBottom();
  }
  if (tab === "finances") loadFinances();
  if (tab === "api-usage") loadApiUsage();
  if (tab === "calendar") loadCalendar();
  // Its own TTL, so coming back inside two minutes shows what's already there.
  emailTabs[tab]?.load();
  if (tab === "planner" && !timelineLoadedDate) loadTimeline(todayLocalISO());
  // Always refresh: the day shown is sticky, but its data (spend, weather) isn't.
  if (tab === "review") loadReview(reviewDate || todayLocalISO());
  if (tab === "reminders") startRemindersPolling();
  else stopRemindersPolling();
}

// ── Calendar ──────────────────────────────────────────
const calendarListEl = document.getElementById("calendar-list");
const calendarCountEl = document.getElementById("calendar-count");
let calendarLastFetched = 0;

function fmtCalDate(iso) {
  const d = new Date(iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const evDate = new Date(d);
  evDate.setHours(0, 0, 0, 0);
  if (evDate.getTime() === today.getTime()) return "Today";
  if (evDate.getTime() === tomorrow.getTime()) return "Tomorrow";
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function fmtCalTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function fmtCalRange(ev) {
  if (ev.allDay) return "All day";
  return `${fmtCalTime(ev.startDate)} – ${fmtCalTime(ev.endDate)}`;
}

function calSourceClass(ev) {
  return ev.source === "google" ? "cal-google" : "cal-apple";
}

function renderCalendarEvent(ev) {
  const loc = ev.location ? `<div class="cal-location">${escapeHtml(ev.location)}</div>` : "";
  return `
    <div class="cal-event ${calSourceClass(ev)}${ev.allDay ? " cal-allday" : ""}">
      <div class="cal-time">${fmtCalRange(ev)}</div>
      <div class="cal-details">
        <div class="cal-summary">${escapeHtml(ev.summary || "(no title)")}</div>
        ${loc}
        <div class="cal-meta">${escapeHtml(ev.calendar)}</div>
      </div>
    </div>
  `;
}

function renderCalendar(events) {
  calendarCountEl.textContent = events.length ? `${events.length} event${events.length === 1 ? "" : "s"}` : "";
  if (events.length === 0) {
    calendarListEl.innerHTML = `<div class="empty">No upcoming events.</div>`;
    return;
  }
  // Group events by date
  const groups = new Map();
  for (const ev of events) {
    const key = fmtCalDate(ev.startDate);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ev);
  }
  let html = "";
  for (const [day, evs] of groups) {
    html += `<div class="cal-day-group">`;
    html += `<div class="cal-day-label">${escapeHtml(day)}</div>`;
    html += evs.map(renderCalendarEvent).join("");
    html += `</div>`;
  }
  calendarListEl.innerHTML = html;
}

async function loadCalendar() {
  if (Date.now() - calendarLastFetched < 120_000 && calendarListEl.querySelector(".cal-event")) return;
  const hasExisting = !!calendarListEl.querySelector(".cal-event");
  if (!hasExisting) {
    calendarListEl.innerHTML = `<div class="empty">Loading…</div>`;
  }
  try {
    const res = await fetch("/api/calendar?days=7", { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    calendarLastFetched = Date.now();
    renderCalendar(data.events || []);
  } catch (err) {
    if (!hasExisting) {
      calendarListEl.innerHTML = `<div class="empty">Failed to load: ${escapeHtml(err.message)}</div>`;
    }
  }
}

// Let a textarea grow with its content instead of scrolling inside a fixed box.
function autoGrowTextarea(ta) {
  const fit = () => {
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  };
  ta.addEventListener("input", fit);
  fit();
  return fit;
}

// ── Email ──────────────────────────────────────────────
// A reader over the last 200 of each inbox, and nothing else: no sending, no
// filing, no marking read. Opening a message here leaves it exactly as Gmail
// has it, which is deliberate — the phone is still the place mail gets dealt
// with, this is the place it gets looked at.
//
// The server does the expensive half (see /api/email in bot.js): 200 rows is
// 200 Gmail calls, cached for two minutes, so switching between the two tabs is
// free and Refresh is the only thing that pays for a fetch.
const EMAIL_TTL = 120_000;

/** "Some One <a@b.c>" → "Some One"; a bare address stays as it is. */
function emailFromLabel(raw) {
  const m = (raw || "").match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (!m) return (raw || "").trim() || "(unknown sender)";
  const name = m[1].replace(/^["']|["']$/g, "").trim();
  return name || m[2];
}

/** Clock for today, month and day for this year, and the year when older. */
function fmtEmailDate(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString([], { month: "numeric", day: "numeric", year: "2-digit" });
}

function fmtEmailSize(bytes) {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

// A stranger's HTML, put on screen without letting it touch the app: sandboxed
// to an opaque origin with no script permission, and a CSP inside the document
// that blocks every remote fetch — tracking pixels included — until Show images
// is pressed. allow-popups is there for one reason, so a clicked link can open
// a tab; without allow-scripts nothing can open one on its own.
//
// White inside the frame, not the app's dark surface: these were all designed
// against white, and forcing dark on them leaves half of them unreadable.
function createEmailFrame(html, showImages) {
  const imgSrc = showImages ? "img-src data: https: http:" : "img-src data:";
  const doc = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ${imgSrc}; style-src 'unsafe-inline'; font-src data:">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base target="_blank">
<style>
  html, body { margin: 0; padding: 14px; background: #fff; color: #111;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    overflow-wrap: anywhere; }
  img, video, table, pre { max-width: 100%; }
  img { height: auto; }
  table { border-collapse: collapse; }
</style></head><body>${html}</body></html>`;

  const frame = document.createElement("iframe");
  frame.className = "email-msg-frame";
  frame.title = "Message body";
  frame.setAttribute("sandbox", "allow-popups allow-popups-to-escape-sandbox");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.srcdoc = doc;
  return frame;
}

// One of these per account. Both panels carry the same markup under an
// `email-<account>` id prefix, so the whole tab is this function twice.
function createEmailTab({ tab, account }) {
  const panelEl = document.getElementById(`tab-${tab}`);
  const listEl = document.getElementById(`${tab}-list`);
  const readerEl = document.getElementById(`${tab}-reader`);
  const placeholderEl = document.getElementById(`${tab}-placeholder`);
  const addressEl = document.getElementById(`${tab}-address`);
  const countEl = document.getElementById(`${tab}-count`);
  const filterEl = document.getElementById(`${tab}-filter`);
  const refreshBtn = document.getElementById(`${tab}-refresh`);
  const composeEl = document.getElementById(`${tab}-compose`);
  const composeBtn = document.getElementById(`${tab}-compose-btn`);

  let messages = [];
  let fetchedAt = 0;
  let staleNote = "";
  let loading = false;
  let openId = null;
  // Sent mail never changes, so a body fetched once is good for the session.
  const bodies = new Map();
  // The message being replied to, so the send threads onto it. Null for a
  // message composed from scratch.
  let replyToId = null;
  let sentTimer = null;
  // Remote images are a privacy switch, not a performance one: an <img> pointing
  // at the sender's server is how "opened at 9:04, from this IP" gets back to
  // them. On by default, the way every mail client does it — the block is there
  // for the message where it matters, and the choice sticks per account.
  const imagesKey = `dash-email-images-${account}`;
  let showImages = true;
  try { showImages = localStorage.getItem(imagesKey) !== "0"; } catch { /* private mode */ }

  function visibleMessages() {
    const q = filterEl.value.trim().toLowerCase();
    if (!q) return messages;
    return messages.filter((m) =>
      `${m.from} ${m.subject} ${m.snippet}`.toLowerCase().includes(q));
  }

  function renderRow(m) {
    return `
      <button class="email-item${m.unread ? " unread" : ""}${m.id === openId ? " active" : ""}"
              type="button" data-id="${escapeHtml(m.id)}">
        <span class="email-item-top">
          <span class="email-item-dot${m.unread ? "" : " read"}"></span>
          <span class="email-item-from">${escapeHtml(emailFromLabel(m.from))}</span>
          <span class="email-item-date">${escapeHtml(fmtEmailDate(m.internalDate))}</span>
        </span>
        <span class="email-item-subject">${escapeHtml(m.subject || "(no subject)")}</span>
        <span class="email-item-snippet">${escapeHtml(m.snippet || "")}</span>
      </button>`;
  }

  function renderList() {
    const rows = visibleMessages();
    const unread = messages.filter((m) => m.unread).length;
    const shown = rows.length === messages.length ? `${messages.length}` : `${rows.length}/${messages.length}`;
    countEl.textContent = messages.length
      ? [shown, unread ? `${unread} unread` : "", staleNote].filter(Boolean).join(" · ")
      : "";
    if (!rows.length) {
      listEl.innerHTML = `<div class="empty">${messages.length ? "Nothing matches that." : "Inbox is empty."}</div>`;
      return;
    }
    // innerHTML throws away the focused row, and with it the arrow keys — a
    // background refresh or a read/unread flip would drop the keyboard back to
    // the page. Put it on the open row again when it was in the list before.
    const hadFocus = listEl.contains(document.activeElement);
    listEl.innerHTML = rows.map(renderRow).join("");
    if (hadFocus) focusRow(openId);
  }

  /** Move the keyboard onto a row without the browser scrolling past it. */
  function focusRow(id) {
    if (!id) return;
    const btn = listEl.querySelector(`.email-item[data-id="${CSS.escape(id)}"]`);
    if (!btn) return;
    btn.focus({ preventScroll: true });
    btn.scrollIntoView({ block: "nearest" });
  }

  /**
   * Arrow keys walk the list the way a mail client does — the next message
   * opens, rather than the pane scrolling under a message that stays open.
   * Walks the filtered rows, since those are the ones on screen.
   */
  function moveSelection(delta) {
    const rows = visibleMessages();
    if (!rows.length) return;
    const at = rows.findIndex((m) => m.id === openId);
    // Nothing open yet: down starts at the top, up at the bottom.
    const next = at === -1 ? (delta > 0 ? 0 : rows.length - 1) : at + delta;
    if (next < 0 || next >= rows.length) return;
    openMessage(rows[next].id);
    focusRow(rows[next].id);
  }

  function markActive() {
    for (const btn of listEl.querySelectorAll(".email-item")) {
      btn.classList.toggle("active", btn.dataset.id === openId);
    }
  }

  function renderMessage(msg) {
    const meta = [
      ["From", msg.from],
      ["To", msg.to],
      ["Cc", msg.cc],
      ["Date", msg.internalDate ? new Date(msg.internalDate).toLocaleString() : msg.date],
      // A header the sender left off shouldn't leave its label behind.
    ].filter(([, v]) => v);
    const attachments = (msg.attachments || []).length
      ? `<div class="email-attachments">${msg.attachments.map((a) =>
          `<span class="email-attachment">${escapeHtml(a.filename)}${a.size ? ` · ${fmtEmailSize(a.size)}` : ""}</span>`
        ).join("")}</div>`
      : "";
    const html = (msg.html || "").trim();
    const imagesBtn = html
      ? `<button class="btn email-images-btn" type="button" title="${showImages
          ? "Remote images load, which tells the sender you opened this"
          : "Remote images are blocked, so senders can't see that you opened this"}">${
          showImages ? "Block images" : "Show images"}</button>`
      : "";
    // Only for mail that actually carries a List-Unsubscribe header — no button
    // on a message from a person.
    const unsubBtn = msg.unsubscribe
      ? `<button class="btn email-unsub-btn" type="button" title="${
          msg.unsubscribe.oneClick ? "One-click unsubscribe, handled here"
          : msg.unsubscribe.url ? "Opens the sender's unsubscribe page"
          : "Sends an unsubscribe email to the sender"}">Unsubscribe</button>`
      : "";

    readerEl.innerHTML = `
      <button class="email-back" type="button">← Inbox</button>
      <h3 class="email-msg-subject">${escapeHtml(msg.subject || "(no subject)")}</h3>
      <div class="email-msg-meta">${meta.map(([k, v]) =>
        `<span><b>${k}</b> ${escapeHtml(v || "")}</span>`).join("")}</div>
      <div class="email-msg-tools">
        <button class="btn email-reply-btn" type="button">Reply</button>
        <button class="btn email-unread-btn" type="button" title="Put it back in the inbox unread">Mark unread</button>${imagesBtn}${unsubBtn}${attachments}</div>
      ${html ? "" : `<pre class="email-msg-text">${escapeHtml(msg.body || msg.snippet || "(empty message)")}</pre>`}
    `;
    if (html) readerEl.appendChild(createEmailFrame(html, showImages));
    readerEl.scrollIntoView({ block: "nearest" });
  }

  function closeMessage() {
    openId = null;
    readerEl.hidden = true;
    readerEl.innerHTML = "";
    placeholderEl.hidden = false;
    panelEl.classList.remove("email-reading");
    markActive();
  }

  /**
   * Flip the UNREAD label, locally first so the row responds to the click and
   * not to the round trip. A failure puts the old state back — the label on
   * Gmail's side didn't change, and the list shouldn't claim it did.
   */
  async function setRead(id, read) {
    const row = messages.find((m) => m.id === id);
    const was = row?.unread;
    if (row) { row.unread = !read; renderList(); }
    const body = bodies.get(id);
    if (body) body.unread = !read;
    try {
      const res = await fetch("/api/email/mark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account, id, read }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      if (row) { row.unread = was; renderList(); }
      if (body) body.unread = was;
    }
  }

  async function openMessage(id) {
    openId = id;
    markActive();
    panelEl.classList.add("email-reading");
    placeholderEl.hidden = true;
    readerEl.hidden = false;
    // Opening it is reading it. Fired here rather than after the body arrives
    // so the row clears immediately, and only when there's something to clear.
    if (messages.find((m) => m.id === id)?.unread) setRead(id, true);

    const cached = bodies.get(id);
    if (cached) { renderMessage(cached); return; }

    readerEl.innerHTML = `<button class="email-back" type="button">← Inbox</button><div class="empty">Loading…</div>`;
    try {
      const res = await fetch(
        `/api/email/message?account=${encodeURIComponent(account)}&id=${encodeURIComponent(id)}`,
        { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      bodies.set(id, data.message);
      // Another row may have been clicked while this was in flight.
      if (openId === id) renderMessage(data.message);
    } catch (err) {
      if (openId !== id) return;
      readerEl.innerHTML = `<button class="email-back" type="button">← Inbox</button>
        <div class="empty">Couldn't open that message: ${escapeHtml(err.message)}</div>`;
    }
  }

  async function load({ force = false } = {}) {
    if (loading) return;
    if (!force && messages.length && Date.now() - fetchedAt < EMAIL_TTL) return;
    loading = true;
    refreshBtn.disabled = true;
    if (!messages.length) listEl.innerHTML = `<div class="empty">Loading…</div>`;
    try {
      const res = await fetch(`/api/email?account=${encodeURIComponent(account)}${force ? "&refresh=1" : ""}`,
        { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      messages = data.messages || [];
      fetchedAt = Date.now();
      // The server falls back to its last good copy when Gmail is unreachable,
      // and says so — worth showing rather than pretending it's current.
      staleNote = data.stale ? "last known" : "";
      addressEl.textContent = data.address || "";
      renderList();
    } catch (err) {
      if (!messages.length) {
        listEl.innerHTML = `<div class="empty">Failed to load: ${escapeHtml(err.message)}</div>`;
      }
    } finally {
      loading = false;
      refreshBtn.disabled = false;
    }
  }

  // ── Compose ──
  // Plain text only, which is what the send path builds. Values are assigned
  // rather than interpolated into the markup — a quoted reply is full of the
  // characters that would otherwise need escaping twice.
  const composeField = (name) => composeEl.querySelector(`[data-field="${name}"]`);

  function openCompose({ to = "", cc = "", subject = "", body = "", replyToMessageId = null, title = "New message" } = {}) {
    clearTimeout(sentTimer);
    replyToId = replyToMessageId;
    composeEl.hidden = false;
    composeEl.innerHTML = `
      <div class="email-compose-head">
        <span class="email-compose-title">${escapeHtml(title)}</span>
        <span class="email-compose-from">from ${escapeHtml(addressEl.textContent || account)}</span>
        <button class="btn email-ai-btn" type="button">Ask Dash</button>
        <button class="email-compose-close" type="button" aria-label="Discard">×</button>
      </div>
      <div class="email-ai" hidden>
        <textarea class="email-ai-text" rows="2"
          placeholder="Tell Dash what to write — e.g. decline politely and suggest next Tuesday, or tighten this up"></textarea>
        <div class="email-ai-actions">
          <button class="btn primary email-ai-submit" type="button">Draft it</button>
          <button class="btn email-ai-undo" type="button" hidden>Undo</button>
          <span class="email-ai-status"></span>
        </div>
      </div>
      <input class="email-compose-input" data-field="to" type="text" placeholder="To" autocomplete="off" />
      <input class="email-compose-input" data-field="cc" type="text" placeholder="Cc (optional)" autocomplete="off" />
      <input class="email-compose-input" data-field="subject" type="text" placeholder="Subject" autocomplete="off" />
      <textarea class="email-compose-body" data-field="body" rows="12" placeholder="Write your message…"></textarea>
      <div class="email-compose-actions">
        <button class="btn primary email-compose-send" type="button">Send</button>
        <button class="btn email-compose-cancel" type="button">Cancel</button>
        <span class="email-compose-status"></span>
      </div>`;
    composeField("to").value = to;
    composeField("cc").value = cc;
    composeField("subject").value = subject;
    composeField("body").value = body;
    composeEl.scrollIntoView({ block: "nearest" });
    // A reply already knows who and what it is — the cursor belongs above the
    // quoted text, not in the To field.
    if (to) {
      composeField("body").focus();
      composeField("body").setSelectionRange(0, 0);
    } else {
      composeField("to").focus();
    }
  }

  function closeCompose() {
    clearTimeout(sentTimer);
    replyToId = null;
    undoDraft = null;
    composeEl.hidden = true;
    composeEl.innerHTML = "";
  }

  function startReply(msg) {
    const subject = /^\s*re:/i.test(msg.subject || "")
      ? msg.subject
      : `Re: ${msg.subject || ""}`.trim();
    const when = msg.internalDate ? new Date(msg.internalDate).toLocaleString() : msg.date;
    // `text` is the real plain-text part — HTML-only mail has none, and quotes
    // its snippet rather than dumping markup into the reply.
    const source = (msg.text || "").trim() || msg.snippet || "";
    const quoted = source.slice(0, 4000).split("\n").map((l) => `> ${l}`).join("\n");
    openCompose({
      title: "Reply",
      // Reply-To is the address the sender asked to be answered on, when they
      // set one; otherwise it's whoever sent it.
      to: msg.replyTo || msg.from,
      subject,
      replyToMessageId: msg.id,
      body: `\n\nOn ${when}, ${emailFromLabel(msg.from)} wrote:\n${quoted}\n`,
    });
  }

  /**
   * The confirm names where it's going — the host for a URL, the address for a
   * mailto — because that destination came out of the email itself, and the
   * sender chose it. The URL is never sent from here; the server reads it back
   * off the message.
   */
  async function unsubscribe(btn) {
    const msg = bodies.get(openId);
    if (!msg?.unsubscribe) return;
    const { url, mailto, oneClick } = msg.unsubscribe;
    const where = url ? new URL(url).host : (mailto || "").replace(/^mailto:/i, "").split("?")[0];
    const what = oneClick
      ? `Unsubscribe from this sender?\n\nOne-click request to ${where}.`
      : url
        ? `Open the unsubscribe page for ${where}?\n\nIt opens in a new tab — you finish it there.`
        : `Send an unsubscribe email to ${where}?`;
    if (!confirm(what)) return;

    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Unsubscribing…";
    try {
      const res = await fetch("/api/email/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account, id: openId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (data.action === "open") {
        // Popup blockers only allow this because it's inside the click.
        window.open(data.url, "_blank", "noopener,noreferrer");
        btn.textContent = "Opened";
      } else {
        btn.textContent = data.action === "mailto" ? "Unsubscribe sent" : "Unsubscribed";
      }
    } catch (err) {
      btn.disabled = false;
      btn.textContent = label;
      alert(`Unsubscribe failed: ${err.message}`);
    }
  }

  // ── Ask Dash ──
  // Drafts into the form rather than into a chat panel: the result is the email,
  // so it belongs in the fields Steve is about to send. One level of undo, since
  // it overwrites what he'd already typed.
  let undoDraft = null;

  async function askDash() {
    const aiEl = composeEl.querySelector(".email-ai");
    const textEl = aiEl.querySelector(".email-ai-text");
    const statusEl = aiEl.querySelector(".email-ai-status");
    const submitBtn = aiEl.querySelector(".email-ai-submit");
    const undoBtn = aiEl.querySelector(".email-ai-undo");
    const question = textEl.value.trim();
    if (!question) { textEl.focus(); return; }

    submitBtn.disabled = true;
    statusEl.textContent = "Thinking…";
    try {
      const res = await fetch("/api/email/assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account,
          text: question,
          replyToMessageId: replyToId || "",
          draft: {
            to: composeField("to").value,
            cc: composeField("cc").value,
            subject: composeField("subject").value,
            body: composeField("body").value,
          },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      undoDraft = {
        subject: composeField("subject").value,
        body: composeField("body").value,
      };
      // An empty subject back means "leave it alone" — don't wipe a good one.
      if (data.subject) composeField("subject").value = data.subject;
      if (data.body) composeField("body").value = data.body;
      undoBtn.hidden = false;
      statusEl.textContent = data.note || "Drafted — read it before sending.";
    } catch (err) {
      statusEl.textContent = `Failed: ${err.message}`;
    } finally {
      submitBtn.disabled = false;
    }
  }

  async function sendCompose() {
    const statusEl = composeEl.querySelector(".email-compose-status");
    const sendBtn = composeEl.querySelector(".email-compose-send");
    const to = composeField("to").value.trim();
    const subject = composeField("subject").value.trim();
    if (!to) {
      statusEl.textContent = "Needs a recipient.";
      composeField("to").focus();
      return;
    }
    // The only thing on this page that can't be taken back, so it asks.
    if (!confirm(`Send to ${to}?\n\nSubject: ${subject || "(none)"}`)) return;

    sendBtn.disabled = true;
    statusEl.textContent = "Sending…";
    try {
      const res = await fetch("/api/email/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account,
          to,
          cc: composeField("cc").value.trim(),
          subject,
          body: composeField("body").value,
          replyToMessageId: replyToId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      replyToId = null;
      composeEl.innerHTML = `<div class="email-compose-sent">Sent to ${escapeHtml(to)}.</div>`;
      sentTimer = setTimeout(closeCompose, 5000);
    } catch (err) {
      statusEl.textContent = `Failed: ${err.message}`;
      sendBtn.disabled = false;
    }
  }

  listEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".email-item");
    if (!btn) return;
    openMessage(btn.dataset.id);
    // Safari doesn't focus a button on click, so the arrows would do nothing
    // until you'd tabbed into the list. Clicking a row is picking it — take
    // the keyboard with it.
    focusRow(btn.dataset.id);
  });
  // Only while the list has the keyboard — arrows inside the reader, the filter
  // box or the compose form still mean what they always did.
  listEl.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    moveSelection(e.key === "ArrowDown" ? 1 : -1);
  });
  // Delegated so the Back button works while a body is still loading, too.
  readerEl.addEventListener("click", (e) => {
    if (e.target.closest(".email-back")) { closeMessage(); return; }
    if (e.target.closest(".email-reply-btn")) {
      const msg = bodies.get(openId);
      if (msg) startReply(msg);
      return;
    }
    // Marking unread closes the message, the way every mail client does it —
    // and it sidesteps the obvious trap, where a message left open and unread
    // gets marked read again the moment you come back to it.
    if (e.target.closest(".email-unread-btn")) {
      setRead(openId, false);
      closeMessage();
      return;
    }
    if (e.target.closest(".email-unsub-btn")) {
      unsubscribe(e.target.closest(".email-unsub-btn"));
      return;
    }
    if (e.target.closest(".email-images-btn")) {
      showImages = !showImages;
      try { localStorage.setItem(imagesKey, showImages ? "1" : "0"); } catch { /* private mode */ }
      const msg = bodies.get(openId);
      if (msg) renderMessage(msg);
    }
  });
  composeEl.addEventListener("click", (e) => {
    if (e.target.closest(".email-compose-send")) { sendCompose(); return; }
    if (e.target.closest(".email-compose-cancel") || e.target.closest(".email-compose-close")) { closeCompose(); return; }
    if (e.target.closest(".email-ai-btn")) {
      const aiEl = composeEl.querySelector(".email-ai");
      aiEl.hidden = !aiEl.hidden;
      if (!aiEl.hidden) aiEl.querySelector(".email-ai-text").focus();
      return;
    }
    if (e.target.closest(".email-ai-submit")) { askDash(); return; }
    if (e.target.closest(".email-ai-undo")) {
      if (!undoDraft) return;
      composeField("subject").value = undoDraft.subject;
      composeField("body").value = undoDraft.body;
      undoDraft = null;
      e.target.closest(".email-ai-undo").hidden = true;
      composeEl.querySelector(".email-ai-status").textContent = "Put back.";
    }
  });
  // Cmd/Ctrl+Enter submits the instruction, the way the textarea invites.
  composeEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && e.target.closest(".email-ai-text")) {
      e.preventDefault();
      askDash();
    }
  });
  composeBtn.addEventListener("click", () => openCompose());
  filterEl.addEventListener("input", renderList);
  refreshBtn.addEventListener("click", () => load({ force: true }));

  return { load };
}

const emailTabs = {
  "email-personal": createEmailTab({ tab: "email-personal", account: "personal" }),
  "email-professional": createEmailTab({ tab: "email-professional", account: "professional" }),
  // Dash's own inbox (dashbot.assistant@gmail.com). Mostly already read — the
  // inbox-poll job forwards new mail to Telegram and marks it read behind it.
  "email-dashbot": createEmailTab({ tab: "email-dashbot", account: "dashbot" }),
};

// ── Timeline (day planner) ────────────────────────────
const timelineListEl = document.getElementById("timeline-list");
const timelineDateInput = document.getElementById("timeline-date-input");
const timelinePrevBtn = document.getElementById("timeline-prev-btn");
const timelineNextBtn = document.getElementById("timeline-next-btn");
const timelineTodayBtn = document.getElementById("timeline-today-btn");
const timelineAddBtn = document.getElementById("timeline-add-btn");
const timelineSaveBtn = document.getElementById("timeline-save-btn");
const timelineCancelBtn = document.getElementById("timeline-cancel-btn");
const timelineCopyBtn = document.getElementById("timeline-copy-btn");
const timelineCalendarBtn = document.getElementById("timeline-calendar-btn");
const timelineSyncWeekBtn = document.getElementById("timeline-sync-week-btn");
const timelineAllDayEl = document.getElementById("timeline-allday");
const timelineCopyPanel = document.getElementById("timeline-copy-panel");
const timelineCopyDateInput = document.getElementById("timeline-copy-date-input");
const timelineCopyConfirmBtn = document.getElementById("timeline-copy-confirm-btn");
const timelineCopyCancelBtn = document.getElementById("timeline-copy-cancel-btn");
const timelineCopyMsg = document.getElementById("timeline-copy-msg");
const timelineVizTrackEl = document.getElementById("timeline-viz-track");
const timelineVizAboveEl = document.getElementById("timeline-viz-above");
const timelineVizBelowEl = document.getElementById("timeline-viz-below");
const timelineVizTicksEl = document.getElementById("timeline-viz-ticks");
const timelineVizEl = document.getElementById("timeline-viz");
const timelineOrientationBtn = document.getElementById("timeline-orientation-btn");
const TIMELINE_VIZ_COLORS = ["var(--accent)", "var(--green)", "var(--amber)", "var(--purple)"];

let timelineBlocks = [];
let timelineAllDay = [];
let timelineSavedSnapshot = [];
let timelineLoadedDate = null;
let timelineDirty = false;
let timelineRenderTimer = null;
let timelineRenderTimerRowIdx = null;
// Horizontal on every screen size, phones included — the toggle is there when a
// day is dense enough to want the vertical read. Review inherits this default.
let timelineOrientation = localStorage.getItem("dash-timeline-orientation") || "horizontal";

// Drawn rather than typed: the ↕/↔ characters fall back to a system font on
// iOS that draws them small and low in the em box, so they never matched the
// desktop glyph. An SVG is the same size and position everywhere.
const ORIENTATION_SVG = {
  vertical: '<path d="M12 4.5v15M8.5 8 12 4.5 15.5 8M8.5 16 12 19.5 15.5 16"/>',
  horizontal: '<path d="M4.5 12h15M8 8.5 4.5 12 8 15.5M16 8.5 19.5 12 16 15.5"/>',
};

function orientationToggleHtml(orientation) {
  // The button offers the orientation you aren't in.
  const next = orientation === "horizontal" ? "vertical" : "horizontal";
  const word = next === "vertical" ? "Vertical" : "Horizontal";
  return `<svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ORIENTATION_SVG[next]}</svg><span class="btn-label">${word}</span>`;
}

function applyTimelineOrientation() {
  timelineVizEl.dataset.orientation = timelineOrientation;
  const next = timelineOrientation === "horizontal" ? "vertical" : "horizontal";
  timelineOrientationBtn.innerHTML = orientationToggleHtml(timelineOrientation);
  timelineOrientationBtn.setAttribute("aria-label", `Switch to ${next} planner view`);
}
applyTimelineOrientation();

timelineOrientationBtn.addEventListener("click", () => {
  timelineOrientation = timelineOrientation === "horizontal" ? "vertical" : "horizontal";
  localStorage.setItem("dash-timeline-orientation", timelineOrientation);
  applyTimelineOrientation();
  renderTimelineViz();
});

function todayLocalISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function isoWithOffset(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

function refreshTimelineButtons() {
  const hasInvalid = !!timelineListEl.querySelector(".invalid");
  timelineSaveBtn.disabled = !timelineDirty || hasInvalid;
  timelineCancelBtn.disabled = !timelineDirty;
}

function setTimelineDirty(dirty) {
  timelineDirty = dirty;
  refreshTimelineButtons();
}

function timelineDurationLabel(start, end) {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins < 0) mins += 24 * 60;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function renderTimelineBlock(b, idx) {
  // Calendar-owned rows are read-only: the hourly sync rewrites them from the
  // calendar, so any edit made here would silently disappear. Edit the event in
  // the calendar instead.
  const fromCal = b.source === "calendar";
  const ro = fromCal ? " readonly disabled" : "";
  const calTip = "From your calendar — edit it in the calendar, not here";
  return `
    <div class="timeline-block${fromCal ? " from-calendar" : ""}" data-idx="${idx}"${fromCal ? ` title="${attrEscape(calTip)}"` : ""}>
      <div class="timeline-block-time">
        <input type="time" class="timeline-input" data-field="start" value="${attrEscape(b.start)}"${ro} />
        <span class="timeline-time-sep">–</span>
        <input type="time" class="timeline-input" data-field="end" value="${attrEscape(b.end)}"${ro} />
        <span class="timeline-duration">${escapeHtml(timelineDurationLabel(b.start, b.end))}</span>
      </div>
      <input type="text" class="timeline-input timeline-title" data-field="title" placeholder="What's happening?" value="${attrEscape(b.title || "")}"${ro} />
      ${fromCal ? `<span class="timeline-cal-badge" title="${attrEscape(calTip)}">cal</span>` : ""}
      ${fromCal
        ? `<button class="timeline-delete" disabled aria-label="Calendar events can't be deleted here" title="${attrEscape(calTip)}">×</button>`
        : `<button class="timeline-delete" data-idx="${idx}" aria-label="Delete block">×</button>`}
    </div>
  `;
}

function renderTimelineAllDay() {
  if (!timelineAllDayEl) return;
  if (timelineAllDay.length === 0) {
    timelineAllDayEl.hidden = true;
    timelineAllDayEl.innerHTML = "";
    return;
  }
  timelineAllDayEl.hidden = false;
  timelineAllDayEl.innerHTML =
    `<span class="timeline-allday-label">All-day</span>` +
    timelineAllDay.map(() => `<span class="timeline-allday-pill"></span>`).join("");
  // Titles come from the calendar — set as text so they can't inject markup.
  const pills = timelineAllDayEl.querySelectorAll(".timeline-allday-pill");
  timelineAllDay.forEach((a, i) => {
    if (pills[i]) pills[i].textContent = a.title || "(untitled)";
  });
}

function fmtTimelineClock(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const period = h < 12 ? "a" : "p";
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return m === 0 ? `${h12}${period}` : `${h12}:${String(m).padStart(2, "0")}${period}`;
}

// The visual is a window onto the blocks actually scheduled that day, not the
// full 24h — it grows/shrinks to fit the earliest start and latest end
// (rounded out to the hour), falling back to a default workday window when
// there are no blocks. The editor below still accepts any time.
const TIMELINE_VIZ_DEFAULT_START_MIN = 5 * 60;
const TIMELINE_VIZ_DEFAULT_END_MIN = 21 * 60;
const TIMELINE_VIZ_MIN_SPAN_MIN = 3 * 60;
// Breathing room kept at both ends of the chart, before hour snapping.
const TIMELINE_VIZ_EDGE_PAD_MIN = 15;
// Must match the vertical track/label-column height (102rem) in styles.css.
const TIMELINE_VIZ_VERTICAL_TRACK_PX = 1632;
const TIMELINE_VIZ_LABEL_MIN_GAP_PX = 44;

let TIMELINE_VIZ_START_MIN = TIMELINE_VIZ_DEFAULT_START_MIN;
let TIMELINE_VIZ_END_MIN = TIMELINE_VIZ_DEFAULT_END_MIN;
let TIMELINE_VIZ_SPAN_MIN = TIMELINE_VIZ_END_MIN - TIMELINE_VIZ_START_MIN;

function computeTimelineVizRange(blocks) {
  if (!blocks.length) {
    return { start: TIMELINE_VIZ_DEFAULT_START_MIN, end: TIMELINE_VIZ_DEFAULT_END_MIN };
  }
  let min = Infinity;
  let max = -Infinity;
  blocks.forEach((b) => {
    const s = timeToMinutes(b.start);
    const e = Math.max(timeToMinutes(b.end), s + 1);
    if (s < min) min = s;
    if (e > max) max = e;
  });
  // Pad before snapping to the hour so the first and last block are never flush
  // against the edge. That margin is what gives drags room to move a block
  // outward — earned statically here rather than by expanding on pointerdown,
  // which made the whole chart jump the moment you touched a block.
  let start = Math.floor((min - TIMELINE_VIZ_EDGE_PAD_MIN) / 60) * 60;
  let end = Math.ceil((max + TIMELINE_VIZ_EDGE_PAD_MIN) / 60) * 60;
  if (end - start < TIMELINE_VIZ_MIN_SPAN_MIN) {
    const extra = TIMELINE_VIZ_MIN_SPAN_MIN - (end - start);
    start -= Math.ceil(extra / 2);
    end += Math.floor(extra / 2);
  }
  start = Math.max(start, 0);
  end = Math.min(end, 24 * 60);
  return { start, end };
}

function timelineVizPct(min) {
  const clamped = Math.min(Math.max(min, TIMELINE_VIZ_START_MIN), TIMELINE_VIZ_END_MIN);
  return ((clamped - TIMELINE_VIZ_START_MIN) / TIMELINE_VIZ_SPAN_MIN) * 100;
}

// ── Dragging blocks in the visualization ────────────────
// Only manual blocks move; calendar-owned ones are re-synced hourly so any
// edit here would be silently reverted.
const TIMELINE_DRAG_SNAP_MIN = 5;
const TIMELINE_DRAG_MIN_DURATION = 5;

let timelineDrag = null;
let timelineVizFrozenRange = null;
let timelineDragFrame = null;

function minutesToTime(min) {
  const m = Math.round(min);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function snapDragMinutes(min) {
  return Math.round(min / TIMELINE_DRAG_SNAP_MIN) * TIMELINE_DRAG_SNAP_MIN;
}

function clampNum(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

/** Pointer position → minutes on whichever axis the current orientation uses. */
function timelineVizPointerMinutes(e) {
  const rect = timelineVizTrackEl.getBoundingClientRect();
  const vertical = timelineOrientation === "vertical";
  const size = vertical ? rect.height : rect.width;
  if (!size) return TIMELINE_VIZ_START_MIN;
  const offset = vertical ? e.clientY - rect.top : e.clientX - rect.left;
  return TIMELINE_VIZ_START_MIN + (offset / size) * TIMELINE_VIZ_SPAN_MIN;
}

/** Keep the editor row below in step with the bar being dragged. */
function syncTimelineRowInputs(block) {
  const idx = timelineBlocks.indexOf(block);
  const row = timelineListEl.querySelector(`.timeline-block[data-idx="${idx}"]`);
  if (!row) return;
  const startInput = row.querySelector('[data-field="start"]');
  const endInput = row.querySelector('[data-field="end"]');
  if (startInput) startInput.value = block.start;
  if (endInput) endInput.value = block.end;
  const dur = row.querySelector(".timeline-duration");
  if (dur) dur.textContent = timelineDurationLabel(block.start, block.end);
}

function scheduleTimelineDragFrame(block) {
  if (timelineDragFrame) return;
  timelineDragFrame = requestAnimationFrame(() => {
    timelineDragFrame = null;
    renderTimelineViz();
    syncTimelineRowInputs(block);
  });
}

function onTimelineVizPointerDown(e) {
  if (e.button != null && e.button !== 0) return;
  const seg = e.target.closest(".timeline-viz-segment");
  if (!seg || !seg.dataset.manual) return;
  const block = timelineBlocks.find((b) => b.id === seg.dataset.blockId);
  if (!block) return;

  const edge = e.target.closest(".timeline-viz-handle")?.dataset.edge;
  const mode = edge === "start" ? "resize-start" : edge === "end" ? "resize-end" : "move";

  // Pin the axis exactly as it is. Recomputing it mid-drag would rescale under
  // the cursor; changing it *here* would make the chart jump on every click.
  // The room to drag outward comes from TIMELINE_VIZ_EDGE_PAD_MIN instead.
  timelineVizFrozenRange = { start: TIMELINE_VIZ_START_MIN, end: TIMELINE_VIZ_END_MIN };

  timelineDrag = {
    id: block.id,
    mode,
    grabMin: timelineVizPointerMinutes(e),
    origStart: timeToMinutes(block.start),
    origEnd: timeToMinutes(block.end),
    moved: false,
  };
  // Capture on the container rather than the bar — the bar is destroyed on every
  // re-render, which would drop the capture mid-drag.
  try { timelineVizEl.setPointerCapture(e.pointerId); } catch {}
  timelineVizEl.classList.add("dragging");
  e.preventDefault();
}

function onTimelineVizPointerMove(e) {
  if (!timelineDrag) return;
  const block = timelineBlocks.find((b) => b.id === timelineDrag.id);
  if (!block) return;

  const delta = timelineVizPointerMinutes(e) - timelineDrag.grabMin;
  const winStart = TIMELINE_VIZ_START_MIN;
  const winEnd = TIMELINE_VIZ_END_MIN;
  let start = timelineDrag.origStart;
  let end = timelineDrag.origEnd;

  if (timelineDrag.mode === "move") {
    const duration = end - start;
    start = clampNum(snapDragMinutes(timelineDrag.origStart + delta), winStart, winEnd - duration);
    end = start + duration;
  } else if (timelineDrag.mode === "resize-start") {
    start = clampNum(snapDragMinutes(timelineDrag.origStart + delta), winStart, end - TIMELINE_DRAG_MIN_DURATION);
  } else {
    end = clampNum(snapDragMinutes(timelineDrag.origEnd + delta), start + TIMELINE_DRAG_MIN_DURATION, winEnd);
  }

  const nextStart = minutesToTime(start);
  const nextEnd = minutesToTime(end);
  if (nextStart === block.start && nextEnd === block.end) return;
  block.start = nextStart;
  block.end = nextEnd;
  timelineDrag.moved = true;
  scheduleTimelineDragFrame(block);
}

function onTimelineVizPointerUp(e) {
  if (!timelineDrag) return;
  const moved = timelineDrag.moved;
  timelineDrag = null;
  timelineVizFrozenRange = null;
  if (timelineDragFrame) {
    cancelAnimationFrame(timelineDragFrame);
    timelineDragFrame = null;
  }
  timelineVizEl.classList.remove("dragging");
  try { timelineVizEl.releasePointerCapture(e.pointerId); } catch {}
  if (moved) {
    setTimelineDirty(true);
    renderTimeline();
  } else {
    renderTimelineViz();
  }
}

if (timelineVizTrackEl) {
  timelineVizTrackEl.addEventListener("pointerdown", onTimelineVizPointerDown);
  timelineVizEl.addEventListener("pointermove", onTimelineVizPointerMove);
  timelineVizEl.addEventListener("pointerup", onTimelineVizPointerUp);
  timelineVizEl.addEventListener("pointercancel", onTimelineVizPointerUp);
}

/**
 * Draw the day chart — segments on the track plus the cascaded labels around
 * it. Shared by the planner and the Review tab: `interactive` is what adds the
 * planner's drag affordances, so Review renders the identical chart with no
 * handles and no drag classes.
 */
function renderDayViz({ blocks, orientation, range, els, interactive }) {
  const vertical = orientation === "vertical";
  const sorted = [...blocks].sort((a, b) => a.start.localeCompare(b.start));
  const spanMin = range.end - range.start;
  const pct = (min) => ((Math.min(Math.max(min, range.start), range.end) - range.start) / spanMin) * 100;

  renderVizTicks(els.ticksEl, range);

  els.trackEl.innerHTML = sorted.map((b, i) => {
    const startMin = timeToMinutes(b.start);
    const endMin = Math.max(timeToMinutes(b.end), startMin + 1);
    if (endMin <= range.start || startMin >= range.end) return "";
    const from = pct(startMin);
    const span = Math.max(pct(endMin) - from, 0.3);
    const color = TIMELINE_VIZ_COLORS[i % TIMELINE_VIZ_COLORS.length];
    const title = b.title || "Untitled";
    const posStyle = vertical ? `top:${from}%;height:${span}%` : `left:${from}%;width:${span}%`;
    // Calendar-owned blocks aren't draggable — the next sync would undo it.
    const manual = interactive && b.source !== "calendar";
    const hint = manual ? " · drag to move · drag an edge to resize" : b.source === "calendar" ? " · from calendar" : "";
    const handles = manual
      ? `<span class="timeline-viz-handle" data-edge="start"></span><span class="timeline-viz-handle" data-edge="end"></span>`
      : "";
    return `<div class="timeline-viz-segment${manual ? " draggable" : ""}"${manual ? ' data-manual="1"' : ""} data-block-id="${attrEscape(b.id)}" style="${posStyle};background:${color}" title="${attrEscape(`${title} · ${fmtTimelineClock(b.start)}–${fmtTimelineClock(b.end)}${hint}`)}">${handles}</div>`;
  }).join("");

  const aboveHtml = [];
  const belowHtml = [];

  if (vertical) {
    // Dense clusters (several blocks close in time) would otherwise overlap
    // when placed at their exact time position, so the label boxes get
    // cascaded apart while a separate dot + riser line keeps the true time
    // marked on the track.
    const items = [];
    sorted.forEach((b, i) => {
      const startMin = timeToMinutes(b.start);
      const endMin = Math.max(timeToMinutes(b.end), startMin + 1);
      if (endMin <= range.start || startMin >= range.end) return;
      const anchorPct = (pct(startMin) + pct(endMin)) / 2;
      items.push({ b, anchorPct, color: TIMELINE_VIZ_COLORS[i % TIMELINE_VIZ_COLORS.length] });
    });
    let cursorPx = -Infinity;
    items.forEach(({ b, anchorPct, color }) => {
      const anchorPx = (anchorPct / 100) * TIMELINE_VIZ_VERTICAL_TRACK_PX;
      const displayPx = Math.max(anchorPx, cursorPx + TIMELINE_VIZ_LABEL_MIN_GAP_PX);
      cursorPx = displayPx;
      const displayPct = (displayPx / TIMELINE_VIZ_VERTICAL_TRACK_PX) * 100;
      const textGroup = `<span class="timeline-viz-label-text"><span class="timeline-viz-label-box">${escapeHtml(b.title || "Untitled")}</span><span class="timeline-viz-label-time">${escapeHtml(fmtTimelineClock(b.start))}–${escapeHtml(fmtTimelineClock(b.end))}</span></span>`;
      const stub = `<span class="timeline-viz-connector" style="background:${color}"></span>`;
      aboveHtml.push(`<div class="timeline-viz-anchor-dot" style="top:${anchorPct}%;background:${color}"></div>`);
      const riserTop = Math.min(anchorPct, displayPct);
      const riserHeight = Math.abs(displayPct - anchorPct);
      if (riserHeight > 0.05) {
        aboveHtml.push(`<div class="timeline-viz-riser" style="top:${riserTop}%;height:${riserHeight}%;background:${color}"></div>`);
      }
      aboveHtml.push(`<div class="timeline-viz-label" data-block-id="${attrEscape(b.id)}" style="top:${displayPct}%">${stub}${textGroup}</div>`);
    });
  } else {
    sorted.forEach((b, i) => {
      const startMin = timeToMinutes(b.start);
      const endMin = Math.max(timeToMinutes(b.end), startMin + 1);
      if (endMin <= range.start || startMin >= range.end) return;
      const center = (pct(startMin) + pct(endMin)) / 2;
      const color = TIMELINE_VIZ_COLORS[i % TIMELINE_VIZ_COLORS.length];
      const textGroup = `<span class="timeline-viz-label-text"><span class="timeline-viz-label-box">${escapeHtml(b.title || "Untitled")}</span><span class="timeline-viz-label-time">${escapeHtml(fmtTimelineClock(b.start))}–${escapeHtml(fmtTimelineClock(b.end))}</span></span>`;
      const connector = `<span class="timeline-viz-connector" style="background:${color}"></span>`;
      const dot = `<span class="timeline-viz-dot" style="background:${color}"></span>`;
      const html = i % 2 === 0
        ? `<div class="timeline-viz-label" data-block-id="${attrEscape(b.id)}" style="left:${center}%">${textGroup}${connector}${dot}</div>`
        : `<div class="timeline-viz-label" data-block-id="${attrEscape(b.id)}" style="left:${center}%">${dot}${connector}${textGroup}</div>`;
      (i % 2 === 0 ? aboveHtml : belowHtml).push(html);
    });
  }
  els.aboveEl.innerHTML = aboveHtml.join("");
  els.belowEl.innerHTML = vertical ? "" : belowHtml.join("");
}

function renderTimelineViz() {
  if (!timelineVizTrackEl) return;

  // While a block is being dragged the window is pinned. Recomputing it mid-drag
  // would rescale the axis under the cursor and the block would run away.
  const range = timelineVizFrozenRange || computeTimelineVizRange(timelineBlocks);
  // The drag math reads the window off these globals.
  TIMELINE_VIZ_START_MIN = range.start;
  TIMELINE_VIZ_END_MIN = range.end;
  TIMELINE_VIZ_SPAN_MIN = TIMELINE_VIZ_END_MIN - TIMELINE_VIZ_START_MIN;

  renderDayViz({
    blocks: timelineBlocks,
    orientation: timelineOrientation,
    range,
    els: {
      trackEl: timelineVizTrackEl,
      aboveEl: timelineVizAboveEl,
      belowEl: timelineVizBelowEl,
      ticksEl: timelineVizTicksEl,
    },
    interactive: true,
  });
}

function fmtTimelineClockMin(min) {
  const h = Math.floor(min / 60) % 24;
  const m = Math.round(min) % 60;
  return fmtTimelineClock(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
}

const TIMELINE_VIZ_TICK_COUNT = 5;

function renderVizTicks(ticksEl, range) {
  if (!ticksEl) return;
  const labels = [];
  for (let i = 0; i < TIMELINE_VIZ_TICK_COUNT; i++) {
    const min = range.start + ((range.end - range.start) * i) / (TIMELINE_VIZ_TICK_COUNT - 1);
    labels.push(fmtTimelineClockMin(min));
  }
  ticksEl.innerHTML = labels.map((l) => `<span>${l}</span>`).join("");
}

function scheduleTimelineReorder(rowIdx) {
  clearTimeout(timelineRenderTimer);
  timelineRenderTimerRowIdx = rowIdx;
  timelineRenderTimer = setTimeout(() => {
    timelineRenderTimer = null;
    timelineRenderTimerRowIdx = null;
    renderTimeline();
  }, 3000);
}

function wireTimelineInputs() {
  timelineListEl.querySelectorAll(".timeline-input").forEach((input) => {
    input.addEventListener("input", () => updateTimelineField(input));
    if (input.dataset.field === "start" || input.dataset.field === "end") {
      const rowIdx = input.closest(".timeline-block")?.dataset.idx;
      // Leaving either time input on this block starts a 3s countdown to
      // reorder the list. Re-entering EITHER time input on this SAME block
      // before the countdown finishes cancels it, so editing start then end
      // doesn't trigger a mid-edit reorder. Moving to this block's title,
      // another block, or anywhere else does NOT cancel it — the countdown
      // keeps running and reorders once 3s pass without touching these two
      // fields again.
      input.addEventListener("blur", () => scheduleTimelineReorder(rowIdx));
      input.addEventListener("focus", () => {
        if (timelineRenderTimer && rowIdx === timelineRenderTimerRowIdx) {
          clearTimeout(timelineRenderTimer);
          timelineRenderTimer = null;
          timelineRenderTimerRowIdx = null;
        }
      });
    }
  });
  timelineListEl.querySelectorAll(".timeline-delete").forEach((btn) => {
    btn.addEventListener("click", () => {
      // Calendar rows carry no data-idx; Number(undefined) is NaN and
      // splice(NaN, 1) would silently remove the first block instead.
      const idx = Number(btn.dataset.idx);
      if (!Number.isInteger(idx)) return;
      if (timelineBlocks[idx]?.source === "calendar") return;
      timelineBlocks.splice(idx, 1);
      setTimelineDirty(true);
      renderTimeline();
    });
  });
}

function updateTimelineField(input) {
  const row = input.closest(".timeline-block");
  const idx = Number(row.dataset.idx);
  const field = input.dataset.field;
  const block = timelineBlocks[idx];
  if (!block) return;
  if (block.source === "calendar") return; // owned by the sync, not editable here
  if (field === "start" || field === "end") {
    const valid = /^([01]\d|2[0-3]):[0-5]\d$/.test(input.value);
    input.classList.toggle("invalid", !valid);
    if (valid) {
      block[field] = input.value;
      const dur = row.querySelector(".timeline-duration");
      if (dur) dur.textContent = timelineDurationLabel(block.start, block.end);
      renderTimelineViz();
    }
  } else {
    block[field] = input.value;
    if (field === "title") {
      const seg = timelineVizTrackEl.querySelector(`.timeline-viz-segment[data-block-id="${CSS.escape(block.id)}"]`);
      if (seg) seg.title = `${block.title || "Untitled"} · ${fmtTimelineClock(block.start)}–${fmtTimelineClock(block.end)}`;
      const label = document.querySelector(`.timeline-viz-label[data-block-id="${CSS.escape(block.id)}"] .timeline-viz-label-box`);
      if (label) label.textContent = block.title || "Untitled";
    }
  }
  setTimelineDirty(true);
}

// The week sweep always starts from today, so offering it while looking at some
// other day would be misleading — it wouldn't touch the day on screen.
function updateTimelineSyncWeekVisibility() {
  if (!timelineSyncWeekBtn) return;
  const shown = timelineLoadedDate || timelineDateInput.value;
  timelineSyncWeekBtn.hidden = shown !== todayLocalISO();
}

function renderTimeline() {
  clearTimeout(timelineRenderTimer);
  timelineRenderTimer = null;
  updateTimelineSyncWeekVisibility();
  renderTimelineViz();
  renderTimelineAllDay();
  if (timelineBlocks.length === 0) {
    timelineListEl.innerHTML = `<div class="empty">No blocks yet. Add one to start planning your day.</div>`;
    return;
  }
  const ordered = timelineBlocks.map((b, i) => ({ b, i })).sort((a, b) => a.b.start.localeCompare(b.b.start));
  timelineListEl.innerHTML = ordered.map(({ b, i }) => renderTimelineBlock(b, i)).join("");
  wireTimelineInputs();
  refreshTimelineButtons();
}

async function loadTimeline(date) {
  const targetDate = date || timelineDateInput.value || todayLocalISO();
  if (timelineDirty && timelineLoadedDate && targetDate !== timelineLoadedDate) {
    if (!confirm(`Discard unsaved changes to ${timelineLoadedDate}?`)) {
      timelineDateInput.value = timelineLoadedDate;
      return;
    }
  }
  timelineDateInput.value = targetDate;
  timelineListEl.innerHTML = `<div class="empty">Loading…</div>`;
  try {
    const res = await fetch(`/api/timeline?date=${encodeURIComponent(targetDate)}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    timelineBlocks = (data.blocks || []).map((b) => ({ ...b }));
    timelineAllDay = (data.allDay || []).map((a) => ({ ...a }));
    timelineSavedSnapshot = timelineBlocks.map((b) => ({ ...b }));
    timelineLoadedDate = targetDate;
    timelineDirty = false;
    renderTimeline();
  } catch (err) {
    timelineListEl.innerHTML = `<div class="empty">Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}

async function saveTimeline() {
  if (timelineListEl.querySelector(".invalid")) return;
  timelineSaveBtn.disabled = true;
  try {
    const res = await fetch("/api/timeline/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: timelineLoadedDate, blocks: timelineBlocks }),
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const body = await res.json(); if (body.error) msg = body.error; } catch {}
      throw new Error(msg);
    }
    const data = await res.json();
    timelineBlocks = (data.blocks || []).map((b) => ({ ...b }));
    timelineAllDay = (data.allDay || []).map((a) => ({ ...a }));
    timelineSavedSnapshot = timelineBlocks.map((b) => ({ ...b }));
    timelineDirty = false;
    renderTimeline();
  } catch (err) {
    alert("Save failed: " + err.message);
  } finally {
    refreshTimelineButtons();
  }
}

function cancelTimeline() {
  if (!timelineDirty) return;
  timelineBlocks = timelineSavedSnapshot.map((b) => ({ ...b }));
  timelineDirty = false;
  renderTimeline();
}

timelinePrevBtn.addEventListener("click", () => loadTimeline(isoWithOffset(timelineDateInput.value || todayLocalISO(), -1)));
timelineNextBtn.addEventListener("click", () => loadTimeline(isoWithOffset(timelineDateInput.value || todayLocalISO(), 1)));
timelineTodayBtn.addEventListener("click", () => loadTimeline(todayLocalISO()));
timelineDateInput.addEventListener("change", () => loadTimeline(timelineDateInput.value));
timelineSaveBtn.addEventListener("click", saveTimeline);
timelineCancelBtn.addEventListener("click", cancelTimeline);
timelineAddBtn.addEventListener("click", () => {
  const sorted = [...timelineBlocks].sort((a, b) => a.start.localeCompare(b.start));
  const last = sorted[sorted.length - 1];
  let start;
  if (last) {
    start = last.end;
  } else {
    const now = new Date();
    const roundedMin = now.getMinutes() < 30 ? 30 : 0;
    const h = now.getMinutes() < 30 ? now.getHours() : (now.getHours() + 1) % 24;
    start = `${String(h).padStart(2, "0")}:${String(roundedMin).padStart(2, "0")}`;
  }
  const [sh, sm] = start.split(":").map(Number);
  const end = `${String((sh + 1) % 24).padStart(2, "0")}:${String(sm).padStart(2, "0")}`;
  timelineBlocks.push({
    id: `b_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    start,
    end,
    title: "",
    notes: "",
  });
  setTimelineDirty(true);
  renderTimeline();
  requestAnimationFrame(() => {
    const idx = timelineBlocks.length - 1;
    timelineListEl.querySelector(`.timeline-block[data-idx="${idx}"] .timeline-title`)?.focus();
  });
});

timelineCalendarBtn.addEventListener("click", async () => {
  const date = timelineLoadedDate || todayLocalISO();
  if (timelineDirty && !confirm(`Discard unsaved changes to ${date} and refresh from calendar?`)) return;
  const label = timelineCalendarBtn.textContent;
  timelineCalendarBtn.disabled = true;
  timelineCalendarBtn.textContent = "Syncing…";
  try {
    const res = await fetch("/api/timeline/refresh-calendar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (data.skipped) {
      alert(`Calendar sync skipped: ${data.skipped}`);
      return;
    }
    timelineDirty = false;
    await loadTimeline(date);
  } catch (err) {
    alert("Calendar refresh failed: " + err.message);
  } finally {
    timelineCalendarBtn.disabled = false;
    timelineCalendarBtn.textContent = label;
  }
});

timelineSyncWeekBtn.addEventListener("click", async () => {
  const date = timelineLoadedDate || todayLocalISO();
  if (timelineDirty && !confirm(`Discard unsaved changes to ${date} and sync 7 days from the calendar?`)) return;
  const label = timelineSyncWeekBtn.textContent;
  timelineSyncWeekBtn.disabled = true;
  timelineCalendarBtn.disabled = true;
  timelineSyncWeekBtn.textContent = "Syncing 7 days…";
  try {
    // No date in the body = the same full-window sweep the hourly job runs.
    const res = await fetch("/api/timeline/refresh-calendar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const days = data.days || [];
    const skipped = days.find((d) => d.skipped);
    if (skipped) {
      alert(`Calendar sync skipped: ${skipped.skipped}`);
      return;
    }
    timelineDirty = false;
    await loadTimeline(date);
  } catch (err) {
    alert("Calendar sync failed: " + err.message);
  } finally {
    timelineSyncWeekBtn.disabled = false;
    timelineCalendarBtn.disabled = false;
    timelineSyncWeekBtn.textContent = label;
  }
});

timelineCopyBtn.addEventListener("click", () => {
  timelineCopyPanel.hidden = !timelineCopyPanel.hidden;
  if (!timelineCopyPanel.hidden) {
    timelineCopyDateInput.value = isoWithOffset(timelineLoadedDate || todayLocalISO(), -1);
    timelineCopyMsg.textContent = "";
    timelineCopyMsg.className = "timeline-copy-msg";
  }
});

timelineCopyCancelBtn.addEventListener("click", () => {
  timelineCopyPanel.hidden = true;
});

timelineCopyConfirmBtn.addEventListener("click", async () => {
  const sourceDate = timelineCopyDateInput.value;
  if (!sourceDate) return;
  if (sourceDate === timelineLoadedDate) {
    timelineCopyMsg.textContent = "That's the current day.";
    timelineCopyMsg.className = "timeline-copy-msg err";
    return;
  }
  timelineCopyConfirmBtn.disabled = true;
  timelineCopyMsg.textContent = "Loading…";
  timelineCopyMsg.className = "timeline-copy-msg";
  try {
    const res = await fetch(`/api/timeline?date=${encodeURIComponent(sourceDate)}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const sourceBlocks = data.blocks || [];
    if (sourceBlocks.length === 0) {
      timelineCopyMsg.textContent = `No blocks found on ${sourceDate}.`;
      timelineCopyMsg.className = "timeline-copy-msg err";
      return;
    }
    if (timelineBlocks.length > 0 && !confirm(`Replace all ${timelineBlocks.length} block${timelineBlocks.length === 1 ? "" : "s"} on ${timelineLoadedDate} with ${sourceBlocks.length} block${sourceBlocks.length === 1 ? "" : "s"} from ${sourceDate}?`)) {
      timelineCopyMsg.textContent = "";
      return;
    }
    timelineBlocks = sourceBlocks.map((b) => {
      // A copied block belongs to the new day, not to the source day's calendar
      // event — drop the ownership marker so the sync treats it as Steve's.
      const { source, calEventId, ...rest } = b;
      return { ...rest, id: `b_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` };
    });
    setTimelineDirty(true);
    renderTimeline();
    timelineCopyPanel.hidden = true;
  } catch (err) {
    timelineCopyMsg.textContent = "Failed: " + err.message;
    timelineCopyMsg.className = "timeline-copy-msg err";
  } finally {
    timelineCopyConfirmBtn.disabled = false;
  }
});

// ── Review (day recap) ────────────────────────────────
// The counterpart to the planner: the same day chart plus what actually
// happened that day — weather and spend. One /api/review request per day shown;
// each source there fails soft, so a section can be empty on its own. Read-only.
const reviewDateInput = document.getElementById("review-date-input");
const reviewPrevBtn = document.getElementById("review-prev-btn");
const reviewNextBtn = document.getElementById("review-next-btn");
const reviewTodayBtn = document.getElementById("review-today-btn");
const reviewOrientationBtn = document.getElementById("review-orientation-btn");
const reviewAllDayEl = document.getElementById("review-allday");
const reviewVizEl = document.getElementById("review-viz");
const reviewVizTrackEl = document.getElementById("review-viz-track");
const reviewVizAboveEl = document.getElementById("review-viz-above");
const reviewVizBelowEl = document.getElementById("review-viz-below");
const reviewVizTicksEl = document.getElementById("review-viz-ticks");
const reviewTimelineEmptyEl = document.getElementById("review-timeline-empty");
const reviewWeatherEl = document.getElementById("review-weather");
const reviewWeatherSectionEl = document.getElementById("review-weather-section");
const reviewExpensesEl = document.getElementById("review-expenses");
const reviewExpensesSectionEl = document.getElementById("review-expenses-section");
const reviewExpensesTotalEl = document.getElementById("review-expenses-total");

let reviewDate = null;
let reviewData = null;
// The planner's orientation preference is shared — one setting for both charts.
let reviewOrientation = timelineOrientation;

function applyReviewOrientation() {
  reviewVizEl.dataset.orientation = reviewOrientation;
  const next = reviewOrientation === "horizontal" ? "vertical" : "horizontal";
  reviewOrientationBtn.innerHTML = orientationToggleHtml(reviewOrientation);
  reviewOrientationBtn.setAttribute("aria-label", `Switch to ${next} review view`);
}
applyReviewOrientation();

function renderReviewAllDay(allDay) {
  if (!allDay.length) {
    reviewAllDayEl.hidden = true;
    reviewAllDayEl.innerHTML = "";
    return;
  }
  reviewAllDayEl.hidden = false;
  reviewAllDayEl.innerHTML =
    `<span class="timeline-allday-label">All-day</span>` +
    allDay.map(() => `<span class="timeline-allday-pill"></span>`).join("");
  // Titles come from the calendar — set as text so they can't inject markup.
  const pills = reviewAllDayEl.querySelectorAll(".timeline-allday-pill");
  allDay.forEach((a, i) => {
    if (pills[i]) pills[i].textContent = a.title || "(untitled)";
  });
}

function renderReviewViz() {
  const blocks = reviewData?.timeline?.blocks || [];
  reviewVizEl.hidden = blocks.length === 0;
  reviewTimelineEmptyEl.hidden = blocks.length > 0;
  // Reset the placeholder — a previous load may have left an error in it.
  reviewTimelineEmptyEl.textContent = "Nothing planned for this day.";
  if (!blocks.length) return;
  renderDayViz({
    blocks,
    orientation: reviewOrientation,
    range: computeTimelineVizRange(blocks),
    els: {
      trackEl: reviewVizTrackEl,
      aboveEl: reviewVizAboveEl,
      belowEl: reviewVizBelowEl,
      ticksEl: reviewVizTicksEl,
    },
    interactive: false,
  });
}

function renderReviewExpenses(expenses, error) {
  const items = expenses?.items || [];
  reviewExpensesTotalEl.textContent = items.length ? `$${(expenses.total || 0).toFixed(2)}` : "";
  // Nothing posted and nothing broken — a day with no spending says more by
  // leaving the section out than by printing "no expenses."
  reviewExpensesSectionEl.hidden = !items.length && !error;
  if (reviewExpensesSectionEl.hidden) return;
  if (error) {
    reviewExpensesEl.innerHTML = `<div class="empty">Couldn't load spending: ${escapeHtml(error)}</div>`;
    return;
  }
  reviewExpensesEl.innerHTML = `
    <div class="review-expenses">
      ${items.map(() => `
        <div class="review-expense-row">
          <span class="review-expense-name"></span>
          <span class="review-expense-cat"></span>
          <span class="review-expense-amt"></span>
        </div>
      `).join("")}
    </div>
  `;
  // Merchant names come from the bank feed — set as text, never markup.
  const rows = reviewExpensesEl.querySelectorAll(".review-expense-row");
  items.forEach((it, i) => {
    const row = rows[i];
    if (!row) return;
    row.querySelector(".review-expense-name").textContent = it.name;
    row.querySelector(".review-expense-cat").textContent = fmtExpenseCategory(it.category);
    row.querySelector(".review-expense-amt").textContent = `$${it.amount.toFixed(2)}`;
  });
}

function fmtExpenseCategory(cat) {
  if (!cat) return "";
  return cat.replace(/_/g, " ").toLowerCase();
}

// Line-art weather glyphs, sized by the container's font-size.
const WEATHER_SVG = {
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4"/>',
  cloud: '<path d="M7.5 19h9.8a3.7 3.7 0 0 0 .5-7.4 5.6 5.6 0 0 0-10.7-1.3A4.4 4.4 0 0 0 7.5 19Z"/>',
  partly: '<circle cx="8.4" cy="8" r="3"/><path d="M8.4 2.6v1.6M3 8H1.4M4.6 4.2 3.5 3.1M12.2 4.2l1.1-1.1M13.8 8.6h1.6"/><path d="M9.5 20h7.9a3.3 3.3 0 0 0 .4-6.6 5 5 0 0 0-9.5-1.1A3.9 3.9 0 0 0 9.5 20Z"/>',
  rain: '<path d="M7.5 15.5h9.8a3.7 3.7 0 0 0 .5-7.4A5.6 5.6 0 0 0 7.1 6.8 4.4 4.4 0 0 0 7.5 15.5Z"/><path d="M9 18.5 8 21M13 18.5 12 21M17 18.5 16 21"/>',
  snow: '<path d="M7.5 15.5h9.8a3.7 3.7 0 0 0 .5-7.4A5.6 5.6 0 0 0 7.1 6.8 4.4 4.4 0 0 0 7.5 15.5Z"/><path d="M9 19h.01M13 19h.01M17 19h.01M11 21.5h.01M15 21.5h.01"/>',
  storm: '<path d="M7.5 14.5h9.8a3.7 3.7 0 0 0 .5-7.4A5.6 5.6 0 0 0 7.1 5.8 4.4 4.4 0 0 0 7.5 14.5Z"/><path d="m13 16-3 4h3.5L11 23.5"/>',
  fog: '<path d="M8 12.5h9.3a3.5 3.5 0 0 0 .4-7 5.3 5.3 0 0 0-10.1-1.2A4.2 4.2 0 0 0 8 12.5Z"/><path d="M4 16h16M6 19.5h12"/>',
};

// Prefer the OpenWeather icon code; older CSV rows predate that column, so fall
// back to reading the conditions text.
function weatherGlyphType({ icon, conditions }) {
  const byCode = { "01": "sun", "02": "partly", "03": "cloud", "04": "cloud", "09": "rain", 10: "rain", 11: "storm", 13: "snow", 50: "fog" }[
    String(icon || "").slice(0, 2)
  ];
  const text = String(conditions || "").toLowerCase();
  const byText =
    /thunder|storm/.test(text) ? "storm" :
    /snow|sleet|ice/.test(text) ? "snow" :
    /rain|drizzle|shower/.test(text) ? "rain" :
    /mist|fog|haze|smoke/.test(text) ? "fog" :
    /few clouds|scattered|partly/.test(text) ? "partly" :
    /cloud|overcast/.test(text) ? "cloud" :
    /clear|sun/.test(text) ? "sun" : "cloud";
  return byCode || byText;
}

// Every icon in the weather row is drawn on the same 24-box at the same size.
function weatherSvg(shape) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shape}</svg>`;
}

const WEATHER_STAT_SVG = {
  hi: '<path d="M12 19.5V5M6.5 10.5 12 5l5.5 5.5"/>',
  lo: '<path d="M12 4.5V19M6.5 13.5 12 19l5.5-5.5"/>',
  humidity: '<path d="M12 3.2c3.2 3.7 5.6 6.7 5.6 9.5a5.6 5.6 0 0 1-11.2 0c0-2.8 2.4-5.8 5.6-9.5Z"/>',
  wind: '<path d="M3 8.5h11a3 3 0 1 0-3-3M3 12.5h15a3 3 0 1 1-3 3M3 16.5h7.5"/>',
};

function renderReviewWeather(weather, error) {
  reviewWeatherSectionEl.hidden = !weather && !error;
  if (reviewWeatherSectionEl.hidden) return;
  if (error) {
    reviewWeatherEl.innerHTML = `<div class="empty">Couldn't load weather: ${escapeHtml(error)}</div>`;
    return;
  }
  const glyph = weatherGlyphType(weather);
  const num = (v, suffix) => (Number.isFinite(v) ? `${v}${suffix}` : "—");
  reviewWeatherEl.innerHTML = `
    <div class="review-weather">
      <span class="review-weather-stat cond" data-glyph="${glyph}">
        ${weatherSvg(WEATHER_SVG[glyph])}<span class="cond-val"></span>
      </span>
      <span class="review-weather-stat hi" title="High">
        ${weatherSvg(WEATHER_STAT_SVG.hi)}<span class="hi-val"></span>
      </span>
      <span class="review-weather-stat lo" title="Low">
        ${weatherSvg(WEATHER_STAT_SVG.lo)}<span class="lo-val"></span>
      </span>
      <span class="review-weather-stat humidity" title="Humidity">
        ${weatherSvg(WEATHER_STAT_SVG.humidity)}<span class="humidity-val"></span>
      </span>
      <span class="review-weather-stat wind" title="Wind">
        ${weatherSvg(WEATHER_STAT_SVG.wind)}<span class="wind-val"></span>
      </span>
    </div>
    <div class="review-weather-alert" hidden></div>
  `;
  const q = (sel) => reviewWeatherEl.querySelector(sel);
  q(".cond-val").textContent = weather.conditions;
  q(".hi-val").textContent = num(weather.high, "°");
  q(".lo-val").textContent = num(weather.low, "°");
  q(".humidity-val").textContent = num(weather.humidity, "%");
  q(".wind-val").textContent = num(Number.isFinite(weather.wind) ? Math.round(weather.wind) : NaN, " mph");
  if (weather.alerts) {
    const alertEl = q(".review-weather-alert");
    alertEl.hidden = false;
    alertEl.textContent = weather.alerts;
  }
}

function renderReview() {
  if (!reviewData) return;
  renderReviewAllDay(reviewData.timeline?.allDay || []);
  renderReviewViz();


  renderReviewWeather(reviewData.weather, reviewData.errors?.weather);

  renderReviewExpenses(reviewData.expenses, reviewData.errors?.expenses);
}

async function loadReview(date) {
  // An add panel left open on the way out is still dated to the day we left.
  reviewDate = date;
  reviewDateInput.value = date;
  try {
    const res = await fetch(`/api/review?date=${encodeURIComponent(date)}`, { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (reviewDate !== date) return; // a newer day was requested while this was in flight
    reviewData = data;
    renderReview();
  } catch (err) {
    reviewData = null;
    reviewVizEl.hidden = true;
    reviewTimelineEmptyEl.hidden = false;
    reviewTimelineEmptyEl.textContent = `Failed to load: ${err.message}`;
  }
}

reviewOrientationBtn.addEventListener("click", () => {
  reviewOrientation = reviewOrientation === "horizontal" ? "vertical" : "horizontal";
  applyReviewOrientation();
  renderReviewViz();
});

reviewPrevBtn.addEventListener("click", () => loadReview(isoWithOffset(reviewDate || todayLocalISO(), -1)));
reviewNextBtn.addEventListener("click", () => loadReview(isoWithOffset(reviewDate || todayLocalISO(), 1)));
reviewTodayBtn.addEventListener("click", () => loadReview(todayLocalISO()));
reviewDateInput.addEventListener("change", () => {
  if (reviewDateInput.value) loadReview(reviewDateInput.value);
});

// ── Finances ─────────────────────────────────────────
const financesListEl = document.getElementById("finances-list");
const financesCountEl = document.getElementById("finances-count");
const financesSummaryEl = document.getElementById("finances-summary");
let financesLastFetched = 0;

function fmtMoney(n) {
  return (n < 0 ? "−" : "") + "$" + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function renderFinMonth(month) {
  const netClass = month.net >= 0 ? "fin-positive" : "fin-negative";
  let html = `<div class="fin-month">`;
  html += `<div class="fin-month-header">`;
  html += `<div class="fin-month-label">${escapeHtml(month.label)}</div>`;
  html += `<div class="fin-month-range">${escapeHtml(month.dateRange)}</div>`;
  html += `</div>`;

  // Summary stats
  html += `<div class="fin-summary-row">`;
  html += `<div class="fin-stat"><div class="fin-stat-label">Income</div><div class="fin-stat-val fin-positive">${fmtMoney(month.totalIncome)}</div></div>`;
  html += `<div class="fin-stat"><div class="fin-stat-label">Expenses</div><div class="fin-stat-val">${fmtMoney(month.totalExpenses)}</div></div>`;
  html += `<div class="fin-stat"><div class="fin-stat-label">Net</div><div class="fin-stat-val ${netClass}">${fmtMoney(month.net)}</div></div>`;
  html += `</div>`;

  // Income section
  if (month.income.length) {
    html += `<div class="fin-section">`;
    html += `<div class="fin-section-label">Income</div>`;
    for (const item of month.income) {
      html += `<div class="fin-line fin-income-line"><span class="fin-line-name">${escapeHtml(item.name)}</span><span class="fin-line-amount">${fmtMoney(item.total)}</span></div>`;
    }
    html += `<div class="fin-line fin-line-total"><span class="fin-line-name">Total Income</span><span class="fin-line-amount">${fmtMoney(month.totalIncome)}</span></div>`;
    html += `</div>`;
  }

  // Expenses section
  if (month.expenses.length) {
    html += `<div class="fin-section">`;
    html += `<div class="fin-section-label">Expenses</div>`;
    for (const item of month.expenses) {
      html += `<div class="fin-line"><span class="fin-line-name">${escapeHtml(item.name)}</span><span class="fin-line-amount">${fmtMoney(item.total)}</span></div>`;
    }
    html += `<div class="fin-line fin-line-total"><span class="fin-line-name">Total Expenses</span><span class="fin-line-amount">${fmtMoney(month.totalExpenses)}</span></div>`;
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

function renderFinances(data) {
  const months = data.months || [];
  financesCountEl.textContent = months.length ? `${months.length} mo` : "";
  financesSummaryEl.innerHTML = "";

  if (months.length === 0) {
    financesListEl.innerHTML = `<div class="empty">No finance data found.</div>`;
    return;
  }
  financesListEl.innerHTML = months.map(renderFinMonth).join("");
}

async function loadFinances() {
  if (Date.now() - financesLastFetched < 120_000 && financesListEl.querySelector(".fin-month")) return;
  if (!financesListEl.querySelector(".fin-month")) {
    financesListEl.innerHTML = `<div class="empty">Loading…</div>`;
  }
  try {
    const res = await fetch("/api/finances", { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    financesLastFetched = Date.now();
    renderFinances(data);
  } catch (err) {
    financesListEl.innerHTML = `<div class="empty">Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}

// ── API Usage ────────────────────────────────────────
const apiUsageContentEl = document.getElementById("api-usage-content");
const apiUsageCountEl = document.getElementById("api-usage-count");
let apiUsageLastFetched = 0;
let apiUsageData = null;
let apiUsageSelectedMonth = null; // YYYY-MM, defaults to current

function renderApiUsage(data) {
  apiUsageData = data;
  const { months, currentMonthCents } = data;
  const sortedAsc = [...months].sort((a, b) => a.month.localeCompare(b.month));
  const currentMonth = sortedAsc[sortedAsc.length - 1];
  if (!apiUsageSelectedMonth || !sortedAsc.find(m => m.month === apiUsageSelectedMonth)) {
    apiUsageSelectedMonth = currentMonth ? currentMonth.month : null;
  }
  const selected = sortedAsc.find(m => m.month === apiUsageSelectedMonth) || currentMonth;
  const currentTotal = (currentMonthCents / 100).toFixed(2);
  apiUsageCountEl.textContent = `$${currentTotal}`;

  if (!selected) {
    apiUsageContentEl.innerHTML = `<div class="empty">No usage data.</div>`;
    return;
  }

  const days = selected.days || [];
  const selectedTotal = (selected.totalCents / 100).toFixed(2);
  const isCurrent = selected.month === (currentMonth && currentMonth.month);

  let html = "";

  // Selected month summary
  html += `<div class="api-summary">`;
  html += `<div class="api-summary-label">${escapeHtml(selected.label)}${isCurrent ? "" : " (historical)"}</div>`;
  html += `<div class="api-summary-total">$${selectedTotal}</div>`;
  html += `</div>`;

  // Daily chart
  if (days.length) {
    const maxCents = Math.max(...days.map(d => d.cents), 1);
    html += `<div class="api-section-label">Daily Breakdown</div>`;
    html += `<div class="api-chart">`;
    for (const day of days) {
      const dollars = (day.cents / 100).toFixed(2);
      const pct = (day.cents / maxCents) * 100;
      const dayNum = new Date(day.date + "T12:00:00Z").getUTCDate();
      const dayLabel = new Date(day.date + "T12:00:00Z").toLocaleDateString([], { weekday: "short" });
      html += `<div class="api-bar-col" title="${day.date}: $${dollars}">`;
      html += `<div class="api-bar-val">$${dollars}</div>`;
      html += `<div class="api-bar-track"><div class="api-bar-fill" style="height:${Math.max(pct, 2)}%"></div></div>`;
      html += `<div class="api-bar-label">${dayNum}</div>`;
      html += `<div class="api-bar-day">${dayLabel}</div>`;
      html += `</div>`;
    }
    html += `</div>`;
  }

  // Monthly history (descending) — clickable
  const historyMonths = sortedAsc.filter(m => m.totalCents > 0).slice().reverse();
  if (historyMonths.length) {
    const maxMonthCents = Math.max(...historyMonths.map(m => m.totalCents), 1);
    html += `<div class="api-section-label">Monthly History</div>`;
    html += `<div class="api-history">`;
    for (const m of historyMonths) {
      const dollars = (m.totalCents / 100).toFixed(2);
      const pct = (m.totalCents / maxMonthCents) * 100;
      const sel = m.month === selected.month ? " selected" : "";
      html += `<div class="api-history-row clickable${sel}" data-month="${escapeHtml(m.month)}" role="button" tabindex="0" title="View daily breakdown for ${escapeHtml(m.label)}">`;
      html += `<div class="api-history-label">${m.label}</div>`;
      html += `<div class="api-history-bar-wrap"><div class="api-history-bar" style="width:${Math.max(pct, 2)}%"></div></div>`;
      html += `<div class="api-history-val">$${dollars}</div>`;
      html += `</div>`;
    }
    html += `</div>`;
  }

  apiUsageContentEl.innerHTML = html;

  apiUsageContentEl.querySelectorAll(".api-history-row[data-month]").forEach((row) => {
    const select = () => {
      apiUsageSelectedMonth = row.dataset.month;
      renderApiUsage(apiUsageData);
    };
    row.addEventListener("click", select);
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(); }
    });
  });
}

async function loadApiUsage() {
  if (Date.now() - apiUsageLastFetched < 120_000 && apiUsageContentEl.querySelector(".api-summary")) return;
  if (!apiUsageContentEl.querySelector(".api-summary")) {
    apiUsageContentEl.innerHTML = `<div class="empty">Loading…</div>`;
  }
  try {
    const res = await fetch("/api/api-usage", { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    apiUsageLastFetched = Date.now();
    renderApiUsage(data);
  } catch (err) {
    apiUsageContentEl.innerHTML = `<div class="empty">Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}

// ── Chat (dashapp-only, no Telegram) ──────────────────
const chatListEl = document.getElementById("chat-list");
const chatCountEl = document.getElementById("chat-count");
let chatLoaded = false;
let chatTotalCount = 0;
let chatCurrentCount = 0;

function scrollChatToBottom() {
  if (currentTab !== "chat") return;
  mainEl.scrollTop = mainEl.scrollHeight;
}

function scheduleScrollChatToBottom() {
  if (currentTab !== "chat") return;
  requestAnimationFrame(() => {
    scrollChatToBottom();
    requestAnimationFrame(scrollChatToBottom);
  });
  setTimeout(scrollChatToBottom, 100);
  setTimeout(scrollChatToBottom, 350);
}

function renderChat(messages, total, { scrollToBottom = true } = {}) {
  if (total != null) chatTotalCount = total;
  chatCurrentCount = messages.length;
  chatCountEl.textContent = messages.length ? `${messages.length}${chatTotalCount > messages.length ? " / " + chatTotalCount : ""}` : "";
  if (messages.length === 0) {
    chatListEl.innerHTML = `<div class="empty">No messages yet.</div>`;
    return;
  }
  const loadMoreHtml = chatTotalCount > messages.length
    ? `<button class="load-more-btn" id="load-more-chat">Load earlier messages</button>`
    : "";
  chatListEl.innerHTML = loadMoreHtml + messages
    .map((m) => {
      const cls = m.from === "user" ? "from-user" : "from-dash";
      const who = m.from === "user" ? "You" : "Dash";
      const when = m.ts ? new Date(m.ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
      return `<div class="msg ${cls}"><div class="msg-meta">${who}${when ? " · " + escapeHtml(when) : ""}</div><div class="msg-text"></div></div>`;
    })
    .join("");
  const items = chatListEl.querySelectorAll(".msg-text");
  messages.forEach((m, i) => {
    const text = m.text || "";
    items[i].innerHTML = window.marked ? window.marked.parse(text) : escapeHtml(text);
  });
  const loadMoreBtn = document.getElementById("load-more-chat");
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener("click", () => loadMoreChat());
  }
  if (scrollToBottom) scheduleScrollChatToBottom();
}

async function loadMoreChat() {
  const nextLimit = Math.min(chatCurrentCount + 50, chatTotalCount);
  try {
    const res = await fetch(`/api/chat?limit=${nextLimit}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    renderChat(data.messages || [], data.total, { scrollToBottom: false });
  } catch (err) {
    console.error("Load more chat failed:", err);
  }
}

async function loadChat() {
  try {
    const res = await fetch("/api/chat", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    chatLoaded = true;
    renderChat(data.messages || [], data.total);
  } catch (err) {
    chatListEl.innerHTML = `<div class="empty">Failed to load: ${err.message}</div>`;
  }
}

function connectChatStream() {
  const es = new EventSource("/api/chat/stream");
  es.addEventListener("update", (e) => {
    try {
      const data = JSON.parse(e.data);
      chatLoaded = true;
      renderChat(data.messages || [], data.total);
    } catch (err) { console.error("chat stream parse error", err); }
  });
  es.addEventListener("error", () => { /* auto-reconnect */ });
}
connectChatStream();

// ── Messages (Telegram history) ────────────────────────
const messagesListEl = document.getElementById("messages-list");
const messagesCountEl = document.getElementById("messages-count");
let messagesLoaded = false;
let messagesTotalCount = 0; // total messages on server
let messagesCurrentCount = 0; // how many we're currently showing

function scrollMessagesToBottom() {
  // <main> is the scroll container now. Only scroll if the messages tab is
  // actually visible — otherwise SSE background updates would hijack the
  // scroll position of another tab.
  if (currentTab !== "telegram") return;
  mainEl.scrollTop = mainEl.scrollHeight;
}

// Schedule several scroll attempts to survive late layout shifts (font load,
// sticky header settling, deep-link scroll restoration, etc.).
function scheduleScrollMessagesToBottom() {
  if (currentTab !== "telegram") return;
  requestAnimationFrame(() => {
    scrollMessagesToBottom();
    requestAnimationFrame(scrollMessagesToBottom);
  });
  setTimeout(scrollMessagesToBottom, 100);
  setTimeout(scrollMessagesToBottom, 350);
}

function renderMessages(messages, total, { scrollToBottom = true } = {}) {
  if (total != null) messagesTotalCount = total;
  messagesCurrentCount = messages.length;
  messagesCountEl.textContent = messages.length ? `${messages.length}${messagesTotalCount > messages.length ? " / " + messagesTotalCount : ""}` : "";
  if (messages.length === 0) {
    messagesListEl.innerHTML = `<div class="empty">No messages yet.</div>`;
    return;
  }
  // "Load more" button at top when there's more history
  const loadMoreHtml = messagesTotalCount > messages.length
    ? `<button class="load-more-btn" id="load-more-msgs">Load earlier messages</button>`
    : "";
  messagesListEl.innerHTML = loadMoreHtml + messages
    .map((m) => {
      const cls = m.from === "user" ? "from-user" : "from-dash";
      const who = m.from === "user" ? "You" : "Dash";
      const when = m.ts ? new Date(m.ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
      const imageHtml = m.image ? `<img src="${escapeHtml(m.image)}" class="msg-image" loading="lazy">` : "";
      return `<div class="msg ${cls}"><div class="msg-meta">${who}${when ? " · " + escapeHtml(when) : ""}</div>${imageHtml}<div class="msg-text"></div></div>`;
    })
    .join("");
  const items = messagesListEl.querySelectorAll(".msg-text");
  messages.forEach((m, i) => {
    const text = m.text || "";
    items[i].innerHTML = window.marked ? window.marked.parse(text) : escapeHtml(text);
  });
  // Wire up "load more" button
  const loadMoreBtn = document.getElementById("load-more-msgs");
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener("click", () => loadMoreMessages());
  }
  // Scroll to newest — skip when user is browsing history
  if (scrollToBottom) scheduleScrollMessagesToBottom();
}

async function loadMoreMessages() {
  const nextLimit = Math.min(messagesCurrentCount + 50, messagesTotalCount);
  try {
    const res = await fetch(`/api/messages?limit=${nextLimit}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    renderMessages(data.messages || [], data.total, { scrollToBottom: false });
  } catch (err) {
    console.error("Load more messages failed:", err);
  }
}

async function loadMessages() {
  try {
    const res = await fetch("/api/messages", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    messagesLoaded = true;
    renderMessages(data.messages || [], data.total);
  } catch (err) {
    messagesListEl.innerHTML = `<div class="empty">Failed to load: ${err.message}</div>`;
  }
}

function connectMessagesStream() {
  const es = new EventSource("/api/messages/stream");
  es.addEventListener("update", (e) => {
    try {
      const data = JSON.parse(e.data);
      messagesLoaded = true;
      renderMessages(data.messages || [], data.total);
    } catch (err) { console.error("messages stream parse error", err); }
  });
  es.addEventListener("error", () => { /* auto-reconnect */ });
}

// ── Reminders ──────────────────────────────────────────
const remindersListEl = document.getElementById("reminders-list");
const remindersCountEl = document.getElementById("reminders-count");
let remindersReady = false;

function formatReminderDue(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const hasTime = !(d.getHours() === 0 && d.getMinutes() === 0);
  if (sameDay) return hasTime ? `Today ${time}` : "Today";
  if (isTomorrow) return hasTime ? `Tomorrow ${time}` : "Tomorrow";
  const date = d.toLocaleDateString([], { month: "short", day: "numeric" });
  return hasTime ? `${date} ${time}` : date;
}

function renderReminders(reminders) {
  remindersCountEl.textContent = reminders.length ? `${reminders.length}` : "";
  if (reminders.length === 0) {
    remindersListEl.innerHTML = remindersReady
      ? `<div class="empty">No tasks.</div>`
      : `<div class="empty">Loading…</div>`;
    return;
  }
  // Sort: overdue/dated first by date, then undated.
  const sorted = [...reminders].sort((a, b) => {
    if (a.dueDate && b.dueDate) return new Date(a.dueDate) - new Date(b.dueDate);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return 0;
  });
  remindersListEl.innerHTML = sorted
    .map((r) => {
      const due = formatReminderDue(r.dueDate);
      const overdue = r.dueDate && new Date(r.dueDate) < new Date() ? " overdue" : "";
      return `
        <div class="reminder" data-id="${escapeHtml(r.id)}">
          <button class="reminder-check" aria-label="Complete"></button>
          <div class="reminder-body">
            <div class="reminder-name"></div>
            ${due ? `<div class="reminder-due${overdue}">${escapeHtml(due)}</div>` : ""}
            ${r.body ? `<div class="reminder-notes"></div>` : ""}
          </div>
        </div>
      `;
    })
    .join("");
  // Set text content (avoid HTML injection from reminder names/notes)
  const items = remindersListEl.querySelectorAll(".reminder");
  sorted.forEach((r, i) => {
    items[i].querySelector(".reminder-name").textContent = r.name || "(untitled)";
    const notesEl = items[i].querySelector(".reminder-notes");
    if (notesEl) notesEl.textContent = r.body;
    items[i].querySelector(".reminder-check").addEventListener("click", () => completeReminder(r.id, items[i]));
  });
}

function connectRemindersStream() {
  const es = new EventSource("/api/reminders/stream");
  es.addEventListener("update", (e) => {
    try {
      const data = JSON.parse(e.data);
      remindersReady = !!data.ready;
      remindersCountEl.classList.remove("refreshing");
      renderReminders(data.reminders || []);
    } catch (err) { console.error("reminders stream parse error", err); }
  });
  es.addEventListener("error", () => { /* auto-reconnect */ });
}

function refreshReminders() {
  // Ask the server to re-fetch from Reminders.app. Result arrives via SSE.
  remindersCountEl.classList.add("refreshing");
  fetch("/api/reminders/refresh", { cache: "no-store" }).catch(() => {
    remindersCountEl.classList.remove("refreshing");
  });
}

// Live polling while the Reminders tab is active and the document is visible.
// JXA call is ~10s so we poll at that interval; server de-dupes concurrent refreshes.
let remindersPollTimer = null;
function startRemindersPolling() {
  if (remindersPollTimer) return;
  refreshReminders();
  remindersPollTimer = setInterval(refreshReminders, 10_000);
}
function stopRemindersPolling() {
  if (remindersPollTimer) {
    clearInterval(remindersPollTimer);
    remindersPollTimer = null;
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopRemindersPolling();
  else if (currentTab === "reminders") startRemindersPolling();
});

async function completeReminder(id, el) {
  if (el) el.classList.add("completing");
  try {
    const res = await fetch("/api/reminders/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Remove from DOM after a brief animation, refresh count.
    setTimeout(() => {
      if (el && el.parentNode) el.parentNode.removeChild(el);
      const remaining = remindersListEl.querySelectorAll(".reminder").length;
      remindersCountEl.textContent = remaining ? `${remaining}` : "";
      if (remaining === 0) remindersListEl.innerHTML = `<div class="empty">No tasks.</div>`;
    }, 200);
  } catch (err) {
    if (el) el.classList.remove("completing");
    console.error("Complete reminder failed:", err);
  }
}

function attrEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function isPdfPath(p) {
  return typeof p === "string" && p.toLowerCase().endsWith(".pdf");
}

let pdfJsConfigured = false;
function configurePdfJs() {
  if (pdfJsConfigured || !window.pdfjsLib) return;
  window.pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
  pdfJsConfigured = true;
}

async function renderPdf(path) {
  if (!window.pdfjsLib) {
    libraryBodyEl.innerHTML = `<div class="empty">PDF viewer failed to load.</div>`;
    return;
  }
  configurePdfJs();
  const url = `/api/library/file/${encodePath(path)}`;
  try {
    const pdf = await window.pdfjsLib.getDocument(url).promise;
    if (currentLibraryPath !== path) return;
    libraryBodyEl.innerHTML = "";
    const pages = document.createElement("div");
    pages.className = "pdf-pages";
    libraryBodyEl.appendChild(pages);
    const targetWidth = pages.clientWidth || libraryBodyEl.clientWidth || 800;
    const dpr = window.devicePixelRatio || 1;
    for (let i = 1; i <= pdf.numPages; i++) {
      if (currentLibraryPath !== path) return;
      const page = await pdf.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scale = targetWidth / base.width;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.className = "pdf-page";
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      pages.appendChild(canvas);
      const ctx = canvas.getContext("2d");
      await page.render({
        canvasContext: ctx,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      }).promise;
    }
  } catch (err) {
    if (currentLibraryPath === path) {
      libraryBodyEl.innerHTML = `<div class="empty">Failed to load PDF: ${escapeHtml(err.message)}</div>`;
    }
  }
}

// Paths are encoded a segment at a time — a file name is free to contain a
// character that would otherwise read as a separator.
function encodePath(p) {
  return p.split("/").map(encodeURIComponent).join("/");
}

function dirOf(path) {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

// Images a markdown file names by relative path. Everything resolves against
// dashbook/ — the file's own path says where in it we're standing — so one
// asset endpoint serves the lot. A `../` that would climb out of dashbook has
// nowhere to go and is left alone.
function rewriteRelativeImages(container, filePath) {
  const segments = dirOf(filePath || "").split("/").filter(Boolean);
  container.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src") || "";
    if (/^([a-z]+:)?\/\//i.test(src) || src.startsWith("/") || src.startsWith("data:")) return;
    const resolved = [...segments];
    let climbedOut = false;
    for (const part of src.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") {
        if (resolved.length === 0) { climbedOut = true; break; }
        resolved.pop();
        continue;
      }
      resolved.push(part);
    }
    if (climbedOut) return;
    img.setAttribute("src", `/api/dashbook/assets/${resolved.map(encodeURIComponent).join("/")}`);
    img.setAttribute("loading", "lazy");
  });
}

function isJsonPath(p) {
  return typeof p === "string" && p.toLowerCase().endsWith(".json");
}

function highlightJson(text) {
  // Assumes valid JSON (we only call this after successful JSON.parse).
  // Pretty-print then syntax-highlight.
  let pretty;
  try { pretty = JSON.stringify(JSON.parse(text), null, 2); }
  catch { pretty = text; }
  const escaped = escapeHtml(pretty);
  return escaped.replace(
    /("(?:\\.|[^"\\])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let cls = "json-number";
      if (/^"/.test(match)) cls = /:\s*$/.test(match) ? "json-key" : "json-string";
      else if (/true|false/.test(match)) cls = "json-bool";
      else if (/null/.test(match)) cls = "json-null";
      return `<span class="${cls}">${match}</span>`;
    }
  );
}

// RFC-4180-ish CSV parser. Handles quoted fields, escaped quotes, commas and
// newlines inside quotes, and both LF/CRLF line endings.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        row.push(field); field = "";
      } else if (c === "\n" || c === "\r") {
        row.push(field); field = "";
        rows.push(row); row = [];
        if (c === "\r" && text[i + 1] === "\n") i++;
      } else {
        field += c;
      }
    }
  }
  // Flush the last field/row unless we ended on a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop trailing empty row (trailing newline case).
  if (rows.length > 0) {
    const last = rows[rows.length - 1];
    if (last.length === 1 && last[0] === "") rows.pop();
  }
  return rows;
}

const NUMERIC_CELL_RE = /^-?\$?\d{1,3}(,\d{3})*(\.\d+)?%?$|^-?\d+(\.\d+)?$/;

function cellClass(raw) {
  const v = raw.trim();
  if (!v) return "";
  if (NUMERIC_CELL_RE.test(v)) {
    const n = parseFloat(v.replace(/[,$%]/g, ""));
    if (Number.isFinite(n)) {
      if (n < 0) return "num neg";
      if (n > 0) return "num pos";
      return "num";
    }
  }
  return "";
}

function renderCsvTable(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) {
    return `<div class="empty">Empty CSV.</div>`;
  }
  const [header, ...body] = rows;
  const thead = `<thead><tr>${header.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${body
    .map((r) => {
      const cells = header.map((_, i) => {
        const v = r[i] ?? "";
        const cls = cellClass(v);
        return `<td${cls ? ` class="${cls}"` : ""}>${escapeHtml(v)}</td>`;
      }).join("");
      return `<tr>${cells}</tr>`;
    })
    .join("")}</tbody>`;
  const meta = `<div class="report-meta">${body.length} row${body.length === 1 ? "" : "s"} · ${header.length} column${header.length === 1 ? "" : "s"}</div>`;
  return `${meta}<div class="report-table-wrap"><table class="report-table">${thead}${tbody}</table></div>`;
}

function sizeReportTable() {
  const wrap = libraryBodyEl.querySelector(".report-table-wrap");
  if (!wrap) return;
  // On narrow screens the sidebar/content stack vertically; let the table
  // grow to its natural height and rely on page scroll instead.
  if (window.innerWidth < 800) {
    wrap.style.maxHeight = "";
    return;
  }
  const wrapTop = wrap.getBoundingClientRect().top;
  const mainBottom = mainEl.getBoundingClientRect().bottom;
  const cardPad = 24;
  const available = mainBottom - wrapTop - cardPad;
  wrap.style.maxHeight = Math.max(200, available) + "px";
}

let reportResizeHandler = null;
function installReportResizeHandler() {
  if (reportResizeHandler) return;
  reportResizeHandler = () => {
    clearTimeout(reportResizeHandler._t);
    reportResizeHandler._t = setTimeout(sizeReportTable, 80);
  };
  window.addEventListener("resize", reportResizeHandler);
}

// ── Library ───────────────────────────────────────────
// One browser over the whole of dashbook — notes, dash files, reports, images,
// everything. A path here is relative to dashbook itself: "notes/food/x.md".
//
// What a file is decides how it shows and whether it can be edited: markdown,
// CSV, JSON, JSONL and plain text render and edit; images and PDFs only render.

const LIBRARY_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".heic"]);
const LIBRARY_TEXT_EXTS = new Set([".md", ".json", ".jsonl", ".csv", ".txt"]);

function libraryExt(path) {
  const i = String(path).lastIndexOf(".");
  return i === -1 ? "" : String(path).slice(i).toLowerCase();
}

function isLibraryTextPath(path) {
  return LIBRARY_TEXT_EXTS.has(libraryExt(path));
}

function countLibraryFiles(tree) {
  let n = tree.files.length;
  for (const d of tree.dirs) n += countLibraryFiles(d);
  return n;
}

function renderLibraryTree(tree, depth) {
  const parts = [];
  // Directories first
  for (const dir of tree.dirs) {
    const expanded = libraryExpandedDirs.has(dir.path);
    const safePath = attrEscape(dir.path);
    parts.push(
      `<li class="notes-dir" data-dir="${safePath}">` +
        `<button type="button" class="notes-dir-toggle${expanded ? " expanded" : ""}" data-dir="${safePath}" aria-expanded="${expanded}" style="--notes-depth:${depth}">` +
          `<span class="notes-dir-caret">${expanded ? "▾" : "▸"}</span>` +
          `<span class="notes-dir-name">${attrEscape(dir.name)}</span>` +
        `</button>` +
        `<ul class="notes-list notes-sublist"${expanded ? "" : " hidden"}>${renderLibraryTree(dir, depth + 1)}</ul>` +
      `</li>`
    );
  }
  // Then files
  for (const file of tree.files) {
    const safePath = attrEscape(file.path);
    const active = file.path === currentLibraryPath ? " active" : "";
    parts.push(
      `<li><button class="note-item${active}" data-path="${safePath}" style="--notes-depth:${depth}">${attrEscape(file.name)}</button></li>`
    );
  }
  return parts.join("");
}

function renderLibraryList(tree) {
  knownLibraryTree = tree || { dirs: [], files: [] };
  // Preserve sidebar collapsed state across re-renders
  libraryListEl.hidden = !librarySidebarExpanded;
  if (countLibraryFiles(knownLibraryTree) === 0) {
    libraryListEl.innerHTML = `<li class="empty">Nothing here.</li>`;
  } else {
    libraryListEl.innerHTML = renderLibraryTree(knownLibraryTree, 0);
    libraryListEl.querySelectorAll(".note-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (isLibraryEditing() && !confirm("Discard unsaved changes?")) return;
        if (btn.dataset.path === currentLibraryPath) {
          deselectLibraryItem();
        } else {
          loadLibraryItem(btn.dataset.path);
          if (window.matchMedia("(max-width: 799px)").matches) {
            if (librarySidebarExpanded) {
              librarySidebarExpanded = false;
              applyLibrarySidebarState();
            }
            mainEl.scrollTo({ top: 0, behavior: "smooth" });
          }
        }
      });
    });
    libraryListEl.querySelectorAll(".notes-dir-toggle").forEach((btn) => {
      btn.addEventListener("click", () => {
        const p = btn.dataset.dir;
        const wasExpanded = libraryExpandedDirs.has(p);
        const isMobile = window.matchMedia("(max-width: 799px)").matches;
        if (wasExpanded) {
          libraryExpandedDirs.delete(p);
        } else if (isMobile) {
          // Mobile: only one branch open at a time. Keep ancestors of the
          // newly-expanded folder so it stays visible; collapse everything else.
          libraryExpandedDirs.clear();
          const parts = p.split("/");
          for (let i = 1; i <= parts.length; i++) {
            libraryExpandedDirs.add(parts.slice(0, i).join("/"));
          }
        } else {
          libraryExpandedDirs.add(p);
        }
        persistLibraryExpanded();
        if (!wasExpanded && isMobile) {
          renderLibraryList(knownLibraryTree);
        } else {
          const sublist = btn.parentElement.querySelector(":scope > .notes-sublist");
          btn.classList.toggle("expanded", !wasExpanded);
          btn.setAttribute("aria-expanded", String(!wasExpanded));
          btn.querySelector(".notes-dir-caret").textContent = wasExpanded ? "▸" : "▾";
          if (sublist) sublist.hidden = wasExpanded;
        }
        updateLibraryExpandAllIcon();
      });
    });
  }
  updateLibraryExpandAllIcon();
  updateLibraryActiveDirs();
  // First time we have data, honor any file deep-linked in the URL
  if (!libraryLoaded) {
    libraryLoaded = true;
    const deep = routeLibraryPath();
    if (deep && findLibraryInTree(knownLibraryTree, deep)) loadLibraryItem(deep);
  }
}

function expandLibraryAncestorsFor(path) {
  const parts = path.split("/");
  parts.pop();
  let acc = "";
  let changed = false;
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    if (!libraryExpandedDirs.has(acc)) {
      libraryExpandedDirs.add(acc);
      changed = true;
    }
  }
  if (changed) persistLibraryExpanded();
  return changed;
}

function updateLibraryActiveDirs() {
  libraryListEl.querySelectorAll(".notes-dir-toggle").forEach((btn) => {
    btn.classList.remove("has-active");
  });
  if (!currentLibraryPath) return;
  const parts = currentLibraryPath.split("/");
  parts.pop();
  let acc = "";
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    const btn = libraryListEl.querySelector(`.notes-dir-toggle[data-dir="${CSS.escape(acc)}"]`);
    if (btn) btn.classList.add("has-active");
  }
}

function renderLibraryContent(path, content) {
  libraryRawText = content;
  const ext = libraryExt(path);
  if (ext === ".csv") {
    libraryBodyEl.innerHTML = renderCsvTable(content);
    installReportResizeHandler();
    // Measure after layout settles.
    requestAnimationFrame(sizeReportTable);
    return;
  }
  if (ext === ".json") {
    try {
      JSON.parse(content);
      libraryBodyEl.innerHTML = `<pre class="json-viewer">${highlightJson(content)}</pre>`;
    } catch (err) {
      libraryBodyEl.innerHTML = `<pre class="json-viewer json-invalid">${escapeHtml(content)}</pre><div class="empty">⚠ Invalid JSON: ${escapeHtml(err.message)}</div>`;
    }
    return;
  }
  if (ext === ".jsonl") {
    const blocks = content.split("\n").map((line, i) => {
      if (!line.trim()) return "";
      try {
        JSON.parse(line);
        return `<pre class="json-viewer">${highlightJson(line)}</pre>`;
      } catch (err) {
        return `<pre class="json-viewer json-invalid">${escapeHtml(line)}</pre><div class="empty">⚠ Line ${i + 1}: ${escapeHtml(err.message)}</div>`;
      }
    });
    libraryBodyEl.innerHTML = blocks.join("");
    return;
  }
  if (ext === ".txt") {
    libraryBodyEl.innerHTML = `<pre class="text-viewer">${escapeHtml(content)}</pre>`;
    return;
  }
  // markdown
  libraryBodyEl.innerHTML = window.marked ? window.marked.parse(content) : `<pre>${escapeHtml(content)}</pre>`;
  rewriteRelativeImages(libraryBodyEl, path);
}

async function loadLibraryItems() {
  // SSE delivers the list, so this is a fallback if the stream hasn't populated yet
  if (libraryLoaded) return;
  try {
    const res = await fetch("/api/library/items", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderLibraryList(data.tree || { dirs: [], files: [] });
  } catch (err) {
    libraryListEl.innerHTML = `<li class="empty">Failed to load: ${escapeHtml(err.message)}</li>`;
  }
}

function isLibraryEditing() {
  return !!libraryBodyEl.querySelector(".md-edit-textarea");
}

function exitLibraryEditMode() {
  const actions = libraryEditBtn.parentElement;
  actions.querySelectorAll(".md-edit-btn:not(#library-edit-btn)").forEach((b) => b.remove());
  libraryEditBtn.hidden = true;
  libraryBodyEl.innerHTML = "";
  setMdMobileEditingState(false);
}

function deselectLibraryItem() {
  if (isLibraryEditing()) exitLibraryEditMode();
  currentLibraryPath = null;
  libraryRawText = "";
  libraryListEl.querySelectorAll(".note-item").forEach((b) => b.classList.remove("active"));
  libraryContentEl.hidden = true;
  libraryPlaceholderEl.hidden = false;
  libraryBodyEl.innerHTML = "";
  libraryFileNameEl.textContent = "";
  libraryEditBtn.hidden = true;
  updateLibraryActiveDirs();
  updateMdFooterVisible();
  history.replaceState(null, "", "/library");
}

async function loadLibraryItem(path) {
  if (isLibraryEditing()) exitLibraryEditMode();
  currentLibraryPath = path;
  // Expand ancestor dirs so the active file is visible, then re-render
  // highlighting without refetching data.
  if (expandLibraryAncestorsFor(path)) {
    renderLibraryList(knownLibraryTree);
  } else {
    libraryListEl.querySelectorAll(".note-item").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.path === path);
    });
    updateLibraryActiveDirs();
  }
  libraryPlaceholderEl.hidden = true;
  libraryContentEl.hidden = false;
  libraryFileNameEl.textContent = path;
  // Update the URL without scrolling
  history.replaceState(null, "", `/library/${encodePath(path)}`);

  // Only text is editable, so only text gets the Edit button — and only it
  // puts the mobile edit bar on screen.
  libraryEditBtn.hidden = !isLibraryTextPath(path);
  libraryEditBtn.textContent = "Edit";
  updateMdFooterVisible();

  if (isPdfPath(path)) {
    libraryRawText = "";
    libraryBodyEl.innerHTML = `<div class="empty">Loading PDF…</div>`;
    renderPdf(path);
    return;
  }
  if (LIBRARY_IMAGE_EXTS.has(libraryExt(path))) {
    libraryRawText = "";
    const src = `/api/library/file/${encodePath(path)}`;
    libraryBodyEl.innerHTML = `<div class="image-viewer"><img src="${attrEscape(src)}" alt="${attrEscape(path.split("/").pop())}" /></div>`;
    return;
  }
  libraryBodyEl.innerHTML = `<div class="empty">Loading…</div>`;
  try {
    const res = await fetch(`/api/library/file/${encodePath(path)}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const content = await res.text();
    // A second click while this was in flight already moved on.
    if (currentLibraryPath !== path) return;
    renderLibraryContent(path, content);
  } catch (err) {
    if (currentLibraryPath === path) {
      libraryBodyEl.innerHTML = `<div class="empty">Failed to load: ${escapeHtml(err.message)}</div>`;
    }
  }
}

async function saveLibraryFile(path, content) {
  const res = await fetch("/api/library/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, content }),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
}

function connectLibraryStream() {
  const es = new EventSource("/api/library/stream");
  es.addEventListener("items", (e) => {
    try {
      const { tree } = JSON.parse(e.data);
      const nextTree = tree || { dirs: [], files: [] };
      renderLibraryList(nextTree);
      // The open file was deleted or renamed out from under us.
      if (currentLibraryPath && !findLibraryInTree(nextTree, currentLibraryPath)) {
        deselectLibraryItem();
      }
    } catch (err) { console.error("library stream parse error", err); }
  });
  es.addEventListener("content", (e) => {
    try {
      const { path, content } = JSON.parse(e.data);
      if (path !== currentLibraryPath) return;
      // Don't overwrite what's being typed — keep the new text for Cancel.
      if (isLibraryEditing()) { libraryRawText = content; return; }
      renderLibraryContent(path, content);
    } catch (err) { console.error("library content parse error", err); }
  });
  es.addEventListener("error", () => { /* auto-reconnect */ });
}

// ── Health ────────────────────────────────────────────
let healthLoaded = false;
const healthContentEl = document.getElementById("health-content");
const healthCountEl = document.getElementById("health-count");

function parseLabValue(raw) {
  if (raw == null) return null;
  const v = String(raw).trim();
  if (!v) return null;
  const m = v.match(/^([<>]=?|≈)?\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[2]);
  if (!Number.isFinite(n)) return null;
  return n;
}

function parseHealthRange(raw) {
  if (!raw) return null;
  const v = String(raw).trim();
  if (!v) return null;
  let m;
  if ((m = v.match(/^(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)$/))) {
    return { min: parseFloat(m[1]), max: parseFloat(m[2]) };
  }
  if ((m = v.match(/^<\s*=?\s*(-?\d+(?:\.\d+)?)/))) return { max: parseFloat(m[1]) };
  if ((m = v.match(/^>\s*=?\s*(-?\d+(?:\.\d+)?)/))) return { min: parseFloat(m[1]) };
  return null;
}

function isInRange(value, range) {
  if (value == null || !range) return true;
  if (range.min != null && value < range.min) return false;
  if (range.max != null && value > range.max) return false;
  return true;
}

function formatRange(range) {
  if (!range) return "";
  if (range.min != null && range.max != null) return `${range.min}–${range.max}`;
  if (range.max != null) return `<${range.max}`;
  if (range.min != null) return `>${range.min}`;
  return "";
}

// raw.csv's header carries units in parentheses, but a couple of columns ship
// without them. Filling them in here rather than editing the CSV keeps the fix
// alive across re-exports from nutrition.xlsm. (Calories is deliberately
// absent — it is its own unit.)
const IMPLIED_UNITS = { Creatine: "g" };

// The daily-goals rows in raw.csv: what a day aims at, and the floor and
// ceiling either side of it. All three are renameable, so these are only the
// starting values — /api/nutrition names the current ones in X-Targets-Item /
// -Min / -Max headers and loadNutrition takes them from there (TARGETS_ITEM and
// friends in src/nutrition.js).
const targetsRowNames = {
  item: "Daily Nutrition Target",
  min: "Daily Nutrition Min",
  max: "Daily Nutrition Max",
};

function splitMetricLabel(header) {
  const m = header.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (m) return { label: m[1].trim(), units: m[2].trim() };
  const label = header.trim();
  return { label, units: IMPLIED_UNITS[label] || "" };
}

function renderHealthChart(meta, points, range) {
  const W = 280;
  const H = 110;
  const pad = { top: 14, right: 10, bottom: 22, left: 32 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;

  const dates = points.map((p) => p.t);
  const tMin = Math.min(...dates);
  const tMax = Math.max(...dates);
  const tSpan = Math.max(1, tMax - tMin);

  const values = points.map((p) => p.v);
  let yMin = Math.min(...values);
  let yMax = Math.max(...values);
  if (range?.min != null) yMin = Math.min(yMin, range.min);
  if (range?.max != null) yMax = Math.max(yMax, range.max);
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  const ySpan = yMax - yMin;
  // 8% padding on top/bottom so points don't sit on the edge.
  yMin -= ySpan * 0.08;
  yMax += ySpan * 0.08;

  const xOf = (t) => pad.left + (points.length === 1 ? innerW / 2 : ((t - tMin) / tSpan) * innerW);
  const yOf = (v) => pad.top + (1 - (v - yMin) / (yMax - yMin)) * innerH;

  // Normal-range band
  let bandRect = "";
  if (range) {
    const top = range.max != null ? yOf(range.max) : pad.top;
    const bottom = range.min != null ? yOf(range.min) : pad.top + innerH;
    if (bottom > top) {
      bandRect = `<rect x="${pad.left}" y="${top}" width="${innerW}" height="${bottom - top}" fill="rgba(74,222,128,0.10)" />`;
    }
  }

  // Axes (subtle baseline)
  const axis = `<line x1="${pad.left}" y1="${pad.top + innerH}" x2="${pad.left + innerW}" y2="${pad.top + innerH}" stroke="#262d38" />` +
               `<line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + innerH}" stroke="#262d38" />`;

  // Y ticks (min/max)
  const yTicks =
    `<text x="${pad.left - 4}" y="${pad.top + 4}" text-anchor="end" font-size="9" fill="#8a94a6">${yMax.toFixed(yMax >= 100 ? 0 : 1)}</text>` +
    `<text x="${pad.left - 4}" y="${pad.top + innerH}" text-anchor="end" font-size="9" fill="#8a94a6">${yMin.toFixed(yMin >= 100 ? 0 : 1)}</text>`;

  // X ticks: first/last dates
  const fmtDate = (ms) => {
    const d = new Date(ms);
    return `${String(d.getMonth() + 1)}/${String(d.getDate()).padStart(2, "0")}/${String(d.getFullYear()).slice(-2)}`;
  };
  const xTicks =
    `<text x="${pad.left}" y="${H - 6}" text-anchor="start" font-size="9" fill="#8a94a6">${fmtDate(tMin)}</text>` +
    (tMin === tMax ? "" : `<text x="${pad.left + innerW}" y="${H - 6}" text-anchor="end" font-size="9" fill="#8a94a6">${fmtDate(tMax)}</text>`);

  // Line + points
  let pathD = "";
  if (points.length > 1) {
    pathD = points.map((p, i) => `${i === 0 ? "M" : "L"}${xOf(p.t).toFixed(1)},${yOf(p.v).toFixed(1)}`).join(" ");
  }
  const line = pathD ? `<path d="${pathD}" fill="none" stroke="#5aa9ff" stroke-width="1.5" />` : "";
  const dots = points.map((p) => {
    const ok = isInRange(p.v, range);
    const color = ok ? "#5aa9ff" : "#fbbf24";
    const dateStr = new Date(p.t).toISOString().slice(0, 10);
    return `<circle cx="${xOf(p.t).toFixed(1)}" cy="${yOf(p.v).toFixed(1)}" r="3" fill="${color}" stroke="#0b0d10" stroke-width="1"><title>${dateStr}: ${p.v}${meta.units ? " " + meta.units : ""}</title></circle>`;
  }).join("");

  const latest = points[points.length - 1];
  const latestOk = isInRange(latest.v, range);
  const latestCls = latestOk ? "ok" : "warn";
  const rangeStr = formatRange(range);

  return `
    <div class="health-chart">
      <div class="health-chart-head">
        <div class="health-chart-title">${escapeHtml(meta.label)}${meta.units ? ` <span class="health-units">${escapeHtml(meta.units)}</span>` : ""}</div>
        <div class="health-chart-latest ${latestCls}">${escapeHtml(String(latest.v))}${rangeStr ? `<span class="health-range">ref ${escapeHtml(rangeStr)}</span>` : ""}</div>
      </div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="health-chart-svg">
        ${bandRect}${axis}${yTicks}${xTicks}${line}${dots}
      </svg>
    </div>
  `;
}

function renderHealthPanel(fileName, csvText) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) return "";
  const header = rows[0];
  const rangeRow = rows[1] && /normal_range/i.test(rows[1][0] || "") ? rows[1] : null;
  const dataRows = rangeRow ? rows.slice(2) : rows.slice(1);
  if (dataRows.length === 0) return "";

  const panelTitle = fileName.replace(/\.csv$/i, "").replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  const charts = [];
  for (let col = 1; col < header.length; col++) {
    const points = [];
    for (const r of dataRows) {
      const dStr = (r[0] || "").trim();
      if (!dStr) continue;
      const t = Date.parse(dStr);
      if (!Number.isFinite(t)) continue;
      const v = parseLabValue(r[col]);
      if (v == null) continue;
      points.push({ t, v });
    }
    if (points.length === 0) continue;
    points.sort((a, b) => a.t - b.t);
    const meta = splitMetricLabel(header[col]);
    const range = rangeRow ? parseHealthRange(rangeRow[col]) : null;
    charts.push(renderHealthChart(meta, points, range));
  }

  if (charts.length === 0) return "";
  return `
    <section class="health-panel">
      <h3 class="health-panel-title">${escapeHtml(panelTitle)}</h3>
      <div class="health-charts-grid">${charts.join("")}</div>
    </section>
  `;
}

// The library tree is the whole notebook, and more than one folder in it is
// called "health" — so this walks to the one exact path rather than hunting
// for a name.
const HEALTH_REPORTS_DIR = "data/reports/health";

function findLibraryDir(tree, path) {
  let node = tree;
  for (const name of path.split("/")) {
    node = (node?.dirs || []).find((d) => d.name === name);
    if (!node) return null;
  }
  return node;
}

async function loadHealth() {
  if (healthLoaded) return;
  healthLoaded = true;
  try {
    const res = await fetch("/api/library/items", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { tree } = await res.json();
    const healthDir = findLibraryDir(tree || { dirs: [], files: [] }, HEALTH_REPORTS_DIR);
    if (!healthDir) {
      healthContentEl.innerHTML = `<div class="empty">No ${HEALTH_REPORTS_DIR}/ directory.</div>`;
      return;
    }
    const csvFiles = (healthDir.files || []).filter((f) => f.name.toLowerCase().endsWith(".csv"));
    if (csvFiles.length === 0) {
      healthContentEl.innerHTML = `<div class="empty">No CSV reports in health/.</div>`;
      return;
    }
    healthCountEl.textContent = csvFiles.length;
    healthContentEl.innerHTML = `<div class="empty">Loading ${csvFiles.length} panel${csvFiles.length === 1 ? "" : "s"}…</div>`;
    const texts = await Promise.all(
      csvFiles.map((f) =>
        fetch(`/api/library/file/${encodePath(f.path)}`, { cache: "no-store" })
          .then((r) => (r.ok ? r.text() : ""))
          .catch(() => "")
      )
    );
    const panels = csvFiles.map((f, i) => (texts[i] ? renderHealthPanel(f.name, texts[i]) : "")).filter(Boolean);
    healthContentEl.innerHTML = panels.length ? panels.join("") : `<div class="empty">No chartable metrics.</div>`;
  } catch (err) {
    healthLoaded = false;
    healthContentEl.innerHTML = `<div class="empty">Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}

// ── Nutrition ─────────────────────────────────────────
// Reference table of foods, exported from the "raw" tab of nutrition.xlsm.
// Each row is one food at a stated serving; the ~44 nutrient columns are
// absolute amounts for that serving (not per-100g).
let nutritionLoaded = false;
let nutritionRows = [];
let nutritionCols = [];
let nutritionQuery = "";
const nutritionExpanded = new Set();
const nutritionContentEl = document.getElementById("nutrition-content");
const nutritionCountEl = document.getElementById("nutrition-count");
const nutritionLegendEl = document.getElementById("nutrition-legend");
const nutritionSearchEl = document.getElementById("nutrition-search");

// Atwater factors — used only to split a food's calories into macro shares.
const KCAL_PER_G = { carbs: 4, protein: 4, fat: 9 };

function nutritionGroupOf(label) {
  if (/^vitamin/i.test(label)) return "Vitamins";
  if (/^(calcium|iron|magnesium|potassium|zinc|selenium|manganese|phosphorus|copper|iodine|sodium)$/i.test(label)) return "Minerals";
  if (/fat|omega|cholesterol/i.test(label)) return "Fats";
  if (/^(calories|carbs|protein|sugar|added sugar|fructose|fiber)$/i.test(label)) return "Macros";
  return "Other";
}
const NUTRITION_GROUP_ORDER = ["Macros", "Fats", "Vitamins", "Minerals", "Other"];

// What a cell shows when there's no figure for it — a blank in one of the daily
// rows, or a row the table has lost. Distinct from "0", which is a figure.
const NO_VALUE = "—";

// Trim float noise without lying about small trace amounts (0.001 mg is real).
function fmtNutrient(n) {
  if (!Number.isFinite(n)) return NO_VALUE;
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 100) return String(Math.round(n));
  if (abs >= 10) return String(Math.round(n * 10) / 10);
  if (abs >= 1) return String(Math.round(n * 100) / 100);
  return String(parseFloat(n.toPrecision(2)));
}

// ── Cards / table view toggle ─────────────────────────
// The three nutrition tabs each render the same records two ways: as cards
// (scannable, expandable, editable) or as one wide spreadsheet row per record
// (comparable across every nutrient). The choice sticks per tab.
function createViewToggle(el, storageKey, onChange) {
  // The nutrient grid is what these tabs are for, so table leads and cards are
  // the opt-in. A stored "cards" is a deliberate past choice — honour it.
  let view = "table";
  try { if (localStorage.getItem(storageKey) === "cards") view = "cards"; } catch {}

  function paint() {
    for (const b of el?.querySelectorAll(".view-toggle-btn") || []) {
      const active = b.dataset.view === view;
      b.classList.toggle("active", active);
      b.setAttribute("aria-pressed", String(active));
    }
  }

  el?.addEventListener("click", (e) => {
    const btn = e.target.closest(".view-toggle-btn");
    if (!btn || btn.dataset.view === view) return;
    view = btn.dataset.view;
    try { localStorage.setItem(storageKey, view); } catch {}
    paint();
    onChange(view);
  });

  paint();
  return { get: () => view, isTable: () => view === "table" };
}

/** Nutrient columns in the shape renderNutrientTable wants, from a header list. */
function tableColsFromNames(names) {
  return names.map((raw) => {
    const { label, units } = splitMetricLabel(raw);
    return { key: raw, raw, label, units };
  });
}

/**
 * One row per record, one column per nutrient. The name column is sticky and
 * the rest scroll horizontally — there are ~45 nutrients, so the table has to
 * scroll inside its own wrapper rather than widening the page.
 *
 * Pinned rows ride in the header, stacking directly under the column labels so
 * they stay on screen as yardsticks while the body scrolls past.
 *
 * A row's cells come from `values`; a null `values` renders em-dashes (nothing
 * chosen yet). `nameHtml` replaces the name cell's text for rows that need a
 * control in it rather than a label.
 *
 * Lead columns come before the nutrients and hold text, not numbers — serving
 * size and its unit, which describe the row rather than measuring it. They're
 * kept out of `cols` on purpose: `cols` is what every totals routine sums over.
 *
 * `attrs` is spliced onto the `<tr>` itself — how a row says what it can be
 * dragged as and what can be dropped on it (see the food-drag section).
 *
 * @param {Array}  cols        [{ key, raw, label, units }]
 * @param {Array}  rows        [{ name, nameHtml, meta, values, cellsHtml, lead, actions, variant, attrs }]
 * @param {object} [opts]
 * @param {Array|object} [opts.pinned]         Row(s) of the same shape.
 * @param {boolean} [opts.stickyParents]       Hang each parent under the header.
 */
const LEAD_COLS = [
  { key: "size", label: "Serving" },
  { key: "unit", label: "Unit" },
];

function renderNutrientTable(cols, rows, { pinned = [], stickyParents = false } = {}) {
  const pinnedRows = (Array.isArray(pinned) ? pinned : [pinned]).filter(Boolean);
  const head =
    LEAD_COLS.map((c) => `<th scope="col" class="ntable-lead">${escapeHtml(c.label)}</th>`).join("") +
    cols
      .map((c) => `<th scope="col" title="${escapeHtml(c.raw)}">${escapeHtml(c.label)}${c.units ? `<span class="ntable-units">${escapeHtml(c.units)}</span>` : ""}</th>`)
      .join("");
  const hasActions = rows.some((r) => r.actions);

  const renderRow = (r, extraClass = "") => {
    const cls = [extraClass, r.variant ? `ntable-row-${r.variant}` : ""].filter(Boolean).join(" ");
    const cells =
      LEAD_COLS.map((c) => `<td class="ntable-lead">${r.leadHtml?.[c.key] ?? escapeHtml(r.lead?.[c.key] ?? "")}</td>`).join("") +
      // `cellsHtml` is for a row whose nutrient cells aren't readings — the
      // targets row while it's being edited puts a box in every one of them.
      (r.cellsHtml ?? renderNutrientCells(cols, r.values, r.bounds));
    // Actions lead the row, ahead of the name: both pin to the left edge, so the
    // controls are the first thing under the pointer at any scroll position.
    return `<tr${cls ? ` class="${cls}"` : ""}${r.attrs ? ` ${r.attrs}` : ""}>
      ${hasActions ? `<td class="ntable-actions">${r.actions || ""}</td>` : ""}
      <th scope="row" class="ntable-name">
        ${r.nameHtml || `<span class="ntable-name-text">${escapeHtml(r.name)}</span>`}
        ${r.meta ? `<span class="ntable-meta">${escapeHtml(r.meta)}</span>` : ""}
      </th>
      ${cells}
    </tr>`;
  };

  // Sticky parents hang under the header while their own rows scroll past. A
  // sticky table cell is confined to the table, not its row group, so the
  // outgoing parent doesn't get pushed off — the next one comes to rest on the
  // same line and, being later in the DOM at equal z-index with an opaque
  // background, covers it. The hand-off reads as a replacement either way.
  const body = rows
    .map((r) => renderRow(r, stickyParents && r.variant === "parent" ? "ntable-sticky-parent" : ""))
    .join("");

  // Room under the last row for the wrapper's horizontal scrollbar, which on a
  // Mac is drawn over the content rather than beside it and otherwise lands on
  // the last row's figures. A row rather than padding on the scroller: end-edge
  // padding inside a scroll container isn't honoured the same way everywhere,
  // and a row is part of the table's own height wherever it's read. Every cell
  // is present rather than one spanning the lot, so the column rules — and the
  // pinned columns' backgrounds — carry down to the bottom edge instead of the
  // grid stopping short of it.
  const spacer = `<tr class="ntable-spacer" aria-hidden="true">
    ${hasActions ? `<td class="ntable-actions"></td>` : ""}
    <th scope="row" class="ntable-name"></th>
    ${LEAD_COLS.map(() => `<td class="ntable-lead"></td>`).join("")}
    ${cols.map(() => "<td></td>").join("")}
  </tr>`;

  return `<div class="ntable-wrap"><table class="ntable">
    <thead>
      <tr>${hasActions ? `<th scope="col" class="ntable-actions">&nbsp;</th>` : ""}<th scope="col" class="ntable-name">Item</th>${head}</tr>
      ${pinnedRows.map((r) => renderRow(r, "ntable-pinned")).join("")}
    </thead>
    <tbody>${body}${spacer}</tbody>
  </table></div>`;
}

/**
 * The `<td>`s for one row — shared so a row can be refilled without a re-render.
 *
 * `bounds` is the daily min/max a row of totals is judged against: a figure
 * short of the floor or past the ceiling is flagged in the cell's own colour, so
 * a day's problems are visible without reading it against the pinned rows column
 * by column. A 0 in a bounds row means "not tracked" — the same reading the
 * targets row has always had — so it never flags anything. A blank cell in one
 * reads the same way and shows as a dash: no figure for that nutrient at all,
 * as against a figure that happens to be zero.
 */
function renderNutrientCells(cols, values, bounds = null) {
  return cols
    .map((c) => {
      if (!values) return `<td class="is-zero">${NO_VALUE}</td>`;
      const raw = values[c.key];
      if (raw === null || raw === "") return `<td class="is-zero">${NO_VALUE}</td>`;
      const v = raw || 0;
      const min = bounds?.min?.[c.key] || 0;
      const max = bounds?.max?.[c.key] || 0;
      const flag = min > 0 && v < min ? " ntable-under-min" : max > 0 && v > max ? " ntable-over-max" : "";
      const cls = [v === 0 ? "is-zero" : "", flag.trim()].filter(Boolean).join(" ");
      return `<td${cls ? ` class="${cls}"` : ""}>${fmtNutrient(v)}</td>`;
    })
    .join("");
}

/**
 * Pinned rows stack under the column labels, so each one's sticky offset is the
 * sum of the rows above it — and the label row is two lines for nutrients with
 * units, one for the rest. Measure after paint rather than guessing constants.
 */
function syncPinnedTableRows(container) {
  const wrap = container?.querySelector(".ntable-wrap");
  if (!wrap) return;
  const headRows = [...wrap.querySelectorAll("thead tr")];
  requestAnimationFrame(() => {
    fitTableToViewport(wrap);
    // The name column pins to the left *after* the actions column, whose width
    // is whatever its icons come to — one button on a nested row, two on a
    // parent. Measured, since it differs per table, and set ahead of the header
    // measurements below, which give up when the panel is hidden: a table with
    // no actions column at all must not keep the CSS fallback's inset.
    const actions = wrap.querySelector("thead .ntable-actions");
    const actionsW = actions ? actions.getBoundingClientRect().width : 0;
    if (!actions || actionsW > 0) wrap.style.setProperty("--ntable-actions-w", `${actionsW}px`);
    let top = 0;
    for (const tr of headRows) {
      const h = tr.getBoundingClientRect().height;
      // Zero means the panel was hidden when we measured — leave the CSS
      // fallbacks rather than stacking every row at the same offset.
      if (h <= 0) return;
      for (const cell of tr.children) cell.style.top = `${top}px`;
      top += h;
    }
    // Where the header ends is where a sticky section row has to come to rest.
    // A custom property rather than inline tops: a grouped table has a parent
    // row per group and ~46 cells in each.
    wrap.style.setProperty("--ntable-body-top", `${top}px`);
  });
}

/**
 * Cap the table at whatever room is left below it inside <main>, so the table
 * body is the only thing that scrolls and the page has nothing left over.
 * Measured rather than a `calc(100vh - …)` guess, since what sits above the
 * table differs per tab (search box, view toggle, warnings).
 */
const TABLE_VIEWPORT_GAP = 12;

function fitTableToViewport(wrap) {
  // Clearing the cap below lets the table run to its full height and re-capping
  // shrinks it again. If <main> happens to be scrolled, that shrink leaves its
  // scrollTop past the new end and the browser clamps it — which is the page
  // twitching under you every time a stepper re-renders the table. Take the
  // position now and put it back once the sizing has settled.
  const mainScroll = mainEl.scrollTop;
  // The wrapper's own position goes the same way, and worse: uncapped it doesn't
  // scroll at all, so the browser doesn't clamp its scrollTop, it zeroes it.
  // That's the table snapping back to the first row a frame after a re-render —
  // restoreTableScroll puts it back, then the rAF'd sync lands here and undoes
  // it. Only the height is being remeasured; where you were reading is not.
  const wrapScroll = wrap.scrollTop;
  // Across too. Nothing here touches the width, but clearing the cap takes the
  // vertical scrollbar away and re-capping brings it back, and where that
  // scrollbar takes its room from the content rather than beside it, each
  // change moves the horizontal extent under the offset.
  const wrapScrollX = wrap.scrollLeft;
  // Clear last run's sizing first: both the wrapper's cap and the panel's pulled
  // margin would otherwise skew the measurements taken below.
  wrap.style.maxHeight = "";
  // Outermost box under <main> — the tab panel wrapping the table's card.
  let panel = wrap;
  while (panel.parentElement && panel.parentElement !== mainEl) panel = panel.parentElement;
  panel.style.marginBottom = "";

  // Offset within <main>'s scrollable content, so the measurement holds whether
  // or not the page happens to be scrolled when we take it.
  const top = wrap.getBoundingClientRect().top - mainEl.getBoundingClientRect().top + mainEl.scrollTop;
  // Everything between the table's bottom edge and the panel's — card padding
  // and border, mostly. The card has to keep enclosing the table, so that room
  // comes out of the table's budget rather than spilling past the card.
  let below = 0;
  for (let el = wrap; el !== panel; el = el.parentElement) {
    below += el.parentElement.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom;
  }
  const avail = mainEl.clientHeight - top - below - TABLE_VIEWPORT_GAP;
  if (avail <= 180) {
    mainEl.scrollTop = mainScroll;
    wrap.scrollTop = wrapScroll;
    wrap.scrollLeft = wrapScrollX;
    return;
  }
  wrap.style.maxHeight = `${Math.floor(avail)}px`;
  // <main> carries a tall bottom padding for the rest of the app; under a fitted
  // table that padding is nothing but leftover page scroll — the reason the
  // whole table used to drift up the screen — so pull it back to just the gap.
  // On the panel, not the wrapper: a negative margin inside the card would end
  // the card's box above its own content.
  const padBottom = parseFloat(getComputedStyle(mainEl).paddingBottom) || 0;
  panel.style.marginBottom = `${TABLE_VIEWPORT_GAP - padBottom}px`;
  mainEl.scrollTop = mainScroll;
  wrap.scrollTop = wrapScroll;
  wrap.scrollLeft = wrapScrollX;
}

/**
 * Put a rebuilt table back where it was. A re-render replaces the whole
 * wrapper, so the scroller starts at the top-left again.
 *
 * The vertical position needs the height cap back before it will take: without
 * one the wrapper doesn't scroll at all and any scrollTop is clamped straight to
 * zero. That cap normally lands a frame later, in the rAF syncPinnedTableRows
 * queues — so fit it here instead, in the same frame, and there's nothing to
 * see. Fitting is idempotent; the queued run just measures the same numbers.
 */
function restoreTableScroll(container, x, y) {
  const wrap = container?.querySelector(".ntable-wrap");
  if (!wrap) return;
  // Unconditionally, not just when there's a vertical offset to put back. The
  // fit is also what forces the layout the two assignments below are measured
  // against, and a freshly parsed wrapper has none: engines that don't flush
  // one for a scroll write see scrollWidth === clientWidth and clamp both
  // offsets to zero — the table landing back at its top-left corner.
  fitTableToViewport(wrap);
  wrap.scrollLeft = x;
  wrap.scrollTop = y;
}

/**
 * Re-render a table's panel and leave the reader where they were. Both scrollers
 * have to be read before the swap: the wrapper because it's replaced outright,
 * and <main> because the panel is momentarily empty in between, which clamps its
 * scrollTop to a page that isn't there any more.
 */
function renderTableKeepingScroll(container, render) {
  const wrap = container?.querySelector(".ntable-wrap");
  const x = wrap?.scrollLeft || 0;
  const y = wrap?.scrollTop || 0;
  const main = mainEl.scrollTop;
  render();
  restoreTableScroll(container, x, y);
  mainEl.scrollTop = main;
  // render() queues a measure-and-fit of its own (syncPinnedTableRows), which
  // clears the height cap to remeasure and so hands the scroller back its
  // zeroes for a moment. It puts the offsets back itself, but only the ones it
  // can see — anything the assignments above didn't take on this engine is
  // gone by then. Land after it and set them once more; a second write costs
  // nothing where the first one held.
  requestAnimationFrame(() => {
    restoreTableScroll(container, x, y);
    mainEl.scrollTop = main;
  });
}

window.addEventListener("resize", () => {
  for (const wrap of document.querySelectorAll(".ntable-wrap")) {
    if (wrap.offsetParent) fitTableToViewport(wrap);
  }
});

/**
 * The column half of the nutrient tables' hover crosshair. The row half is pure
 * CSS (`tr:hover`, see styles.css); a column has no selector at all, so the
 * hovered cell's position is turned into one rule and rewritten as it moves.
 *
 * A rule rather than a class on each cell: a column is one cell per row and
 * these tables run to hundreds, so classing them would mean touching every one
 * of them on every crossing between two columns. Every row — header, pinned,
 * body, the closing spacer — is built from the same cell list, so a single
 * :nth-child lights the column top to bottom.
 *
 * Both borders of the column come from a border-right: its own, and the
 * previous column's — so the border rule spans two columns while the fill is
 * only ever the hovered one. `:not(:last-child)` leaves the rule the last
 * column drops against the wrapper's edge dropped (see .ntable tr >
 * *:last-child).
 *
 * The fill runs the column's whole height — nutrient label, the pinned
 * target/min/max rows, the body, and the spacer that closes the table. Four
 * selectors rather than one because the cells it has to beat are set at four
 * different strengths: the label row and the pinned rows each paint their own
 * --card (the pinned one more specifically), and the food-log group rows paint
 * --row-sunken from behind an id.
 */
const ntableHoverStyleEl = document.createElement("style");
document.head.appendChild(ntableHoverStyleEl);
let ntableHoverCol = 0;

function setNtableHoverColumn(n) {
  if (n === ntableHoverCol) return;
  ntableHoverCol = n;
  ntableHoverStyleEl.textContent = n
    ? `.ntable tr > :nth-child(${n}):not(:last-child),
       .ntable tr > :nth-child(${n - 1}):not(:last-child) { border-right-color: var(--grid-hover); }
       #tab-food-logs .ntable tbody tr > :nth-child(${n}),
       .ntable tbody tr > :nth-child(${n}),
       .ntable thead tr > :nth-child(${n}),
       .ntable thead .ntable-pinned > :nth-child(${n}) { background: var(--row-hover); }`
    : "";
}

// Delegated, so it survives the wholesale re-render every table edit does.
// mouseover fires on whatever is entered next, including the page outside the
// table — which is what clears the column.
document.addEventListener("mouseover", (e) => {
  const cell = e.target instanceof Element ? e.target.closest(".ntable td, .ntable th") : null;
  const row = cell?.parentElement;
  setNtableHoverColumn(row ? [...row.children].indexOf(cell) + 1 : 0);
});

// Icons rather than words in the actions column: three labels across every row
// cost more width than the column is worth, and these three actions are common
// enough to read as glyphs. The label lives on title/aria-label.
const svgIcon = (paths) =>
  `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
     stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const ROW_ICONS = {
  edit: svgIcon(`<path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path>`),
  delete: svgIcon(`<polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>`),
  save: svgIcon(`<polyline points="20 6 9 17 4 12"></polyline>`),
  cancel: svgIcon(`<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>`),
  // Two sheets, one behind the other — the same glyph for duplicating a day
  // and for copying a group into another one. They differ in what they act on,
  // not in what they do, and the row you're on says which.
  copy: svgIcon(`<rect x="9" y="9" width="12" height="12" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>`),
};

/** One icon button for the actions column. `data` addresses the row. */
function iconAction(act, icon, label, data, extraClass = "") {
  return `<button class="ntable-icon-btn${extraClass ? ` ${extraClass}` : ""}" data-act="${act}" ${data}
      type="button" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${ROW_ICONS[icon]}</button>`;
}

/**
 * Delete/Edit for a table row. Same `data-act`/`data-id` contract the cards
 * use, so the existing delegated handlers on the content element pick these up
 * with no changes.
 *
 * Delete leads: the nested rows below a parent carry a Remove in that same first
 * position, so the trash sits in one column all the way down instead of jumping
 * a place at every level. `extra` is for actions only one table has.
 */
function rowActions(id, extra = "") {
  const data = `data-id="${escapeHtml(id)}"`;
  return iconAction("delete", "delete", "Delete", data, "ntable-icon-danger") +
    extra +
    iconAction("edit", "edit", "Edit", data);
}

/**
 * A button mid-action, in whichever form it takes: the cards' Delete says so in
 * words, while the table's icon keeps its glyph — swapping in text there would
 * jump the column's width mid-click — and carries the state on its label.
 */
function setBtnBusy(btn, label, { failed = false } = {}) {
  btn.disabled = !failed;
  if (!btn.classList.contains("ntable-icon-btn")) {
    btn.textContent = label;
    return;
  }
  btn.classList.toggle("is-busy", !failed);
  btn.classList.toggle("is-failed", failed);
  btn.title = label;
  btn.setAttribute("aria-label", label);
}

/**
 * The disclosure caret, drawn rather than typed: `▸` sits off-centre in its em
 * box, so rotating the glyph to point down moved it as well as turned it. A
 * path centred on the viewBox rotates about the mark itself and stays put.
 */
const CARET_ICON = `<svg class="ntable-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
  ><polyline points="9 5 15 12 9 19"></polyline></svg>`;

/**
 * A parent row's name as a disclosure control. Nested rows start collapsed —
 * a dozen groups' worth of foods expanded at once buries the totals you came to
 * compare.
 */
function disclosureName(id, name, open) {
  return `<button class="ntable-disclosure" data-act="toggle-rows" data-id="${escapeHtml(id)}"
      type="button" aria-expanded="${open}">
      ${CARET_ICON}
      <span class="ntable-name-text">${escapeHtml(name)}</span>
    </button>`;
}

/**
 * The same name cell with the name in a box instead — what a row looks like
 * while it's being renamed, and how an ad-hoc group is named in the first place.
 * The caret keeps its place beside the box rather than taking the whole cell, so
 * a row can still be opened while its name is being typed; `caret` is left out
 * for rows that have nothing to open.
 *
 * `data` addresses the input for the tab's own handlers.
 */
function nameEditor({ name, data, placeholder = "", aria, caret = null }) {
  const disclosure = caret
    ? `<button class="ntable-disclosure ntable-disclosure-caret${caret.child ? " ntable-disclosure-child" : ""}"
        data-act="${caret.act}" ${caret.data} type="button" aria-expanded="${caret.open}"
        aria-label="Show foods">${CARET_ICON}</button>`
    : "";
  return `<span class="ntable-name-edit">${disclosure}
    <input class="ntable-name-input" type="text" value="${escapeHtml(name)}" placeholder="${escapeHtml(placeholder)}"
      ${data} autocomplete="off" aria-label="${escapeHtml(aria)}" />
  </span>`;
}

/** Save/Cancel for a row being edited, in place of its usual actions. */
function editRowActions(id, extraData = "") {
  const data = `data-id="${escapeHtml(id)}" ${extraData}`.trim();
  return iconAction("save-edits", "save", "Save", data, "ntable-icon-go") +
    iconAction("cancel-edits", "cancel", "Cancel", data);
}

/** Keep the toolbar's expand/collapse-all button in step with what's open. */
function syncExpandAllBtn(btn, records, expanded) {
  if (!btn) return;
  btn.hidden = records.length === 0;
  btn.textContent = records.every((r) => expanded.has(r.id)) ? "Collapse all" : "Expand all";
}

/**
 * Open everything, or — when everything already is — close it. Only the records
 * it was handed: the Meal Log tab's set is keyed across every day, and
 * clearing it wholesale would close the days that aren't even on screen.
 */
function toggleExpandAll(records, expanded, rerender) {
  const allOpen = records.every((r) => expanded.has(r.id));
  for (const r of records) {
    if (allOpen) expanded.delete(r.id);
    else expanded.add(r.id);
  }
  rerender();
}

function parseNutritionCsv(text) {
  const rows = parseCsv(text).filter((r) => r.some((c) => (c || "").trim() !== ""));
  if (rows.length < 2) return { cols: [], items: [] };
  const header = rows[0];
  const cols = header.map((h, i) => {
    const { label, units } = splitMetricLabel(h);
    return { i, raw: h, label, units, group: nutritionGroupOf(label) };
  });
  const byLabel = (name) => cols.find((c) => c.label.toLowerCase() === name.toLowerCase());
  const idx = {
    item: 0,
    size: byLabel("Serving Size")?.i,
    unit: byLabel("Serving Unit")?.i,
    servings: byLabel("Servings")?.i,
    calories: byLabel("Calories")?.i,
    carbs: byLabel("Carbs")?.i,
    protein: byLabel("Protein")?.i,
    fat: byLabel("Fat")?.i,
    fiber: byLabel("Fiber")?.i,
    sodium: byLabel("Sodium")?.i,
  };
  // Nutrient columns = everything except the identity/serving columns.
  const identity = new Set([idx.item, idx.size, idx.unit, idx.servings].filter((n) => n != null));
  const nutrientCols = cols.filter((c) => !identity.has(c.i));

  // A blank cell in one of the three daily rows is null rather than 0: there is
  // no figure for that nutrient, which is not the same as a target of zero
  // (trans fat's 0 is a real ceiling). Foods keep the 0 — a food with no vitamin
  // K has none, and every total that adds it up wants the number.
  const dailyRowNames = new Set(
    Object.values(targetsRowNames).filter(Boolean).map((n) => n.toLowerCase()),
  );

  const items = [];
  for (const r of rows.slice(1)) {
    const name = (r[idx.item] || "").trim();
    if (!name) continue;
    const blank = dailyRowNames.has(name.toLowerCase())
      ? (i) => i != null && (r[i] || "").trim() === ""
      : () => false;
    const num = (i) => {
      if (i == null) return 0;
      const v = parseFloat((r[i] || "").trim());
      return Number.isFinite(v) ? v : 0;
    };
    items.push({
      name,
      size: (r[idx.size] || "").trim(),
      unit: (r[idx.unit] || "").trim(),
      servings: (r[idx.servings] || "").trim(),
      calories: num(idx.calories),
      carbs: num(idx.carbs),
      protein: num(idx.protein),
      fat: num(idx.fat),
      fiber: num(idx.fiber),
      sodium: num(idx.sodium),
      values: Object.fromEntries(nutrientCols.map((c) => [c.i, blank(c.i) ? null : num(c.i)])),
    });
  }
  return { cols: nutrientCols, items };
}

// Stacked proportional bar: each macro's share of the food's macro calories.
// 2px surface gaps separate the segments (no strokes), per the mark spec.
function renderMacroBar(item) {
  const energy = {
    carbs: item.carbs * KCAL_PER_G.carbs,
    protein: item.protein * KCAL_PER_G.protein,
    fat: item.fat * KCAL_PER_G.fat,
  };
  const total = energy.carbs + energy.protein + energy.fat;
  if (total <= 0) return `<div class="nutrition-bar nutrition-bar-empty" title="No macronutrient calories"></div>`;
  const segs = ["carbs", "protein", "fat"]
    .filter((k) => energy[k] > 0)
    .map((k) => {
      const pct = (energy[k] / total) * 100;
      const label = k[0].toUpperCase() + k.slice(1);
      const tip = `${label}: ${fmtNutrient(item[k])} g · ${Math.round(energy[k])} cal · ${Math.round(pct)}%`;
      return `<div class="nutrition-seg" data-macro="${k}" style="flex:${pct.toFixed(3)}" title="${escapeHtml(tip)}"></div>`;
    })
    .join("");
  return `<div class="nutrition-bar">${segs}</div>`;
}

function renderNutritionDetail(item) {
  const groups = new Map();
  for (const c of nutritionCols) {
    if (!groups.has(c.group)) groups.set(c.group, []);
    groups.get(c.group).push(c);
  }
  const blocks = NUTRITION_GROUP_ORDER.filter((g) => groups.has(g)).map((g) => {
    const cells = groups
      .get(g)
      .map((c) => {
        // null is a blank in one of the daily rows: no figure, not a zero.
        const v = item.values[c.i] ?? null;
        return `
          <div class="nutrition-cell${v === 0 || v === null ? " is-zero" : ""}">
            <span class="nutrition-cell-label" title="${escapeHtml(c.raw)}">${escapeHtml(c.label)}</span>
            <span class="nutrition-cell-value">${v === null ? NO_VALUE : fmtNutrient(v)}${c.units ? `<span class="nutrition-cell-units">${escapeHtml(c.units)}</span>` : ""}</span>
          </div>`;
      })
      .join("");
    return `
      <div class="nutrition-group">
        <h4 class="nutrition-group-title">${escapeHtml(g)}</h4>
        <div class="nutrition-grid">${cells}</div>
      </div>`;
  });
  return `<div class="nutrition-detail">${blocks.join("")}
    <div class="nutrition-item-actions">
      <button class="nutrition-delete-btn" data-act="delete-food" type="button">Delete food</button>
      <span class="nutrition-delete-status"></span>
    </div>
  </div>`;
}

function renderNutritionRow(item, i) {
  const open = nutritionExpanded.has(i);
  const serving = [item.size, item.unit].filter(Boolean).join(" ");
  const stat = (label, value, units) =>
    `<span class="nutrition-stat"><span class="nutrition-stat-label">${label}</span>${fmtNutrient(value)}<span class="nutrition-stat-units">${units}</span></span>`;
  return `
    <div class="nutrition-item${open ? " open" : ""}" data-index="${i}">
      <button class="nutrition-row" type="button" aria-expanded="${open}">
        <span class="nutrition-row-main">
          <span class="nutrition-name">${escapeHtml(item.name)}</span>
          <span class="nutrition-serving">${escapeHtml(serving)}</span>
        </span>
        <span class="nutrition-cal">${fmtNutrient(item.calories)}<span class="nutrition-cal-units">cal</span></span>
      </button>
      <div class="nutrition-row-viz">
        ${renderMacroBar(item)}
        <div class="nutrition-stats">
          ${stat("C", item.carbs, "g")}
          ${stat("P", item.protein, "g")}
          ${stat("F", item.fat, "g")}
          ${stat("Fiber", item.fiber, "g")}
          ${stat("Sodium", item.sodium, "mg")}
        </div>
      </div>
      ${open ? renderNutritionDetail(item) : ""}
    </div>`;
}

function renderNutrition() {
  const q = nutritionQuery.trim().toLowerCase();
  // Keep the original index as the identity for expand state, so filtering and
  // sorting never expand the wrong food.
  let list = nutritionRows.map((item, i) => ({ item, i }));
  if (q) list = list.filter(({ item }) => item.name.toLowerCase().includes(q));
  list.sort((a, b) => a.item.name.localeCompare(b.item.name));

  nutritionCountEl.textContent = q ? `${list.length} / ${nutritionRows.length}` : String(nutritionRows.length);
  // The legend explains the macro bar, which only the card view draws.
  nutritionLegendEl.hidden = list.length === 0 || nutritionView.isTable();
  // Mirror image: every row the cog governs is part of the table's header, so
  // it only has something to act on in table view — and only where a search has
  // left a table to draw it on.
  nutritionConfigEl.hidden = !nutritionView.isTable() || list.length === 0;

  if (list.length === 0) {
    nutritionContentEl.innerHTML = `<div class="empty">No foods match “${escapeHtml(nutritionQuery)}”.</div>`;
    return;
  }
  if (nutritionView.isTable()) {
    const cols = nutritionCols.map((c) => ({ key: c.i, raw: c.raw, label: c.label, units: c.units }));
    // Serving size and unit have columns of their own now, so the name cell
    // carries only the name. Edit and Delete ride in the pinned actions column
    // the way a day's rows carry theirs; the row being edited trades them
    // for Save/Cancel and turns its cells into boxes.
    const toRow = ({ item, i }) => {
      const key = foodRowKey(i);
      const editing = nutritionEdits?.key === key;
      const row = {
        name: item.name,
        lead: { size: item.size, unit: item.unit },
        values: item.values,
        actions: editing ? editRowActions(key) : rowActions(key),
      };
      return editing ? nutritionEditRow(row, cols) : row;
    };
    // The target and the min and max either side of it are yardsticks, not
    // foods — lift them out of the A–Z list and pin them under the headers so
    // every column can be read against all three. They come from the unfiltered
    // rows, so searching never scrolls them away. Stacked high to low — max,
    // target, min — so the three read as one descending range.
    const targetItems = ["max", "item", "min"].map((role) => [role, nutritionTargetItem(role)]);
    const pinned = targetItems
      // Each of the three unpins on its own from the cog. `pinnedItems` below is
      // still built from all three, so unpinning one never drops it back into
      // the A–Z list as if it were a food.
      .filter(([role, item]) => item && nutritionConfig[role === "item" ? "target" : role])
      .map(([role, item]) => nutritionTargetsRow(cols, item, role));
    if (nutritionConfig.log) pinned.push(nutritionCompareRow(cols));
    const pinnedItems = new Set(targetItems.map(([, item]) => item).filter(Boolean));
    const rows = list.filter(({ item }) => !pinnedItems.has(item)).map(toRow);
    nutritionContentEl.innerHTML = renderNutrientTable(cols, rows, { pinned });
    syncPinnedTableRows(nutritionContentEl);
    // Only worth the fetch when there's a picker to fill.
    if (nutritionConfig.log) ensureCompareDataLoaded();
    return;
  }
  nutritionContentEl.innerHTML = list.map(({ item, i }) => renderNutritionRow(item, i)).join("");
}

const nutritionView = createViewToggle(
  document.getElementById("nutrition-view"),
  "dash-nutrition-view",
  () => renderNutrition(),
);

// ── Food table: editing a row ─────────────────────────
// Every row in this table is a line in raw.csv — a food, or one of the three
// daily rows — so all of them are edited the same way and go back through the
// same write the add form uses. raw.csv holds one line per item, so there's no
// updating part of a row: a save sends it whole.
//
// One row at a time. `key` addresses it in the rendered table, `item` is the row
// as loaded — the name in it is the one on file, which is what a rename has to
// be told to replace. Values are typed strings keyed by column index. Null the
// rest of the time, which is also what says no row is being edited.
let nutritionEdits = null; // { key, item, name, size, unit, values: { [colIndex]: string } }

// Rows are keyed by their index in nutritionRows; the three daily rows by role,
// since they're pinned out of that list and their names can change.
const foodRowKey = (i) => `food:${i}`;
const targetRowKey = (role) => `target:${role}`;

/** The row a key addresses, whichever kind it is. */
function nutritionRowFor(key) {
  const [kind, ref] = String(key).split(":");
  return kind === "target" ? nutritionTargetItem(ref) : nutritionRows[Number(ref)];
}

/** Open a row for editing, staged exactly as it stands. */
function startNutritionEdit(key, item) {
  nutritionEdits = {
    key,
    item,
    name: item.name,
    size: item.size,
    unit: item.unit,
    // A blank daily-row cell opens as an empty box, and saving it empty leaves
    // it blank — typing a 0 in is how you say the figure really is zero.
    values: Object.fromEntries(
      nutritionCols.map((c) => [c.i, item.values[c.i] == null ? "" : String(item.values[c.i])]),
    ),
  };
}

/**
 * A row turned into its own editor: a box for the name, for the serving and its
 * unit, and one in every nutrient column. Untracked nutrients sit at 0 and stay
 * editable like the rest — a 0 means "not tracked", and which ones those are is
 * often the thing being changed.
 */
function nutritionEditRow(row, cols) {
  const e = nutritionEdits;
  row.nameHtml = nameEditor({ name: e.name, data: 'data-edit="name"', aria: `Name of ${e.item.name}` });
  row.leadHtml = {
    size: `<input class="ntable-qty-input ntable-lead-input" type="number" min="0" step="any"
      value="${escapeHtml(e.size)}" data-edit="size" aria-label="Serving size" />`,
    unit: `<input class="ntable-qty-input ntable-lead-input" type="text"
      value="${escapeHtml(e.unit)}" data-edit="unit" aria-label="Serving unit" />`,
  };
  row.cellsHtml = cols
    .map((c) => `<td><input class="ntable-qty-input ntable-cell-input" type="number" min="0" step="any"
      value="${escapeHtml(e.values[c.key] ?? "")}" data-key="${c.key}"
      aria-label="${escapeHtml(c.label)}" /></td>`)
    .join("");
  return row;
}

const TARGET_ROLE_LABEL = { item: "daily targets", min: "daily minimums", max: "daily maximums" };
// The variant decides the row's colour: the target keeps the accent, the floor
// and the ceiling take a lighter and a darker shade of it.
const TARGET_ROLE_VARIANT = { item: "target", min: "target-min", max: "target-max" };

/**
 * One of the three daily rows, pinned under the headers. Edited like any other
 * row now that the table has an actions column, and from the same one — its
 * controls used to ride in the name cell because there was nowhere else to put
 * three rows' worth of them.
 *
 * No Delete: nothing else identifies these rows, so removing one doesn't lose a
 * food, it unpins the yardstick that every other tab reads its percentages
 * against. Editing the target reaches those tabs too, which is the point.
 */
function nutritionTargetsRow(cols, item, role) {
  const key = targetRowKey(role);
  const editing = nutritionEdits?.key === key;
  const label = TARGET_ROLE_LABEL[role];
  const row = {
    name: item.name,
    lead: { size: item.size, unit: item.unit },
    values: item.values,
    variant: TARGET_ROLE_VARIANT[role],
    // Only the row being edited shows boxes — the other two stay readable, which
    // is the point of having them side by side.
    actions: editing
      ? editRowActions(key)
      : iconAction("edit", "edit", `Edit ${label}`, `data-id="${key}"`),
  };
  return editing ? nutritionEditRow(row, cols) : row;
}

/** The raw.csv row playing one of the three roles, if it's still there. */
function nutritionTargetItem(role = "item") {
  const name = targetsRowNames[role];
  return name ? nutritionRows.find((it) => it.name.toLowerCase() === name.toLowerCase()) : undefined;
}

// ── The settings cog ──────────────────────────────────
// Both nutrient tables are several pinned rows deep before a single row of
// their own content shows — the daily max, target and min, and on the Food tab
// the compare row too. Whether each is worth the height depends on what you're
// doing in the table, so every one of them is a checkbox rather than a fixture,
// and `logColors` decides whether the row read against that band gets coloured
// for it. Five settings is more than a row of toggle buttons can carry on a
// phone, hence one cog opening a menu.
//
// One of these per table, each with its own stored settings. They pin the same
// rows off the same raw.csv, but they're looked at for different reasons — the
// Food tab to place a food in the range, the Logs tab to judge a logged day —
// and a shared setting made every visit to one a fight with the other.
//
// Defaults are everything on, which is how both tables read before the cog.
function createTableConfig({ el, btn, menu, storageKey, defaults, onChange }) {
  const state = { ...defaults };
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
    // Key by key rather than wholesale: a setting added later isn't in an older
    // saved object, and taking that object as-is would leave it undefined.
    for (const k of Object.keys(defaults)) {
      if (typeof saved[k] === "boolean") state[k] = saved[k];
    }
  } catch {}
  if (!el || !btn || !menu) return state;

  const inputs = [...menu.querySelectorAll("input[data-cfg]")];
  const setOpen = (open) => {
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
  };
  const paint = () => {
    for (const input of inputs) {
      input.checked = state[input.dataset.cfg];
      // Colouring a row that isn't pinned is a setting with nothing to act on,
      // so where the row itself can be hidden the colours grey out with it.
      if (input.dataset.cfg === "logColors" && "log" in state) input.disabled = !state.log;
    }
  };

  btn.addEventListener("click", (e) => {
    // Kept off the click-away listener below, which would otherwise close the
    // menu this click just opened.
    e.stopPropagation();
    setOpen(menu.hidden);
  });

  menu.addEventListener("change", (e) => {
    const input = e.target.closest("input[data-cfg]");
    if (!input) return;
    state[input.dataset.cfg] = input.checked;
    try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch {}
    paint();
    // Stays open: these are settings people flip two or three of at a time, and
    // a menu that shut on every one would have to be reopened between them.
    onChange();
  });

  // Click-away and Escape, the two ways out of an open menu. Clicks inside are
  // left alone so a label still toggles its box.
  document.addEventListener("click", (e) => {
    if (!menu.hidden && !e.target.closest(`#${el.id}`)) setOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || menu.hidden) return;
    setOpen(false);
    btn.focus();
  });

  paint();
  return state;
}

const nutritionConfigEl = document.getElementById("nutrition-config");
const nutritionConfig = createTableConfig({
  el: nutritionConfigEl,
  btn: document.getElementById("nutrition-config-btn"),
  menu: document.getElementById("nutrition-config-menu"),
  storageKey: "dash-nutrition-table-config",
  defaults: { max: true, target: true, min: true, log: true, logColors: true },
  onChange: () => renderTableKeepingScroll(nutritionContentEl, renderNutrition),
});

const logsConfigEl = document.getElementById("logs-config");
// No `log` key: the row it would hide is the day's own totals line, and its
// Item cell is the picker for which day the table is showing.
const logsConfig = createTableConfig({
  el: logsConfigEl,
  btn: document.getElementById("logs-config-btn"),
  menu: document.getElementById("logs-config-menu"),
  storageKey: "dash-logs-table-config",
  defaults: { max: true, target: true, min: true, logColors: true },
  onChange: () => renderLogsKeepingScroll(),
});

/** Edit / Save / Cancel / Delete on a row of the food table. */
async function handleNutritionRowAction(act, btn) {
  const key = btn.dataset.id || "";
  const item = nutritionRowFor(key);
  if (!item) return;
  if (act === "cancel-edits" || act === "edit") {
    // Opening a row drops whatever was staged against another: one row is
    // written at a time, so two half-edited ones can't both be waiting.
    if (act === "cancel-edits") nutritionEdits = null;
    else startNutritionEdit(key, item);
    renderTableKeepingScroll(nutritionContentEl, renderNutrition);
    return;
  }
  if (act === "delete") {
    await deleteNutritionRow(Number(key.split(":")[1]), item, btn);
    return;
  }
  await saveNutritionEdit(btn);
}

/**
 * How far a food's serving moved, as the factor every logged quantity has to be
 * multiplied by to still mean the amount it was logged as. Null when the
 * serving didn't move at all — a nutrient-only edit is a correction to the
 * food, and the days that ate it should feel it.
 *
 * Two ways to measure the move, because entries store a multiple of the serving
 * and nothing else:
 *   - Same unit: the sizes are directly comparable, so old ÷ new is exact.
 *   - Unit changed: oz and bags don't convert, but the nutrients do — if a bag
 *     carries twice the calories of the 8 oz it replaced, a bag is 16 oz. Only
 *     sound because the values are for the whole serving (see the CSV's rules).
 * `exact` says which of the two it was; `ruler` names the nutrient it matched
 * on, so the dialog can show its working.
 */
function foodRebaseFactor(item, next, nextValues) {
  const unitKey = (u) => String(u || "").trim().toLowerCase();
  const oldSize = parseFloat(item.size);
  const newSize = parseFloat(next["Serving Size"]);
  const sameUnit = unitKey(item.unit) === unitKey(next["Serving Unit"]);
  if (sameUnit) {
    // A size that isn't a positive number can't be scaled by on either side of
    // the edit — an entry against it counts plain servings (see servingSizeOf),
    // and it still does afterwards. Only two real sizes can move apart.
    if (!(oldSize > 0) || !(newSize > 0) || oldSize === newSize) return null;
    return { factor: oldSize / newSize, exact: true };
  }
  // Calories first — it's the figure the tables lead with, so a factor drawn
  // from it is the one that's checkable by eye. Any nutrient present on both
  // sides works as well; the first is only a preference.
  const cols = [...nutritionCols].sort((a, b) => Number(b.label.toLowerCase() === "calories") - Number(a.label.toLowerCase() === "calories"));
  for (const c of cols) {
    const before = Number(item.values[c.i]) || 0;
    const after = Number(nextValues[c.i]) || 0;
    if (before > 0 && after > 0) return { factor: before / after, exact: false, ruler: c.label };
  }
  return { factor: null };
}

/**
 * Ask before a serving redefinition silently re-points everything logged
 * against it. Returns the factor to send, or null to abandon the save.
 */
async function confirmFoodRebase(name, rebase) {
  let count = 0;
  try {
    const res = await fetch(`/api/nutrition/references?item=${encodeURIComponent(name)}`);
    count = (await res.json()).count || 0;
  } catch (err) {
    console.error(err);
  }
  if (!count) return 1; // nothing logged against it — nothing to keep steady
  const entries = `${count} logged ${count === 1 ? "entry" : "entries"}`;
  if (!rebase.factor) {
    return confirm(
      `${name} is used in ${entries}, and its serving has changed.\n\n` +
        `There's no nutrient in common between the old serving and the new one, so the amounts can't be converted.\n\n` +
        `OK saves the food and leaves those quantities as they are — check them yourself.\n` +
        `Cancel leaves everything alone.`,
    ) ? 1 : null;
  }
  const shown = Math.round(rebase.factor * 10000) / 10000;
  const how = rebase.exact ? "from the serving sizes" : `matched on ${rebase.ruler}`;
  return confirm(
    `${name} is used in ${entries}, and its serving has changed.\n\n` +
      `Adjusting keeps the amounts you logged: each quantity is multiplied by ${shown} (${how}).\n\n` +
      `OK adjusts them.\nCancel leaves the food unchanged.`,
  ) ? rebase.factor : null;
}

async function saveNutritionEdit(btn) {
  const edits = nutritionEdits;
  if (!edits) return;
  const item = edits.item;
  // Written whole: raw.csv holds one line per item, so there's no such thing as
  // updating part of a row. Whatever a box was left empty goes back as what the
  // row already had — a blank unit would strip "day" off a daily row.
  const food = {
    Item: edits.name.trim() || item.name,
    "Serving Size": edits.size || item.size || 1,
    "Serving Unit": edits.unit.trim() || item.unit,
  };
  // Foods take a 0 for anything left empty (Steve's rule for the CSV). The three
  // daily rows don't: an empty box there is "no figure for this nutrient", and
  // sending a 0 would turn every dash in the row into a target of zero.
  const keepBlanks = String(edits.key).startsWith("target:");
  const cell = (v) => (keepBlanks && String(v ?? "").trim() === "" ? "" : Number(v) || 0);
  const nextValues = Object.fromEntries(nutritionCols.map((c) => [c.i, cell(edits.values[c.i])]));
  for (const c of nutritionCols) food[c.raw] = nextValues[c.i];

  // Asked before anything is written, so Cancel really does leave the row alone.
  const rebase = foodRebaseFactor(item, food, nextValues);
  let rescale = 1;
  // A factor of 1 is a serving renamed rather than redefined — a bag that is
  // the 8 oz it replaced. Nothing to adjust, so nothing to ask about.
  if (rebase && rebase.factor !== 1) {
    setBtnBusy(btn, "Checking…");
    rescale = await confirmFoodRebase(item.name, rebase);
    if (rescale == null) {
      // Redrawn rather than left as it was: the button is still disabled, and
      // the row stays open on the edits that were staged.
      renderTableKeepingScroll(nutritionContentEl, renderNutrition);
      return;
    }
  }

  setBtnBusy(btn, "Saving…");
  try {
    const res = await fetch("/api/nutrition/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // `replaceItem` is the row on file. Under a new name the server has to be
      // told which row is being replaced, or it would write a second one — and
      // it moves any pointer at this row across with the rename, quantities
      // included when the serving was redefined.
      body: JSON.stringify({ food, replace: true, replaceItem: item.name, rescale }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    nutritionEdits = null;
    nutritionLoaded = false;
    await loadNutrition();
    // Groups and Meal Log resolve foods by name and read the target row as the
    // thing their percentages are of, so both have to fetch again — a changed
    // figure here changes every total built on it.
    invalidateNutritionBelow("foods");
  } catch (err) {
    setBtnBusy(btn, "Save failed", { failed: true });
    console.error(err);
  }
}

async function deleteNutritionRow(index, item, btn) {
  // The icon can't say "confirm" without the column changing width mid-click,
  // so the confirmation is a dialog — the same way a day is deleted.
  if (!confirm(`Delete the food ${item.name}? It goes out of raw.csv.`)) return;
  setBtnBusy(btn, "Deleting…");
  try {
    const res = await fetch("/api/nutrition/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The name is the guard: indices shift, and the server refuses a row whose
      // name isn't the one being deleted rather than taking out its neighbour.
      body: JSON.stringify({ index, item: item.name }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    // Row indices shift after a delete, so nothing keyed by one survives it.
    nutritionExpanded.clear();
    nutritionEdits = null;
    nutritionLoaded = false;
    await loadNutrition();
    invalidateNutritionBelow("foods");
  } catch (err) {
    setBtnBusy(btn, "Delete failed", { failed: true });
    console.error(err);
  }
}

// ── Food table: compare-against row ───────────────────
// A third pinned row whose "item" is a picker over every saved group and food
// log. Choosing one drops its totals into the row, so a composed group can
// be read against the targets above it and the raw foods below it.
// `group:<id>` / `log:<id>` — the two id spaces are separate.
let nutritionCompareId = "";
try { nutritionCompareId = localStorage.getItem("dash-nutrition-compare") || ""; } catch {}
// One shot only: loadLogs() clears its own flag on failure, so retrying off
// the back of a failed render would spin.
let compareDataRequested = false;

function ensureCompareDataLoaded() {
  if (logsLoaded || compareDataRequested) return;
  compareDataRequested = true;
  loadLogs().then(() => { if (nutritionView.isTable()) renderNutrition(); });
}

/** The chosen record, or null. Totals are keyed by header name, not index. */
function compareRecord() {
  const [kind, ...rest] = String(nutritionCompareId).split(":");
  const id = rest.join(":");
  if (!id) return null;
  const list = kind === "log" ? logsData.logs : logsData.groups;
  return (list || []).find((r) => r.id === id) || null;
}

/** Remap header-keyed totals onto the food table's index-keyed columns. */
function compareValues(cols, totals) {
  if (!totals) return null;
  const out = {};
  for (const c of cols) out[c.key] = totals[c.raw] || 0;
  return out;
}

/**
 * The daily floor and ceiling the compare row is judged against — the same pair
 * the Food Logs tab reads a log against, so a log picked here flags the
 * same nutrients it does over there. Read live rather than passed in: the three
 * daily rows are editable, and a save re-renders off these.
 */
function nutritionCompareBounds() {
  // Off from the cog means the row draws in plain numbers: a group is a part of
  // a day, so reading one against a whole day's bounds flags nearly every
  // column of it, which is noise unless a log is what's in the picker.
  if (!nutritionConfig.logColors) return null;
  const min = nutritionTargetItem("min")?.values;
  const max = nutritionTargetItem("max")?.values;
  return min || max ? { min, max } : null;
}

function nutritionCompareRow(cols) {
  const groups = [...(logsData.groups || [])].sort((a, b) => a.name.localeCompare(b.name));
  const logs = [...(logsData.logs || [])].sort((a, b) => a.name.localeCompare(b.name));
  const opt = (value, label) =>
    `<option value="${escapeHtml(value)}"${value === nutritionCompareId ? " selected" : ""}>${escapeHtml(label)}</option>`;
  const group = (label, items, kind) =>
    items.length ? `<optgroup label="${label}">${items.map((r) => opt(`${kind}:${r.id}`, r.name)).join("")}</optgroup>` : "";

  const what = SAVED_GROUPS_ENABLED ? "a meal or a log" : "a log";
  const select = `<select class="ntable-compare-select" aria-label="Compare ${what}">
      <option value="">${logsLoaded ? `Compare ${what}…` : "Loading…"}</option>
      ${SAVED_GROUPS_ENABLED ? group("Meals", groups, "group") : ""}
      ${group("Logs", logs, "log")}
    </select>`;
  return {
    nameHtml: select,
    values: compareValues(cols, compareRecord()?.totals),
    bounds: nutritionCompareBounds(),
    variant: "compare",
  };
}

// Refill in place rather than re-rendering: a full re-render would rebuild the
// <select> mid-interaction and drop focus.
nutritionContentEl?.addEventListener("change", (e) => {
  const sel = e.target.closest(".ntable-compare-select");
  if (!sel) return;
  nutritionCompareId = sel.value;
  try { localStorage.setItem("dash-nutrition-compare", nutritionCompareId); } catch {}
  const row = sel.closest("tr");
  const cols = nutritionCols.map((c) => ({ key: c.i, raw: c.raw, label: c.label, units: c.units }));
  // Everything the row draws from its values — but not the actions cell, which
  // sits ahead of the name and holds the row's place at the left edge.
  row.querySelectorAll("td:not(.ntable-actions)").forEach((td) => td.remove());
  row.querySelector(".ntable-name").insertAdjacentHTML(
    "afterend",
    // The empty Serving/Unit pair goes back with them: this row has nothing to
    // put there, but dropping the cells slides every nutrient two columns left
    // of the header it belongs under.
    LEAD_COLS.map(() => `<td class="ntable-lead"></td>`).join("") +
      renderNutrientCells(cols, compareValues(cols, compareRecord()?.totals), nutritionCompareBounds()),
  );
  syncPinnedTableRows(nutritionContentEl);
});

nutritionSearchEl?.addEventListener("input", () => {
  nutritionQuery = nutritionSearchEl.value;
  renderNutrition();
});
// Typed straight into the staged map. No repaint: the row's numbers aren't read
// from anywhere else while it's open, and re-rendering would take the caret out
// of the box mid-figure.
nutritionContentEl?.addEventListener("input", (e) => {
  if (!nutritionEdits) return;
  // The name, the serving and its unit carry what they are; a nutrient cell
  // carries which column it's in.
  const field = e.target.closest("[data-edit]");
  if (field) {
    nutritionEdits[field.dataset.edit] = e.target.value;
    return;
  }
  const cell = e.target.closest(".ntable-cell-input");
  if (cell) nutritionEdits.values[cell.dataset.key] = e.target.value;
});

// Enter commits the row, Escape drops it — the two things the keyboard should do
// in a box with Save and Cancel beside it.
nutritionContentEl?.addEventListener("keydown", (e) => {
  if (!nutritionEdits || (e.key !== "Enter" && e.key !== "Escape")) return;
  if (!e.target.closest(".ntable-name-input, .ntable-qty-input")) return;
  e.preventDefault();
  const act = e.key === "Enter" ? "save-edits" : "cancel-edits";
  nutritionContentEl.querySelector(`[data-act="${act}"]`)?.click();
});

nutritionContentEl?.addEventListener("click", async (e) => {
  const rowBtn = e.target.closest(
    '[data-act="edit"], [data-act="delete"], [data-act="save-edits"], [data-act="cancel-edits"]',
  );
  if (rowBtn) {
    await handleNutritionRowAction(rowBtn.dataset.act, rowBtn);
    return;
  }
  // Delete takes two clicks — the first arms it, the second commits.
  const del = e.target.closest('[data-act="delete-food"]');
  if (del) {
    const itemEl = del.closest(".nutrition-item");
    const i = Number(itemEl.dataset.index);
    const food = nutritionRows[i];
    const statusEl = itemEl.querySelector(".nutrition-delete-status");
    if (del.dataset.armed !== "1") {
      del.dataset.armed = "1";
      del.textContent = "Confirm delete";
      del.classList.add("armed");
      statusEl.textContent = `Remove “${food.name}” from raw.csv?`;
      return;
    }
    del.disabled = true;
    del.textContent = "Deleting…";
    try {
      const res = await fetch("/api/nutrition/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index: i, item: food.name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      // Row indices shift after a delete, so drop all expansion state.
      nutritionExpanded.clear();
      nutritionLoaded = false;
      await loadNutrition();
      // Groups resolve foods by name; a deleted food must show as missing, and
      // the logs built on those groups have to drop it from their totals too.
      invalidateNutritionBelow("foods");
    } catch (err) {
      del.disabled = false;
      del.dataset.armed = "";
      del.classList.remove("armed");
      del.textContent = "Delete food";
      statusEl.textContent = err.message;
    }
    return;
  }

  const row = e.target.closest(".nutrition-row");
  if (!row) return;
  const i = Number(row.closest(".nutrition-item").dataset.index);
  if (nutritionExpanded.has(i)) nutritionExpanded.delete(i);
  else nutritionExpanded.add(i);
  renderNutrition();
});

// ── Add a food ────────────────────────────────────────
// Text and/or photos go to the server, which researches the nutrients and
// proposes a row. Several photos describe ONE food — package front, nutrition
// panel, ingredients. Nothing is written until Steve confirms in the review card.
const nutritionAddBtn = document.getElementById("nutrition-add-btn");
const nutritionAddEl = document.getElementById("nutrition-add");
const nutritionAddTextEl = document.getElementById("nutrition-add-text");
const nutritionAddFileEl = document.getElementById("nutrition-add-file");
const nutritionPhotoNameEl = document.getElementById("nutrition-photo-name");
const nutritionPhotoClearEl = document.getElementById("nutrition-photo-clear");
const nutritionPhotoListEl = document.getElementById("nutrition-photo-list");
const nutritionLookupBtn = document.getElementById("nutrition-lookup-btn");
const nutritionAddStatusEl = document.getElementById("nutrition-add-status");
const nutritionReviewEl = document.getElementById("nutrition-review");

// Matches the server's MAX_LOOKUP_PHOTOS — more than this and the request body
// outgrows the endpoint's cap.
const NUTRITION_MAX_PHOTOS = 6;
// { name, data } per photo, in the order they were picked.
let nutritionPhotos = [];
let nutritionProposed = null;

// Phone photos are 5–10 MB; downscale before base64-ing them into the request.
function downscaleImage(file, maxDim = 1600) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read that file"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Could not decode that image"));
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// A lookup needs something to go on, so the button stays dead until there's a
// description or a photo — and stays dead while one is already running.
let nutritionLookupBusy = false;

function syncNutritionLookupBtn() {
  nutritionLookupBtn.disabled =
    nutritionLookupBusy || !(nutritionAddTextEl.value.trim() || nutritionPhotos.length);
}

function setNutritionAddBusy(busy, msg = "") {
  nutritionLookupBusy = busy;
  syncNutritionLookupBtn();
  nutritionLookupBtn.textContent = busy ? "Looking up…" : "Submit";
  nutritionAddStatusEl.textContent = msg;
  nutritionAddStatusEl.classList.toggle("error", !busy && Boolean(msg) && nutritionAddStatusEl.dataset.kind === "error");
}

// Thumbnails with a per-photo remove, plus a count so it's obvious how many
// went into the lookup.
function renderNutritionPhotos() {
  nutritionPhotoListEl.innerHTML = nutritionPhotos
    .map(
      (p, i) => `<div class="nutrition-photo-thumb">
        <img src="${escapeHtml(p.data)}" alt="${escapeHtml(p.name)}" />
        <button class="nutrition-photo-remove" type="button" data-index="${i}" title="Remove ${escapeHtml(p.name)}" aria-label="Remove ${escapeHtml(p.name)}">×</button>
      </div>`
    )
    .join("");
  nutritionPhotoListEl.hidden = nutritionPhotos.length === 0;
  nutritionPhotoNameEl.textContent = nutritionPhotos.length
    ? `${nutritionPhotos.length} photo${nutritionPhotos.length === 1 ? "" : "s"}`
    : "";
  nutritionPhotoClearEl.hidden = nutritionPhotos.length === 0;
  syncNutritionLookupBtn();
}

function clearNutritionPhoto() {
  nutritionPhotos = [];
  nutritionAddFileEl.value = "";
  renderNutritionPhotos();
}

function resetNutritionAdd() {
  nutritionAddTextEl.value = "";
  clearNutritionPhoto(); // also re-syncs the lookup button
  nutritionReviewEl.hidden = true;
  nutritionReviewEl.innerHTML = "";
  nutritionProposed = null;
  nutritionAddStatusEl.textContent = "";
}

// Set where the panel is built, below — the two panels in this header are one
// at a time, so each has to be able to close the other.
let nutritionAiPanel = null;

function setNutritionAddOpen(open) {
  nutritionAddEl.hidden = !open;
  nutritionAddBtn.classList.toggle("open", open);
  if (!open) return;
  nutritionAiPanel?.close();
  nutritionAddTextEl.focus();
}

nutritionAddBtn?.addEventListener("click", () => setNutritionAddOpen(nutritionAddEl.hidden));

nutritionAddTextEl?.addEventListener("input", syncNutritionLookupBtn);

// Picks append rather than replace, so a camera shot and a gallery pick can be
// combined — which means clearing the input each time, or re-picking the same
// file fires no `change` event.
nutritionAddFileEl?.addEventListener("change", async () => {
  const files = [...(nutritionAddFileEl.files || [])];
  nutritionAddFileEl.value = "";
  if (!files.length) return;
  const room = NUTRITION_MAX_PHOTOS - nutritionPhotos.length;
  if (room <= 0) {
    nutritionAddStatusEl.dataset.kind = "error";
    setNutritionAddBusy(false, `Up to ${NUTRITION_MAX_PHOTOS} photos.`);
    return;
  }
  try {
    for (const file of files.slice(0, room)) {
      nutritionPhotos.push({ name: file.name, data: await downscaleImage(file) });
    }
    nutritionAddStatusEl.dataset.kind = "";
    setNutritionAddBusy(false, files.length > room ? `Only the first ${room} were added — max ${NUTRITION_MAX_PHOTOS} photos.` : "");
  } catch (err) {
    nutritionAddStatusEl.dataset.kind = "error";
    setNutritionAddBusy(false, err.message);
  }
  renderNutritionPhotos();
});

nutritionPhotoClearEl?.addEventListener("click", clearNutritionPhoto);

nutritionPhotoListEl?.addEventListener("click", (e) => {
  const btn = e.target.closest(".nutrition-photo-remove");
  if (!btn) return;
  nutritionPhotos.splice(Number(btn.dataset.index), 1);
  renderNutritionPhotos();
});

function renderNutritionReview({ record, header, duplicate, sources, notes }) {
  // Headers carry their units — "Carbs (g)", not "carbs" — so match on the
  // label part, the same way the food table does.
  const colFor = (name) =>
    header.find((h) => splitMetricLabel(h.trim()).label.toLowerCase() === name.toLowerCase());
  const val = (name) => record[colFor(name)?.trim()] ?? "0";
  const serving = [val("serving size"), val("serving unit")].filter(Boolean).join(" ");
  const macro = (label, name, units) =>
    `<span class="nutrition-stat"><span class="nutrition-stat-label">${label}</span>${escapeHtml(val(name))}<span class="nutrition-stat-units">${units}</span></span>`;

  const identity = ["item", "serving size", "serving unit", "servings"];
  const nutrientCols = header.filter((h) => !identity.includes(h.trim().toLowerCase()));
  const nonZero = nutrientCols.filter((h) => parseFloat(record[h.trim()]) > 0).length;

  // Full breakdown, grouped like the food table — so the lookup can be used
  // just to look, without adding anything.
  const groups = new Map();
  for (const col of nutrientCols) {
    const { label, units } = splitMetricLabel(col.trim());
    const g = nutritionGroupOf(label);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push({ col, label, units });
  }
  const detail = NUTRITION_GROUP_ORDER.filter((g) => groups.has(g))
    .map((g) => {
      const cells = groups
        .get(g)
        .map(({ col, label, units }) => {
          const v = parseFloat(record[col.trim()]) || 0;
          return `<div class="nutrition-cell${v === 0 ? " is-zero" : ""}">
            <span class="nutrition-cell-label" title="${escapeHtml(col.trim())}">${escapeHtml(label)}</span>
            <span class="nutrition-cell-value">${fmtNutrient(v)}${units ? `<span class="nutrition-cell-units">${escapeHtml(units)}</span>` : ""}</span>
          </div>`;
        })
        .join("");
      return `<div class="nutrition-group"><h4 class="nutrition-group-title">${escapeHtml(g)}</h4><div class="nutrition-grid">${cells}</div></div>`;
    })
    .join("");

  return `
    <div class="nutrition-review-head">
      <div>
        <div class="nutrition-review-name">${escapeHtml(val("item"))}</div>
        <div class="nutrition-review-serving">${escapeHtml(serving)} · 1 serving · ${nonZero} of ${nutrientCols.length} nutrients found</div>
      </div>
      <div class="nutrition-review-cal">${escapeHtml(val("calories"))}<span class="nutrition-cal-units">cal</span></div>
    </div>
    <div class="nutrition-stats nutrition-review-stats">
      ${macro("C", "carbs", "g")}${macro("P", "protein", "g")}${macro("F", "fat", "g")}
      ${macro("Fiber", "fiber", "g")}${macro("Sodium", "sodium", "mg")}
    </div>
    ${notes ? `<div class="nutrition-review-notes">${escapeHtml(notes)}</div>` : ""}
    ${sources.length ? `<div class="nutrition-review-sources">Sources: ${escapeHtml(sources.join(" · "))}</div>` : ""}
    <div class="nutrition-detail nutrition-review-detail">${detail}</div>
    ${duplicate ? `<div class="nutrition-review-dupe">“${escapeHtml(duplicate)}” is already in the table. Adding will create a second row unless you replace it.</div>` : ""}
    <div class="nutrition-review-actions">
      <button class="nutrition-save-btn" id="nutrition-save-btn" type="button">Add to CSV</button>
      ${duplicate ? `<button class="nutrition-replace-btn" id="nutrition-replace-btn" type="button">Replace existing</button>` : ""}
      <button class="nutrition-cancel-btn" id="nutrition-cancel-btn" type="button">Discard</button>
      <span class="nutrition-add-status" id="nutrition-save-status"></span>
    </div>`;
}

async function commitNutritionFood(replace) {
  const statusEl = document.getElementById("nutrition-save-status");
  const saveBtn = document.getElementById("nutrition-save-btn");
  const replaceBtn = document.getElementById("nutrition-replace-btn");
  if (saveBtn) saveBtn.disabled = true;
  if (replaceBtn) replaceBtn.disabled = true;
  if (statusEl) statusEl.textContent = "Saving…";
  try {
    const res = await fetch("/api/nutrition/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ food: nutritionProposed.record, replace }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    resetNutritionAdd();
    nutritionAddStatusEl.dataset.kind = "ok";
    nutritionAddStatusEl.textContent = `Added ${data.item}.`;
    // Re-read the CSV so the new food shows up in the list immediately.
    nutritionLoaded = false;
    await loadNutrition();
    // A replace changes values groups and logs already summed.
    invalidateNutritionBelow("foods");
  } catch (err) {
    if (saveBtn) saveBtn.disabled = false;
    if (replaceBtn) replaceBtn.disabled = false;
    if (statusEl) statusEl.textContent = err.message;
  }
}

nutritionReviewEl?.addEventListener("click", (e) => {
  if (e.target.id === "nutrition-save-btn") commitNutritionFood(false);
  else if (e.target.id === "nutrition-replace-btn") commitNutritionFood(true);
  else if (e.target.id === "nutrition-cancel-btn") resetNutritionAdd();
});

nutritionLookupBtn?.addEventListener("click", async () => {
  const text = nutritionAddTextEl.value.trim();
  nutritionReviewEl.hidden = true;
  nutritionAddStatusEl.dataset.kind = "";
  setNutritionAddBusy(true, "Checking multiple sources — this can take a minute.");
  try {
    const res = await fetch("/api/nutrition/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, images: nutritionPhotos.map((p) => p.data) }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    nutritionProposed = data;
    nutritionReviewEl.innerHTML = renderNutritionReview(data);
    nutritionReviewEl.hidden = false;
    setNutritionAddBusy(false, "");
  } catch (err) {
    nutritionAddStatusEl.dataset.kind = "error";
    setNutritionAddBusy(false, err.message);
  }
});

// ── AI helper panels ──────────────────────────────────
// The Food and Meal Log tabs each carry one beside their add button. Both are
// the same thing — a textarea, up to NUTRITION_MAX_PHOTOS photos, one submit,
// and a result area — over a different endpoint; only what comes back and what
// it means to apply it differ, so those are the caller's.
//
// Neither writes anything on its own: an answer may carry proposals, and a
// proposal is written only when its Apply is pressed.
//
// The elements are found by convention from `prefix`: `<prefix>` is the panel,
// `<prefix>-btn` the header toggle, then -text, -file, -photo-name,
// -photo-clear, -photo-list, -submit, -cancel, -clear, -status and -result.
//
// A run can take minutes, so it's cancellable: aborting the fetch closes the
// socket, and the server kills the model process off the back of that.
//
// @param {object}   opts
// @param {string}   opts.prefix    Id prefix shared by the panel's elements.
// @param {string}   opts.endpoint  Where the question is posted.
// @param {string}   opts.busyText  Shown while the model is working.
// @param {Function} [opts.body]    () => extra fields for the request.
// @param {Function} opts.render    (data) => HTML for the result area.
// @param {Function} [opts.onData]  (data) => void, before the render.
// @param {Function} [opts.onRendered] (resultEl) => void, after the render — for
//                                  result markup that needs wiring up.
// @param {Function} [opts.onApply] (event, resultEl) => void, clicks in the result.
// @param {Function} [opts.onOpen]  () => void as the panel opens — where the tab
//                                  closes whatever else it has open.
function createAiPanel({ prefix, endpoint, busyText, body = () => ({}), render, onData, onRendered, onApply, onOpen }) {
  const el = (suffix) => document.getElementById(`${prefix}-${suffix}`);
  const panelEl = document.getElementById(prefix);
  const btnEl = el("btn");
  const textEl = el("text");
  const fileEl = el("file");
  const photoNameEl = el("photo-name");
  const photoClearEl = el("photo-clear");
  const photoListEl = el("photo-list");
  const submitEl = el("submit");
  const cancelEl = el("cancel");
  const clearEl = el("clear");
  const statusEl = el("status");
  const resultEl = el("result");
  if (!panelEl || !btnEl) return null;

  let photos = [];
  let busy = false;
  let inFlight = null; // AbortController for the run on the wire

  const syncSubmit = () => {
    submitEl.disabled = busy || !(textEl.value.trim() || photos.length);
    cancelEl.hidden = !busy;
    // Clear is for putting the panel back to empty — pointless when it already is.
    clearEl.hidden = busy || !(textEl.value.trim() || photos.length || !resultEl.hidden);
  };
  const setBusy = (isBusy, msg = "") => {
    busy = isBusy;
    syncSubmit();
    submitEl.textContent = isBusy ? "Thinking…" : "Submit";
    statusEl.textContent = msg;
  };
  const renderPhotos = () => {
    photoListEl.innerHTML = photos
      .map(
        (p, i) => `<div class="nutrition-photo-thumb">
          <img src="${escapeHtml(p.data)}" alt="${escapeHtml(p.name)}" />
          <button class="nutrition-photo-remove" type="button" data-index="${i}" title="Remove ${escapeHtml(p.name)}" aria-label="Remove ${escapeHtml(p.name)}">×</button>
        </div>`
      )
      .join("");
    photoListEl.hidden = photos.length === 0;
    photoNameEl.textContent = photos.length ? `${photos.length} photo${photos.length === 1 ? "" : "s"}` : "";
    photoClearEl.hidden = photos.length === 0;
    syncSubmit();
  };

  // Collapsing keeps the question, the photos and the answer — reopening picks
  // up where it left off, and a run in flight keeps running.
  const setOpen = (open) => {
    panelEl.hidden = !open;
    btnEl.classList.toggle("open", open);
    if (!open) return;
    onOpen?.();
    textEl.focus();
  };

  btnEl.addEventListener("click", () => setOpen(panelEl.hidden));

  textEl.addEventListener("input", syncSubmit);

  // Picks append rather than replace, same as the Add food panel — so a camera
  // shot and a gallery pick can be combined.
  fileEl.addEventListener("change", async () => {
    const files = [...(fileEl.files || [])];
    fileEl.value = "";
    if (!files.length) return;
    const room = NUTRITION_MAX_PHOTOS - photos.length;
    if (room <= 0) {
      statusEl.dataset.kind = "error";
      setBusy(false, `Up to ${NUTRITION_MAX_PHOTOS} photos.`);
      return;
    }
    try {
      for (const file of files.slice(0, room)) {
        photos.push({ name: file.name, data: await downscaleImage(file) });
      }
      statusEl.dataset.kind = "";
      setBusy(false, files.length > room ? `Only the first ${room} were added — max ${NUTRITION_MAX_PHOTOS} photos.` : "");
    } catch (err) {
      statusEl.dataset.kind = "error";
      setBusy(false, err.message);
    }
    renderPhotos();
  });

  photoClearEl.addEventListener("click", () => {
    photos = [];
    fileEl.value = "";
    renderPhotos();
  });

  photoListEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".nutrition-photo-remove");
    if (!btn) return;
    photos.splice(Number(btn.dataset.index), 1);
    renderPhotos();
  });

  if (onApply) resultEl.addEventListener("click", (e) => onApply(e, resultEl));

  // Aborting the fetch is what the server watches for, so this cancels the run
  // itself rather than just stopping waiting for it.
  cancelEl.addEventListener("click", () => {
    inFlight?.abort();
  });

  // Back to an empty panel — question, photos and answer together. The question
  // that produced an answer is usually the thing in the way of the next one.
  // `focus` is for the Clear button: applying a proposal clears the panel too,
  // and pulling the caret into it there would yank the page back up.
  const clear = ({ focus = false } = {}) => {
    textEl.value = "";
    photos = [];
    fileEl.value = "";
    resultEl.innerHTML = "";
    resultEl.hidden = true;
    statusEl.dataset.kind = "";
    statusEl.textContent = "";
    onData?.(null);
    renderPhotos();
    if (focus) textEl.focus();
  };

  clearEl.addEventListener("click", () => clear({ focus: true }));

  submitEl.addEventListener("click", async () => {
    resultEl.hidden = true;
    statusEl.dataset.kind = "";
    const controller = new AbortController();
    inFlight = controller;
    setBusy(true, busyText);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: textEl.value.trim(), images: photos.map((p) => p.data), ...body() }),
        signal: controller.signal,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      onData?.(data);
      resultEl.innerHTML = render(data);
      resultEl.hidden = false;
      onRendered?.(resultEl);
      setBusy(false, "");
    } catch (err) {
      const cancelled = err.name === "AbortError";
      statusEl.dataset.kind = cancelled ? "" : "error";
      setBusy(false, cancelled ? "Cancelled." : err.message);
    } finally {
      inFlight = null;
      syncSubmit();
    }
  });

  syncSubmit();
  return { panelEl, resultEl, statusEl, clear, close: () => setOpen(false) };
}

// Applying is the end of a helper's run, so the panel empties itself once
// there's nothing left to apply — the question and the answer that produced it
// are only in the way of the next one. A panel that proposed several things
// stays put until the last of them is in: clearing on the first Apply would
// take the others with it. Left on screen long enough to read the "Saved".
const AI_APPLIED_LINGER_MS = 900;

function clearAiPanelWhenAllApplied(panel, resultEl) {
  if (!panel) return;
  const cards = resultEl.querySelectorAll(".nutrition-diff");
  if (![...cards].every((c) => c.classList.contains("is-applied"))) return;
  setTimeout(() => {
    // A new run during the wait replaces the result with un-applied cards, and
    // that answer is not the one this apply finished — leave it alone.
    if (resultEl.querySelector(".is-applied")) panel.clear();
  }, AI_APPLIED_LINGER_MS);
}

// ── Food tab helper ───────────────────────────────────
// Open-ended questions about the table — what's low, where a nutrient comes
// from — and, when asked for a change, proposed rows. The daily target/min/max
// rows are the usual subject.
let nutritionAiProposals = [];

const NUTRITION_AI_ROLE_LABEL = { item: "daily target row", min: "daily minimum row", max: "daily maximum row" };

// A proposal is a whole row, but showing all 50 columns buries what moved — so
// an existing row shows only what changed, old → new, and a new row shows what
// it would carry.
function renderNutritionAiProposal(p, i) {
  const identity = ["item", "serving size", "serving unit", "servings"];
  const cells = p.changes
    .filter((c) => p.exists || identity.includes(c.col.toLowerCase()) || parseFloat(c.to) !== 0)
    .map((c) => {
      const { label, units } = splitMetricLabel(c.col);
      return `<div class="nutrition-diff-cell">
        <span class="nutrition-diff-label" title="${escapeHtml(c.col)}">${escapeHtml(label)}</span>
        <span class="nutrition-diff-values">
          ${p.exists ? `<span class="nutrition-diff-from">${escapeHtml(String(c.from ?? ""))}</span><span class="nutrition-diff-arrow">→</span>` : ""}
          <span class="nutrition-diff-to">${escapeHtml(c.to)}${units ? `<span class="nutrition-cell-units">${escapeHtml(units)}</span>` : ""}</span>
        </span>
      </div>`;
    })
    .join("");

  const badge = p.role
    ? `<span class="nutrition-diff-badge">${escapeHtml(NUTRITION_AI_ROLE_LABEL[p.role] || p.role)}</span>`
    : p.exists
      ? ""
      : `<span class="nutrition-diff-badge is-new">new row</span>`;

  return `<div class="nutrition-diff" data-index="${i}">
    <div class="nutrition-diff-head">
      <span class="nutrition-diff-name">${escapeHtml(p.item)}</span>
      ${badge}
      <span class="nutrition-diff-count">${p.exists ? `${p.changes.length} change${p.changes.length === 1 ? "" : "s"}` : "would be added"}</span>
    </div>
    ${p.reason ? `<div class="nutrition-diff-reason">${escapeHtml(p.reason)}</div>` : ""}
    <div class="nutrition-diff-grid">${cells}</div>
    <div class="nutrition-review-actions">
      <button class="nutrition-save-btn nutrition-diff-apply" type="button" data-index="${i}">${p.exists ? "Apply to CSV" : "Add to CSV"}</button>
      <span class="nutrition-add-status" data-status="${i}"></span>
    </div>
  </div>`;
}

function renderNutritionAiResult({ answer, sources, proposals }) {
  const body = answer
    ? window.marked
      ? window.marked.parse(answer)
      : `<pre>${escapeHtml(answer)}</pre>`
    : `<p class="muted">No answer came back.</p>`;
  return `
    <div class="nutrition-ai-answer">${body}</div>
    ${sources.length ? `<div class="nutrition-review-sources">Sources: ${escapeHtml(sources.join(" · "))}</div>` : ""}
    ${proposals.length ? `<div class="nutrition-ai-proposals">
      <h4 class="nutrition-ai-proposals-title">Proposed changes — nothing is written until you apply</h4>
      ${proposals.map(renderNutritionAiProposal).join("")}
    </div>` : ""}`;
}

// Proposals go through the same commit endpoint as a reviewed food, so an
// applied row is normalized — and a target-row rename moves its pointer —
// exactly as it would from the Add food panel.
async function applyNutritionAiProposal(index, resultEl) {
  const p = nutritionAiProposals[index];
  if (!p) return;
  const card = resultEl.querySelector(`.nutrition-diff[data-index="${index}"]`);
  const btn = card?.querySelector(".nutrition-diff-apply");
  const statusEl = card?.querySelector(`[data-status="${index}"]`);
  if (btn) btn.disabled = true;
  if (statusEl) statusEl.textContent = "Saving…";
  try {
    const res = await fetch("/api/nutrition/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ food: p.record, replace: p.exists, replaceItem: p.replaceItem }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (statusEl) statusEl.textContent = `Saved ${data.item}.`;
    if (btn) btn.textContent = "Applied";
    card?.classList.add("is-applied");
    clearAiPanelWhenAllApplied(nutritionAiPanel, resultEl);
    nutritionLoaded = false;
    await loadNutrition();
    // Targets and food values both feed the groups and logs below.
    invalidateNutritionBelow("foods");
  } catch (err) {
    if (btn) btn.disabled = false;
    if (statusEl) statusEl.textContent = err.message;
  }
}

nutritionAiPanel = createAiPanel({
  prefix: "nutrition-ai",
  endpoint: "/api/nutrition/assist",
  busyText: "Working through the table — this can take a minute or two.",
  onOpen: () => setNutritionAddOpen(false),
  onData: (data) => {
    nutritionAiProposals = Array.isArray(data?.proposals) ? data.proposals : [];
  },
  render: (data) =>
    renderNutritionAiResult({
      answer: data.answer || "",
      sources: Array.isArray(data.sources) ? data.sources : [],
      proposals: nutritionAiProposals,
    }),
  onApply: (e, resultEl) => {
    const btn = e.target.closest(".nutrition-diff-apply");
    if (btn) applyNutritionAiProposal(Number(btn.dataset.index), resultEl);
  },
});

// ── Library helper ────────────────────────────────────
// The same helper again, over whatever the Library has open — the file is
// named to the server by path, not posted, so the model reads what's on disk.
// A text file can come back rewritten; an image or a PDF can only be asked
// about. With nothing open it answers from the file list.
//
// The question and its answer outlive the selection — you can open something
// else while a run is in flight — so the file a proposal belongs to is pinned
// at the moment it's asked, and that's the file Apply writes.
let libraryAiProposal = null;
let libraryAiProposalPath = "";
let libraryAiAskedPath = "";

function renderLibraryAiResult(answer) {
  const body = answer
    ? window.marked
      ? window.marked.parse(answer)
      : `<pre>${escapeHtml(answer)}</pre>`
    : `<p class="muted">No answer came back.</p>`;
  return `
    <div class="nutrition-ai-answer">${body}</div>
    ${libraryAiProposal == null ? "" : `<div class="nutrition-ai-proposals">
      <h4 class="nutrition-ai-proposals-title">Proposed ${escapeHtml(libraryAiProposalPath)} — nothing is saved until you apply it</h4>
      <div class="nutrition-diff doc-proposal">
        <textarea class="doc-proposal-text" rows="1"></textarea>
        <div class="nutrition-review-actions">
          <button class="nutrition-save-btn doc-proposal-apply" type="button">Save file</button>
          <span class="nutrition-add-status" data-status="doc"></span>
        </div>
      </div>
    </div>`}`;
}

async function applyLibraryAiProposal(resultEl) {
  const card = resultEl.querySelector(".doc-proposal");
  if (!card) return;
  const btn = card.querySelector(".doc-proposal-apply");
  const statusEl = card.querySelector('[data-status="doc"]');
  const path = libraryAiProposalPath;
  const content = card.querySelector(".doc-proposal-text").value;
  btn.disabled = true;
  statusEl.textContent = "Saving…";
  try {
    await saveLibraryFile(path, content);
    // The watcher pushes the new text back for the open file, but only if it's
    // still the one on screen — redraw here so applying is never a no-op look.
    if (path === currentLibraryPath && !isLibraryEditing()) renderLibraryContent(path, content);
    statusEl.textContent = "Saved.";
    btn.textContent = "Saved";
    card.classList.add("is-applied");
    clearAiPanelWhenAllApplied(libraryAiPanel, resultEl);
  } catch (err) {
    btn.disabled = false;
    statusEl.textContent = err.message;
  }
}

const libraryAiPanel = createAiPanel({
  prefix: "library-ai",
  endpoint: "/api/library/assist",
  busyText: "Reading the notebook — this can take a minute.",
  body: () => {
    libraryAiAskedPath = currentLibraryPath || "";
    return { path: libraryAiAskedPath };
  },
  onData: (data) => {
    const proposed = data?.content;
    libraryAiProposal = typeof proposed === "string" ? proposed : null;
    libraryAiProposalPath = libraryAiAskedPath;
  },
  render: (data) => renderLibraryAiResult(data.answer || ""),
  onRendered: (resultEl) => {
    const ta = resultEl.querySelector(".doc-proposal-text");
    if (!ta) return;
    // Set as text, never as markup, and grown to fit like the note editor.
    ta.value = libraryAiProposal || "";
    autoGrowTextarea(ta);
  },
  onApply: (e, resultEl) => {
    if (e.target.closest(".doc-proposal-apply")) applyLibraryAiProposal(resultEl);
  },
});

async function loadNutrition() {
  if (nutritionLoaded) return;
  nutritionLoaded = true;
  try {
    const res = await fetch("/api/nutrition", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Which rows are the target, min and max — they can be renamed, so the
    // server is the one that knows. Older responses don't carry them; the
    // defaults still hold.
    for (const [role, header] of [["item", "X-Targets-Item"], ["min", "X-Targets-Min"], ["max", "X-Targets-Max"]]) {
      const named = res.headers.get(header);
      if (named) targetsRowNames[role] = decodeURIComponent(named);
    }
    const { cols, items } = parseNutritionCsv(await res.text());
    if (items.length === 0) {
      nutritionContentEl.innerHTML = `<div class="empty">No foods in nutrition/raw.csv.</div>`;
      return;
    }
    nutritionCols = cols;
    nutritionRows = items;
    renderNutrition();
  } catch (err) {
    nutritionLoaded = false;
    nutritionContentEl.innerHTML = `<div class="empty">Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}

// ── Groups ─────────────────────────────────────────────
// A group is a named list of foods from the nutrition CSV, each with a quantity.
// Only name + qty are persisted (in nutrition/groups.json); the server recomputes
// totals from the CSV, so fixing a food's data fixes every group that uses it.
let groupsLoaded = false;
let groupsData = { groups: [], foods: [], nutrientCols: [] };
let groupDraft = null; // { id, name, items: [{ item, qty }] }
const groupsExpanded = new Set();

const groupsContentEl = document.getElementById("groups-content");
const groupsCountEl = document.getElementById("groups-count");
const groupNewBtn = document.getElementById("group-new-btn");
const groupBuilderEl = document.getElementById("group-builder");
const groupNameEl = document.getElementById("group-name");
const groupFoodSearchEl = document.getElementById("group-food-search");
const groupFoodResultsEl = document.getElementById("group-food-results");
const groupItemsEl = document.getElementById("group-items");
const groupTotalsEl = document.getElementById("group-totals");
const groupSaveBtn = document.getElementById("group-save-btn");
const groupCancelBtn = document.getElementById("group-cancel-btn");
const groupStatusEl = document.getElementById("group-status");

/**
 * Autocomplete dropdown for the group/log builders.
 *
 * Opens on focus with the full list (not just after typing), filters as you
 * type, and supports ↑/↓ to move, Enter to pick, Escape to dismiss. Selection
 * is keyed by a stable value so callers never parse rendered markup.
 *
 * @param {object} opts
 * @param {HTMLInputElement} opts.input
 * @param {HTMLElement}      opts.list       Container for the options.
 * @param {Function}         opts.getItems   (query) => item[]
 * @param {Function}         opts.valueOf    (item) => string  — passed back on select.
 * @param {Function}         opts.renderItem (item) => inner HTML for one option.
 * @param {Function}         opts.onSelect   (value) => void
 * @param {string}           [opts.emptyText]
 */
function createCombobox({ input, list, getItems, valueOf, renderItem, onSelect, emptyText = "No matches." }) {
  if (!input || !list) return { close() {}, refresh() {} };
  let items = [];
  let active = -1;
  let open = false;

  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-autocomplete", "list");
  list.setAttribute("role", "listbox");

  function paint() {
    list.innerHTML = items.length
      ? items
          .map(
            (it, i) =>
              `<button class="group-food-result${i === active ? " is-active" : ""}" role="option" aria-selected="${i === active}" data-value="${escapeHtml(valueOf(it))}" type="button">${renderItem(it)}</button>`
          )
          .join("")
      : `<div class="group-empty-hint">${escapeHtml(emptyText)}</div>`;
    if (active >= 0) list.children[active]?.scrollIntoView({ block: "nearest" });
  }

  function show(query) {
    items = getItems(query) || [];
    active = -1;
    open = true;
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    paint();
  }

  function close() {
    open = false;
    active = -1;
    list.hidden = true;
    list.innerHTML = "";
    input.setAttribute("aria-expanded", "false");
  }

  function move(delta) {
    if (!open) { show(input.value); return; }
    if (items.length === 0) return;
    active = (active + delta + items.length) % items.length;
    paint();
  }

  function choose(i) {
    const it = items[i];
    if (!it) return;
    onSelect(valueOf(it));
  }

  input.addEventListener("focus", () => show(input.value));
  input.addEventListener("input", () => show(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Enter") {
      if (!open || items.length === 0) return;
      e.preventDefault();
      choose(active >= 0 ? active : 0);
    } else if (e.key === "Escape") { close(); }
  });

  // mousedown fires before blur, so pick here rather than on click — otherwise
  // the blur handler closes the list out from under the click.
  list.addEventListener("mousedown", (e) => {
    const btn = e.target.closest(".group-food-result");
    if (!btn) return;
    e.preventDefault();
    onSelect(btn.dataset.value);
  });
  list.addEventListener("mousemove", (e) => {
    const btn = e.target.closest(".group-food-result");
    if (!btn) return;
    const i = [...list.children].indexOf(btn);
    if (i !== active) { active = i; paint(); }
  });

  input.addEventListener("blur", () => { setTimeout(close, 0); });

  close(); // don't rely on the markup shipping with `hidden`
  return { close, refresh: () => { if (open) show(input.value); } };
}

/**
 * Nutrition data cascades: foods → groups → logs, with totals recomputed at
 * every level. Editing something upstream therefore stales everything below
 * it, so each tab drops its cache and refetches the next time you land on it
 * (setTab's `!xLoaded` guards) — or right now, if you're already looking at it.
 */
function invalidateNutritionBelow(level) {
  if (level === "foods") groupsLoaded = false;
  logsLoaded = false;
  // The Food tab's compare row draws on the same data — let it refetch.
  compareDataRequested = false;
  // Refresh whichever tab is on screen right now; the rest reload on arrival.
  if (currentTab === "groups" && !groupsLoaded) loadGroups();
  if (currentTab === "food-logs") loadLogs();
}

const GROUP_SUMMARY_COLS = [
  ["Calories", ""], ["Carbs (g)", "g"], ["Protein (g)", "g"], ["Fat (g)", "g"],
  ["Fiber (g)", "g"], ["Sodium (mg)", "mg"],
];

function groupFoodByName(name) {
  return groupsData.foods.find((f) => f.name.toLowerCase() === String(name).toLowerCase());
}

/** Live totals for the draft, computed client-side so the builder updates instantly. */
function draftTotals() {
  const totals = {};
  for (const c of groupsData.nutrientCols) totals[c] = 0;
  for (const it of groupDraft?.items || []) {
    const food = groupFoodByName(it.item);
    if (!food) continue;
    for (const c of groupsData.nutrientCols) totals[c] += (food.values[c] || 0) * (it.qty || 1);
  }
  return totals;
}

function renderGroupMacroBar(totals) {
  const energy = {
    carbs: (totals["Carbs (g)"] || 0) * 4,
    protein: (totals["Protein (g)"] || 0) * 4,
    fat: (totals["Fat (g)"] || 0) * 9,
  };
  const sum = energy.carbs + energy.protein + energy.fat;
  if (sum <= 0) return `<div class="nutrition-bar nutrition-bar-empty"></div>`;
  const segs = ["carbs", "protein", "fat"]
    .filter((k) => energy[k] > 0)
    .map((k) => {
      const pct = (energy[k] / sum) * 100;
      const label = k[0].toUpperCase() + k.slice(1);
      const tip = `${label}: ${Math.round(energy[k])} cal · ${Math.round(pct)}%`;
      return `<div class="nutrition-seg" data-macro="${k}" style="flex:${pct.toFixed(3)}" title="${escapeHtml(tip)}"></div>`;
    })
    .join("");
  return `<div class="nutrition-bar">${segs}</div>`;
}

// ── Daily targets ──
// The targets are a row in raw.csv (see TARGETS_ITEM in src/nutrition.js), so
// editing them in Excel is all it takes to change what the Log tab compares
// against. Most are floors — hit them or you're short. These few are ceilings,
// where coming in under is the win, so they get scored the other way around.
const NUTRIENT_LIMITS = new Set([
  "Sodium (mg)", "Sugar (g)", "Added Sugar (g)", "Fructose (g)", "Saturated Fat (g)",
  "Trans Fat (g)", "Cholesterol (mg)", "Caffeine (mg)",
]);

// How near a target still counts as hitting it. A day is planned from serving
// sizes, not weighed out, so neither edge is a hard line — 2415mg of sodium
// against 2300 isn't a day worth marking, and neither is 81% of the iodine.
//
// The two aren't the same distance out on purpose. A floor is a figure to get
// near, and most of these are micronutrients where the target is itself a round
// guess; a ceiling is a line not to cross, so it's held closer.
const TARGET_UNDER_OK = 75;  // floors: this share of the target is enough
const TARGET_OVER_OK = 110;  // ceilings: this far past it is still fine

/**
 * Score one nutrient against its target. Returns null when there's no usable
 * target (a 0 in the targets row means "not tracked", not "must be zero").
 */
function targetProgress(col, value, target) {
  if (!Number.isFinite(target) || target <= 0) return null;
  const pct = (value / target) * 100;
  const isLimit = NUTRIENT_LIMITS.has(col);
  const state = isLimit
    ? (pct <= TARGET_OVER_OK ? "met" : "over")
    : pct < TARGET_UNDER_OK ? "under" : "met";
  return { pct, state, isLimit, target };
}

/**
 * Grouped grid of every nutrient in a totals object — shared by groups and
 * logs. When `targets` is passed (logs), each cell also shows its share of
 * the daily target.
 */
function renderTotalsDetail(totals, nutrientCols, targets = null) {
  const groups = new Map();
  for (const col of nutrientCols) {
    const { label, units } = splitMetricLabel(col);
    const g = nutritionGroupOf(label);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push({ col, label, units });
  }
  const blocks = NUTRITION_GROUP_ORDER.filter((g) => groups.has(g)).map((g) => {
    const cells = groups
      .get(g)
      .map(({ col, label, units }) => {
        const v = totals[col] || 0;
        const p = targets ? targetProgress(col, v, targets.values[col]) : null;
        const goal = p
          ? `<span class="nutrition-cell-goal" data-state="${p.state}">
               <span class="nutrition-cell-bar"><span style="width:${Math.min(100, Math.max(0, p.pct)).toFixed(1)}%"></span></span>
               <span class="nutrition-cell-pct">${Math.round(p.pct)}% of ${fmtNutrient(p.target)}</span>
             </span>`
          : "";
        return `<div class="nutrition-cell${v === 0 ? " is-zero" : ""}">
          <span class="nutrition-cell-label" title="${escapeHtml(col)}">${escapeHtml(label)}</span>
          <span class="nutrition-cell-value">${fmtNutrient(v)}${units ? `<span class="nutrition-cell-units">${escapeHtml(units)}</span>` : ""}</span>
          ${goal}
        </div>`;
      })
      .join("");
    return `<div class="nutrition-group"><h4 class="nutrition-group-title">${escapeHtml(g)}</h4><div class="nutrition-grid">${cells}</div></div>`;
  });
  return `<div class="nutrition-detail">${blocks.join("")}</div>`;
}

function renderGroupSummaryStats(totals) {
  return GROUP_SUMMARY_COLS.map(([col, units]) => {
    const label = col.replace(/\s*\([^)]*\)$/, "");
    return `<span class="nutrition-stat"><span class="nutrition-stat-label">${escapeHtml(label)}</span>${fmtNutrient(totals[col] || 0)}<span class="nutrition-stat-units">${units}</span></span>`;
  }).join("");
}

// ── Builder ──
function renderGroupDraft() {
  if (!groupDraft) return;
  groupItemsEl.innerHTML = groupDraft.items.length
    ? groupDraft.items
        .map((it, i) => {
          const food = groupFoodByName(it.item);
          const cal = food ? fmtNutrient((food.values["Calories"] || 0) * it.qty) : "—";
          // The stepper works in the food's own unit — 100 g of banana, not one
          // serving of it — so the serving size has no line of its own to sit
          // on any more; the unit rides beside the box that sets it. Only a
          // food the table has lost still says something under its name.
          const size = servingSizeOf(food);
          const unit = food ? (size ? food.servingUnit : "servings") : "";
          const amount = size ? fmtNutrient(size * it.qty) : it.qty;
          return `
            <div class="group-item${food ? "" : " missing"}" data-i="${i}">
              <span class="group-item-name">${escapeHtml(it.item)}${
                food ? "" : `<span class="group-item-serving">not in table</span>`
              }</span>
              <span class="group-item-qty">
                <button class="group-qty-btn" data-act="dec" data-i="${i}" type="button" aria-label="Less">−</button>
                <input class="group-qty-input" data-i="${i}" type="number" min="0" step="${size ? "any" : "0.25"}"
                       value="${amount}" aria-label="${
                         size ? `Amount of ${escapeHtml(it.item)} in ${escapeHtml(unit)}` : `Servings of ${escapeHtml(it.item)}`
                       }" />
                <button class="group-qty-btn" data-act="inc" data-i="${i}" type="button" aria-label="More">+</button>
                <span class="group-item-unit">${escapeHtml(unit)}</span>
              </span>
              <span class="group-item-cal">${cal}<span class="nutrition-cal-units">cal</span></span>
              <button class="group-item-remove" data-act="remove" data-i="${i}" type="button" aria-label="Remove">×</button>
            </div>`;
        })
        .join("")
    : `<div class="group-empty-hint">Search above to add foods.</div>`;

  const totals = draftTotals();
  groupTotalsEl.hidden = groupDraft.items.length === 0;
  groupTotalsEl.innerHTML = `
    <div class="group-totals-head">
      <span class="group-totals-label">Total</span>
      <span class="group-totals-cal">${fmtNutrient(totals["Calories"] || 0)}<span class="nutrition-cal-units">cal</span></span>
    </div>
    ${renderGroupMacroBar(totals)}
    <div class="nutrition-stats">${renderGroupSummaryStats(totals)}</div>`;
}

const groupFoodCombo = createCombobox({
  input: groupFoodSearchEl,
  list: groupFoodResultsEl,
  getItems: (q) => {
    const query = q.trim().toLowerCase();
    const all = groupsData.foods;
    return (query ? all.filter((f) => f.name.toLowerCase().includes(query)) : all).slice(0, 50);
  },
  valueOf: (f) => f.name,
  renderItem: (f) =>
    `<span>${escapeHtml(f.name)}</span>` +
    `<span class="group-food-meta">${escapeHtml(`${f.servingSize} ${f.servingUnit}`.trim())} · ${fmtNutrient(f.values["Calories"] || 0)} cal</span>`,
  onSelect: (name) => addFoodToDraft(name),
  emptyText: "No foods match.",
});

function addFoodToDraft(name) {
  // Its own line every time — a food already in the group can be listed again
  // rather than folded into the row that's there. Rows are addressed by
  // position, so a repeated name costs nothing.
  groupDraft.items.push({ item: name, qty: 1 });
  groupFoodSearchEl.value = "";
  groupFoodCombo.close();
  renderGroupDraft();
}

function openGroupBuilder(group) {
  groupDraft = group
    ? { id: group.id, name: group.name, items: (group.items || []).map((it) => ({ item: it.item, qty: it.qty })) }
    : { id: null, name: "", items: [] };
  groupNameEl.value = groupDraft.name;
  groupFoodSearchEl.value = "";
  groupStatusEl.textContent = "";
  groupFoodCombo.close();
  renderGroupDraft();
  groupBuilderEl.hidden = false;
  groupNewBtn.classList.add("open");
  groupNameEl.focus();
}

/** Empty every field in the builder — hiding it alone leaves stale markup behind. */
function clearGroupBuilder() {
  groupNameEl.value = "";
  groupFoodSearchEl.value = "";
  groupFoodResultsEl.innerHTML = "";
  groupFoodResultsEl.hidden = true;
  groupItemsEl.innerHTML = "";
  groupTotalsEl.innerHTML = "";
  groupTotalsEl.hidden = true;
  groupStatusEl.textContent = "";
}

function closeGroupBuilder() {
  groupDraft = null;
  clearGroupBuilder();
  groupBuilderEl.hidden = true;
  groupNewBtn.classList.remove("open");
}

groupNewBtn?.addEventListener("click", () => {
  if (groupBuilderEl.hidden) openGroupBuilder(null);
  else closeGroupBuilder();
});
groupCancelBtn?.addEventListener("click", closeGroupBuilder);
groupNameEl?.addEventListener("input", () => { if (groupDraft) groupDraft.name = groupNameEl.value; });
groupItemsEl?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn || !groupDraft) return;
  const i = Number(btn.dataset.i);
  const item = groupDraft.items[i];
  if (!item) return;
  if (btn.dataset.act === "remove") groupDraft.items.splice(i, 1);
  // Same steps as the tables: the food's own unit, in tidy increments of it.
  else if (btn.dataset.act === "inc") item.qty = steppedQty(groupFoodByName(item.item), item.qty, 1);
  else if (btn.dataset.act === "dec") item.qty = steppedQty(groupFoodByName(item.item), item.qty, -1);
  renderGroupDraft();
});

groupItemsEl?.addEventListener("change", (e) => {
  const input = e.target.closest(".group-qty-input");
  if (!input || !groupDraft) return;
  const item = groupDraft.items[Number(input.dataset.i)];
  if (!item) return;
  item.qty = typedQty(groupFoodByName(item.item), input.value);
  renderGroupDraft();
});

groupSaveBtn?.addEventListener("click", async () => {
  if (!groupDraft) return;
  if (!groupDraft.name.trim()) { groupStatusEl.textContent = "Give the group a name."; return; }
  if (groupDraft.items.length === 0) { groupStatusEl.textContent = "Add at least one food."; return; }
  groupSaveBtn.disabled = true;
  groupStatusEl.textContent = "Saving…";
  try {
    const res = await fetch("/api/groups/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(groupDraft),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    closeGroupBuilder();
    groupsLoaded = false;
    await loadGroups();
    // Logs embed this group's name and totals — restale them.
    invalidateNutritionBelow("groups");
  } catch (err) {
    groupStatusEl.textContent = err.message;
  } finally {
    groupSaveBtn.disabled = false;
  }
});

// ── Saved groups ──
/**
 * "Blueberries ×25, Egg Whites ×3" — a group's foods on one line. Quantities are
 * servings, which a gram-scaled food leaves at things like 0.6522; two decimals
 * is as much as the line can carry legibly.
 */
function foodListSummary(foods) {
  return (foods || [])
    .map((f) => `${f.item}${f.qty !== 1 ? ` ×${Math.round(f.qty * 100) / 100}` : ""}`)
    .join(", ");
}

function renderGroupCard(group) {
  const open = groupsExpanded.has(group.id);
  const foods = foodListSummary(group.resolved);
  const detail = open ? renderTotalsDetail(group.totals, groupsData.nutrientCols) : "";

  return `
    <div class="group-card${open ? " open" : ""}" data-id="${escapeHtml(group.id)}">
      <button class="group-card-head" type="button" aria-expanded="${open}">
        <span class="group-card-main">
          <span class="group-card-name">${escapeHtml(group.name)}</span>
          <span class="group-card-foods">${escapeHtml(foods) || "no foods"}</span>
        </span>
        <span class="nutrition-cal">${fmtNutrient(group.totals["Calories"] || 0)}<span class="nutrition-cal-units">cal</span></span>
      </button>
      <div class="nutrition-row-viz">
        ${renderGroupMacroBar(group.totals)}
        <div class="nutrition-stats">${renderGroupSummaryStats(group.totals)}</div>
      </div>
      ${group.missing.length ? `<div class="group-missing">Not in the food table: ${escapeHtml(group.missing.join(", "))}</div>` : ""}
      ${detail}
      <div class="group-card-actions">
        <button class="group-edit-btn" data-act="edit" data-id="${escapeHtml(group.id)}" type="button">Edit</button>
        <button class="group-delete-btn" data-act="delete" data-id="${escapeHtml(group.id)}" type="button">Delete</button>
      </div>
    </div>`;
}

function renderGroups() {
  groupsCountEl.textContent = String(groupsData.groups.length);
  // Ahead of the empty-list return, so the button hides when there's nothing.
  syncExpandAllBtn(groupsExpandAllBtn, groupsData.groups, groupsExpanded);
  // A repeated item name in raw.csv can't be told apart by name alone, so the
  // first row wins and the rest are flagged here.
  const dupes = groupsData.duplicateFoods || [];
  const warning = dupes.length
    ? `<div class="group-missing group-dupe-warning">Duplicate food ${dupes.length === 1 ? "name" : "names"} in raw.csv — groups use the first row of ${escapeHtml(dupes.join(", "))}.</div>`
    : "";
  if (groupsData.groups.length === 0) {
    groupsContentEl.innerHTML = warning + `<div class="empty">No groups yet. Use “New group” to build one from your foods.</div>`;
    return;
  }
  const sorted = [...groupsData.groups].sort((a, b) => a.name.localeCompare(b.name));
  if (!groupsView.isTable()) {
    groupsContentEl.innerHTML = warning + sorted.map(renderGroupCard).join("");
    return;
  }

  // Table mode nests: a totals row per group, then — once expanded — one row per
  // food showing its contribution at that quantity, then a picker row for
  // adding another. Edits are staged in `groupEdits` and only hit the server on
  // Save, so the rows here render from the pending list whenever one exists.
  const cols = tableColsFromNames(groupsData.nutrientCols);
  const rows = [];
  for (const m of sorted) {
    const pending = groupEdits.get(m.id);
    const items = pending || m.items || [];
    // Unsaved edits force the group open — its foods are the whole point of the
    // edit, and collapsing them would strand it out of sight.
    const open = groupsExpanded.has(m.id) || Boolean(pending);
    // Renaming and editing the foods are the same edit as far as saving goes:
    // either one turns the row's Edit/Delete into Save/Cancel, and one write
    // commits both.
    const renaming = groupNameEdits.has(m.id);
    rows.push({
      nameHtml: renaming
        ? nameEditor({
            name: groupNameEdits.get(m.id),
            data: `data-id="${escapeHtml(m.id)}"`,
            aria: "Group name",
            caret: { act: "toggle-rows", data: `data-id="${escapeHtml(m.id)}"`, open },
          })
        : disclosureName(m.id, m.name, open),
      meta: `${items.length} food${items.length === 1 ? "" : "s"}${pending ? " · unsaved" : ""}`,
      values: pending ? itemsTotals(cols, items) : m.totals,
      actions: pending || renaming ? editRowActions(m.id) : rowActions(m.id),
      // Dropping a food onto the group row itself puts it at the top of that
      // group — where the line lands — and works while the group is collapsed.
      attrs: foodDropAttrs("group", m.id, "start"),
      variant: "parent",
    });
    if (!open) continue;
    items.forEach((it, i) => {
      const food = groupFoodByName(it.item);
      rows.push({
        nameHtml: foodRowName(it.item, food, { draggable: true }),
        // The stepper edits the serving amount, so it lives in that column.
        lead: { unit: foodLead(food, it.qty).unit },
        leadHtml: { size: groupChildControls(m.id, it, i) },
        values: scaledFoodValues(cols, food, it.qty),
        // By position, not by name: a group can list the same food twice.
        actions: removeRowAction(
          "remove-food",
          `data-id="${escapeHtml(m.id)}" data-i="${i}"`,
          it.item,
        ),
        attrs: foodDragAttrs("group", m.id, it.item, i),
        variant: "child",
      });
    });
    rows.push({
      nameHtml: groupAddFoodInput(m.id),
      values: null,
      actions: "",
      attrs: foodDropAttrs("group", m.id, "end"),
      variant: "add",
    });
  }
  // Same yardstick as the Food and Meal Log tabs: the daily targets ride in
  // the header so every nutrient can be read against them while the body
  // scrolls. A group is a fraction of a day, so this is a ceiling, not a goal.
  const pinned = groupsData.targets
    ? { name: groupsData.targets.name, values: groupsData.targets.values, variant: "target" }
    : null;
  groupsContentEl.innerHTML =
    warning + groupFoodDatalist() + renderNutrientTable(cols, rows, { pinned, stickyParents: true });
  syncPinnedTableRows(groupsContentEl);
}

/**
 * Group totals recomputed locally, so staged edits show before they're saved.
 * The Meal Log tab passes its own food lookup — it holds a separate copy of
 * the table, loaded with the logs rather than the groups.
 */
function itemsTotals(cols, items, foodByName = groupFoodByName) {
  const totals = {};
  for (const c of cols) totals[c.key] = 0;
  for (const it of items) {
    const food = foodByName(it.item);
    if (!food) continue;
    for (const c of cols) totals[c.key] += (food.values[c.key] || 0) * it.qty;
  }
  return totals;
}

// Staged, unsaved item lists by group id. Absent = the group is clean.
const groupEdits = new Map();
// Staged names, by group id — present only while a row is being renamed, which
// is also what puts its name in a box. Saved by the same Save as the foods.
const groupNameEdits = new Map();

/** Stage a change against a group's pending list and repaint. */
function editGroupItems(groupId, fn) {
  const group = groupsData.groups.find((m) => m.id === groupId);
  if (!group) return;
  const items = (groupEdits.get(groupId) || group.items || []).map((it) => ({ ...it }));
  groupEdits.set(groupId, fn(items) || items);
  renderGroupsKeepingScroll();
}

// A re-render rebuilds the table, which would otherwise snap back to the first
// column and the top of the list mid-edit.
function renderGroupsKeepingScroll() {
  renderTableKeepingScroll(groupsContentEl, renderGroups);
}

/** One row's contribution at a quantity — a food in a group, a group in a day. */
function scaledValues(cols, values, qty) {
  if (!values) return null;
  const out = {};
  for (const c of cols) out[c.key] = (values[c.key] || 0) * qty;
  return out;
}

/** A food's contribution to a group — its per-serving values times the quantity. */
function scaledFoodValues(cols, food, qty) {
  return scaledValues(cols, food?.values, qty);
}

/**
 * The food name plus its quantity stepper. The stepper lives in the name cell
 * because it edits what the row *is*; removing the row is an action, so it goes
 * in the pinned actions column with Edit/Delete — see removeRowAction.
 *
 * Shared with the Meal Log tab's third level, which edits the same foods from
 * one level further down: `data` is how that tab addresses the row and `acts`
 * are the action names its own handler listens for.
 */
function foodRowControls(r, food, data, acts) {
  const size = servingSizeOf(food);
  const unit = food?.servingUnit || "";
  const btn = (act, label, aria) =>
    `<button class="ntable-qty-btn" data-act="${act}" ${data} type="button" aria-label="${aria}">${label}</button>`;
  // The amount is what you'd actually measure out, so that's all the row says —
  // the serving count it converts to is bookkeeping, not something to read. The
  // unit it's in has its own column now, so it isn't repeated here.
  const amount = size ? `${fmtNutrient(size * r.qty)}` : String(r.qty);
  return `<span class="ntable-child-controls">
      ${btn(acts.dec, "−", "Less")}
      <input class="ntable-qty-input" type="number" min="0" step="${size ? "any" : "0.25"}" value="${amount}"
             ${data} aria-label="${size ? `Amount of ${escapeHtml(r.item)} in ${escapeHtml(unit)}` : `Servings of ${escapeHtml(r.item)}`}" />
      ${btn(acts.inc, "+", "More")}
    </span>`;
}

// Six dots — the usual grip. Filled circles rather than strokes, so it reads as
// texture to take hold of instead of one more line icon in a column of them.
const DRAG_GRIP_ICON = `<svg viewBox="0 0 24 24" width="11" height="14" aria-hidden="true">${
  [8, 16].map((x) => [6, 12, 18].map((y) => `<circle cx="${x}" cy="${y}" r="1.7" fill="currentColor"></circle>`).join("")).join("")
}</svg>`;

/**
 * A food row's name cell — the name, and a note when it isn't in raw.csv.
 *
 * `draggable` prefixes the grip that reorders the row, and `before` anything
 * that belongs ahead of it. Both hang back into the row's indent, so the food
 * names still line up under each other and under the picker below them.
 */
function foodRowName(item, food, { draggable = false, before = "" } = {}) {
  const text = `<span class="ntable-name-text">${escapeHtml(item)}</span>` +
    (food ? "" : `<span class="ntable-child-serving">not in the food table</span>`);
  if (!draggable) return text;
  return `<span class="ntable-drag-name">${before}<span class="ntable-drag-handle"
      title="Drag to reorder — or onto another meal to move it there"
      aria-hidden="true">${DRAG_GRIP_ICON}</span><span class="ntable-drag-name-main">${text}</span></span>`;
}

/**
 * What a food row is, for dragging: something to pick up, and somewhere another
 * food can land. `scope` says which tab's model owns it — see the food-drag
 * section for the two.
 *
 * `index` is the row's place in the list its owner holds, and it's how the row
 * is addressed: the same food can be listed twice in one group, as two helpings
 * of it, and by name a drag on either would find the first. The name rides
 * along only for what a drag shows and for looking the food itself up.
 */
function foodDragAttrs(scope, owner, item, index) {
  const o = escapeHtml(owner);
  const i = escapeHtml(item);
  return `data-drag-scope="${scope}" data-drag-owner="${o}" data-drag-item="${i}" ` +
    `data-drop-scope="${scope}" data-drop-owner="${o}" data-drop-item="${i}" ` +
    `data-drag-index="${index}" data-drop-index="${index}"`;
}

/**
 * A row that holds no food of its own but still accepts one: a group's own row
 * (`start` — the top of its list) or its add row (`end`).
 */
function foodDropAttrs(scope, owner, pos) {
  return `data-drop-scope="${scope}" data-drop-owner="${escapeHtml(owner)}" data-drop-pos="${pos}"`;
}

/**
 * The Serving/Unit columns for a food row: the amount this row contributes, in
 * the food's own unit. A food whose serving size isn't a number ("1/2") can't
 * be scaled, so the row falls back to a count of servings.
 */
function foodLead(food, qty) {
  if (!food) return { size: "", unit: "" };
  const size = servingSizeOf(food);
  if (!size) return { size: `×${Math.round(qty * 100) / 100}`, unit: food.servingUnit || "servings" };
  return { size: fmtNutrient(size * qty), unit: food.servingUnit || "" };
}

/**
 * A nested row's Remove, for the actions column every row of a table shares.
 * Same trash icon as Delete — the two differ in what they act on, not in what
 * they look like, and the row you're on already says which. `data` addresses
 * the row.
 */
function removeRowAction(act, data, label) {
  return iconAction(act, "delete", `Remove ${label}`, data, "ntable-icon-danger");
}

function groupChildControls(groupId, r, i) {
  return foodRowControls(
    r,
    groupFoodByName(r.item),
    `data-id="${escapeHtml(groupId)}" data-i="${i}" data-item="${escapeHtml(r.item)}"`,
    { dec: "qty-dec", inc: "qty-inc" },
  );
}

/**
 * A food's serving size as a number, or null when it isn't one ("1/2", ""). A
 * null means the amount can't be scaled, so the stepper falls back to servings.
 */
function servingSizeOf(food) {
  const size = food ? parseFloat(food.servingSize) : NaN;
  return Number.isFinite(size) && size > 0 ? size : null;
}

// Steps are chosen in the food's own unit (5 g, 2 oz, 0.25 cup) rather than as
// a fraction of a serving, which would land on amounts like 6.25 g.
const AMOUNT_STEPS = [0.25, 0.5, 1, 2, 5, 10, 25, 50, 100];

// Units that measure an amount. Anything else counts things — eggs, slices,
// scoops, pills — and a quarter of an egg white isn't something you'd measure
// out, so those step by whole units however small the serving is.
const MEASURE_UNITS = new Set([
  "g", "kg", "mg", "oz", "fl oz", "lb", "lbs", "ml", "l",
  "cup", "cups", "tbsp", "tsp", "qt", "pt",
]);

/**
 * The largest tidy increment that doesn't overshoot a quarter of a serving —
 * floored at one whole unit for the things that are counted rather than
 * measured. A 40-drop serving still steps by 10; a 1-egg-white one steps by 1.
 */
function amountStep(size, unit = "") {
  let step = AMOUNT_STEPS[0];
  for (const s of AMOUNT_STEPS) if (s <= size / 4) step = s;
  if (!MEASURE_UNITS.has(String(unit).trim().toLowerCase())) step = Math.max(1, step);
  return step;
}

/** Groups store servings, so every amount edit converts back through the size. */
function qtyFromAmount(amount, size) {
  if (!Number.isFinite(amount) || amount <= 0) return 1;
  return Math.round((amount / size) * 10000) / 10000;
}

// Stepping snaps to multiples of the step, so a hand-typed 31.3 g settles onto
// 35 / 30 / 25 rather than carrying its remainder forever.
function steppedAmount(current, step) {
  const next = Math.round((current + step) / Math.abs(step)) * Math.abs(step);
  return Math.max(Math.abs(step), Math.round(next * 1000) / 1000);
}

/**
 * One press of a food's − or +, as a new quantity in servings. Everywhere a
 * food's amount can be stepped — both tables and the group builder — steps
 * through here, so 25 g means 25 g wherever you happen to be editing it. A food
 * whose serving size isn't a number can't be scaled, so it counts servings.
 */
function steppedQty(food, qty, dir) {
  const size = servingSizeOf(food);
  if (!size) return Math.max(0.25, Math.round((qty + 0.25 * dir) * 100) / 100);
  return qtyFromAmount(steppedAmount(size * qty, amountStep(size, food.servingUnit) * dir), size);
}

/** The same, for an amount typed straight into the box. */
function typedQty(food, value) {
  const size = servingSizeOf(food);
  const v = parseFloat(value);
  if (size) return qtyFromAmount(v, size);
  return Math.max(0.25, Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : 1);
}

/**
 * Type-to-search over ~90 foods. A `datalist` rather than a custom dropdown
 * because the browser draws that popup as native chrome — an absolutely
 * positioned list would be clipped by the table wrapper's own overflow.
 */
function groupAddFoodInput(groupId) {
  return `<input class="ntable-add-input" list="${GROUP_FOOD_LIST_ID}" type="text"
      data-group="${escapeHtml(groupId)}" placeholder="+ Add food…"
      autocomplete="off" aria-label="Add a food to this group" />`;
}

const GROUP_FOOD_LIST_ID = "group-food-options";

/**
 * An `input` event that is a pick from the `datalist` popup rather than typing.
 *
 * The add rows can't wait for `change`: a browser only fires that once the box
 * is left, so choosing a food from the list sat there looking as though the pick
 * hadn't landed until you clicked away. A replacement made by autocomplete
 * reports itself as `insertReplacementText` — typing is `insertText` — and the
 * blank case covers the browsers that send no inputType at all.
 */
function isDatalistPick(e) {
  return !e.inputType || e.inputType === "insertReplacementText";
}

/** One shared option list for every add row on the tab. */
function groupFoodDatalist() {
  const foods = [...(groupsData.foods || [])].sort((a, b) => a.name.localeCompare(b.name));
  return `<datalist id="${GROUP_FOOD_LIST_ID}">${foods
    .map((f) => `<option value="${escapeHtml(f.name)}"></option>`)
    .join("")}</datalist>`;
}

/**
 * Persist a group's item list, then refresh groups and anything downstream.
 * `name` is the renamed one when the row was being renamed as well — the two
 * edits share a Save, and the group is written whole either way.
 */
async function saveGroupItems(group, items, name = group.name) {
  await postGroupItems(group, items, name);
  groupsLoaded = false;
  await loadGroups();
  invalidateNutritionBelow("groups");
}

/**
 * The write on its own, without the reload. The Meal Log tab's Save can commit
 * several groups and then the day itself, and reloading between each would
 * refetch — and repaint — once per group on the way through.
 */
async function postGroupItems(group, items, name = group.name) {
  const res = await fetch("/api/groups/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: group.id, name, notes: group.notes || "", items }),
  });
  if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
}

/**
 * One of the add rows, committed. Rows are addressed by position, so a food
 * already in the group is added again as a line of its own rather than folded
 * into the one that's there.
 */
function commitGroupAddInput(add) {
  if (!add.value.trim()) return;
  // Only commit on an exact food — a half-typed name shouldn't add anything.
  const food = groupFoodByName(add.value.trim());
  if (!food) {
    add.value = "";
    return;
  }
  add.value = "";
  editGroupItems(add.dataset.group, (items) => {
    items.push({ item: food.name, qty: 1 });
  });
}

groupsContentEl?.addEventListener("change", (e) => {
  const qtyInput = e.target.closest(".ntable-qty-input");
  if (qtyInput) {
    const qty = typedQty(groupFoodByName(qtyInput.dataset.item), qtyInput.value);
    editGroupItems(qtyInput.dataset.id, (items) => {
      const it = items[Number(qtyInput.dataset.i)];
      if (it) it.qty = qty;
    });
    return;
  }
  const add = e.target.closest(".ntable-add-input");
  if (add) commitGroupAddInput(add);
});

// A name is staged as it's typed and never repaints: the row's numbers don't
// depend on it, and a re-render would take the caret out of the box — or worse,
// replace the Save button between the blur and the click that lands on it.
groupsContentEl?.addEventListener("input", (e) => {
  const add = e.target.closest(".ntable-add-input");
  if (add) {
    if (isDatalistPick(e)) commitGroupAddInput(add);
    return;
  }
  const nameInput = e.target.closest(".ntable-name-input");
  if (nameInput) groupNameEdits.set(nameInput.dataset.id, nameInput.value);
});

// Enter commits the rename, Escape drops it — the two things the keyboard
// should do in a box that has Save and Cancel sitting beside it.
groupsContentEl?.addEventListener("keydown", (e) => {
  const nameInput = e.target.closest(".ntable-name-input");
  if (!nameInput || (e.key !== "Enter" && e.key !== "Escape")) return;
  e.preventDefault();
  const id = CSS.escape(nameInput.dataset.id);
  const act = e.key === "Enter" ? "save-edits" : "cancel-edits";
  groupsContentEl.querySelector(`[data-act="${act}"][data-id="${id}"]`)?.click();
});

const groupsView = createViewToggle(
  document.getElementById("groups-view"),
  "dash-groups-view",
  () => renderGroups(),
);

// Shared with the cards view's own disclosure, so the button reads the same
// state in either mode.
const groupsExpandAllBtn = document.getElementById("groups-expand-all");
groupsExpandAllBtn?.addEventListener("click", () =>
  toggleExpandAll(groupsData.groups, groupsExpanded, renderGroups),
);

groupsContentEl?.addEventListener("click", async (e) => {
  const actBtn = e.target.closest("[data-act]");
  if (actBtn) {
    const group = groupsData.groups.find((m) => m.id === actBtn.dataset.id);
    if (!group) return;
    const act = actBtn.dataset.act;
    if (act === "toggle-rows") {
      if (groupsExpanded.has(group.id)) groupsExpanded.delete(group.id);
      else groupsExpanded.add(group.id);
      renderGroupsKeepingScroll();
      return;
    }
    // Staged edits — nothing reaches the server until Save.
    if (act === "qty-inc" || act === "qty-dec") {
      const dir = act === "qty-inc" ? 1 : -1;
      const food = groupFoodByName(actBtn.dataset.item);
      editGroupItems(group.id, (items) => {
        const it = items[Number(actBtn.dataset.i)];
        if (it) it.qty = steppedQty(food, it.qty, dir);
      });
      return;
    }
    if (act === "remove-food") {
      // By position: the same food can be listed twice, and by name this would
      // take the first of them whichever row was clicked.
      const i = Number(actBtn.dataset.i);
      editGroupItems(group.id, (items) => items.filter((_, n) => n !== i));
      return;
    }
    if (act === "cancel-edits") {
      groupEdits.delete(group.id);
      groupNameEdits.delete(group.id);
      renderGroupsKeepingScroll();
      return;
    }
    if (act === "save-edits") {
      const items = groupEdits.get(group.id);
      const name = groupNameEdits.get(group.id);
      // The button only exists while one of the two is staged — this catches a
      // second click on a Save already in flight.
      if (!items && name === undefined) return;
      setBtnBusy(actBtn, "Saving…");
      groupEdits.delete(group.id);
      groupNameEdits.delete(group.id);
      try {
        // A name typed away to nothing isn't a rename — the server would reject
        // it, and the row has nowhere to say so, so the old name stands.
        await saveGroupItems(group, items || group.items || [], name?.trim() || group.name);
      } catch (err) {
        // Put the edits back so they aren't lost.
        if (items) groupEdits.set(group.id, items);
        if (name !== undefined) groupNameEdits.set(group.id, name);
        renderGroupsKeepingScroll();
        console.error(err);
      }
      return;
    }
    if (act === "edit") {
      // In the table the row itself is the editor: the name turns into a box and
      // the actions into Save/Cancel. The cards view has no such row, so there
      // Edit still opens the builder below the list.
      if (groupsView.isTable()) {
        groupNameEdits.set(group.id, group.name);
        renderGroupsKeepingScroll();
        groupsContentEl.querySelector(`.ntable-name-input[data-id="${CSS.escape(group.id)}"]`)?.focus();
        return;
      }
      openGroupBuilder(group);
      groupBuilderEl.scrollIntoView({ block: "nearest" });
    } else if (act === "delete") {
      setBtnBusy(actBtn, "Deleting…");
      try {
        const res = await fetch("/api/groups/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: group.id }),
        });
        if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
        groupsLoaded = false;
        await loadGroups();
        // Logs that used it must now report it in `missing`.
        invalidateNutritionBelow("groups");
      } catch (err) {
        setBtnBusy(actBtn, "Delete failed", { failed: true });
        console.error(err);
      }
    }
    return;
  }
  const head = e.target.closest(".group-card-head");
  if (!head) return;
  const id = head.closest(".group-card").dataset.id;
  if (groupsExpanded.has(id)) groupsExpanded.delete(id);
  else groupsExpanded.add(id);
  renderGroups();
});

async function loadGroups() {
  if (groupsLoaded) return;
  groupsLoaded = true;
  try {
    const res = await fetch("/api/groups", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    groupsData = await res.json();
    renderGroups();
  } catch (err) {
    groupsLoaded = false;
    groupsContentEl.innerHTML = `<div class="empty">Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}

// ── Log ──────────────────────────────────────────────
// A log is one full intake, with totals cascading up from foods → groups → the
// log. A group is a meal.
//
// A log's name is free-form — a date, "training day", whatever suits — so
// nothing here assumes one covers exactly one calendar day. That's the whole
// reason the word is "log" and not "day": the list holds plans, templates and
// what was actually eaten, and only the name tells them apart.
//
// Its list (nutrition/food-logs.json) holds three kinds of entry:
//
//   { group, qty }               a saved group. Only its id is stored, so
//                                editing the group updates every log using it.
//   { custom, name, items, qty } an ad-hoc group belonging to this day alone —
//                                its foods are kept right here, so it never
//                                reaches the Groups tab or another day.
//   { food, qty }                a food eaten on its own, with no group at all.
//
// A saved group's foods are shared, so they stage and save on their own; the
// other two are part of the day's own list, so they stage there and go in with
// the day's Save.
let logsLoaded = false;
let logsData = { logs: [], groups: [], foods: [], nutrientCols: [], targets: null };
let logDraft = null; // { id, name, items: [{ group, qty }] }
const logsExpanded = new Set();

const logsContentEl = document.getElementById("logs-content");
const logsCountEl = document.getElementById("logs-count");
const logNewBtn = document.getElementById("log-new-btn");
const logUndoBtn = document.getElementById("log-undo-btn");
const logBuilderEl = document.getElementById("log-builder");
const logNameEl = document.getElementById("log-name");
const logGroupSearchEl = document.getElementById("log-group-search");
if (logGroupSearchEl) {
  logGroupSearchEl.placeholder = SAVED_GROUPS_ENABLED ? "Search meals to add…" : "Search foods to add…";
}
const logGroupResultsEl = document.getElementById("log-group-results");
const logItemsEl = document.getElementById("log-items");
const logTotalsEl = document.getElementById("log-totals");
const logSaveBtn = document.getElementById("log-save-btn");
const logCancelBtn = document.getElementById("log-cancel-btn");
const logStatusEl = document.getElementById("log-status");

// ── Undoing a delete ──────────────────────────────────
// A deleted log is only gone from food-logs.json — its id, name, notes and list are
// all still here, and saveLog writes a log back under an id it doesn't
// recognise rather than rejecting it. So the delete is reversible in full, but
// the offer is only on screen briefly: it takes the header's spring from New
// template, so it retires itself rather than sitting there for the rest of the
// session.
let logDeleted = null;
let logUndoTimer = null;
const LOG_UNDO_MS = 5000;

function setLogUndo(log) {
  logDeleted = log;
  clearTimeout(logUndoTimer);
  logUndoTimer = null;
  if (!logUndoBtn) return;
  logUndoBtn.hidden = !log;
  if (log) {
    logUndoBtn.textContent = `Undo delete of ${log.name}`;
    logUndoTimer = setTimeout(() => setLogUndo(null), LOG_UNDO_MS);
  }
}

logUndoBtn?.addEventListener("click", async () => {
  const log = logDeleted;
  if (!log) return;
  // Hold the button still for as long as the restore takes — and, if it fails,
  // long enough to read why it did.
  clearTimeout(logUndoTimer);
  logUndoTimer = null;
  setBtnBusy(logUndoBtn, "Restoring…");
  try {
    const res = await fetch("/api/food-logs/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: log.id, name: log.name, notes: log.notes, items: log.items }),
    });
    if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
    logUndoBtn.disabled = false;
    setLogUndo(null);
    logsLoaded = false;
    await loadLogs();
    // Back on screen as the one being looked at — it's the day that was just
    // missing, and landing anywhere else would leave you looking for it.
    selectLog(log.id);
  } catch (err) {
    setBtnBusy(logUndoBtn, `Restore failed — ${err.message}`, { failed: true });
    console.error(err);
  }
});

/** Which of the three kinds of entry a day's list is holding at this row. */
function logItemKind(it) {
  if (it.food) return "food";
  if (it.custom) return "custom";
  return "group";
}

/**
 * An ad-hoc group entry dressed as a group, so every row builder, drag target
 * and food handler below can treat it like one. No `totals` — an ad-hoc group's
 * are computed from its own list (see logGroupTotals), which is the only place
 * its foods exist.
 */
function customGroupOf(it) {
  return { id: it.custom, name: it.name || "", items: it.items || [], custom: true };
}

/**
 * An id for a new ad-hoc group. It only has to be unique among the ids on the
 * page — it addresses rows and staged edits, and the server keeps whatever it's
 * given — so the clock plus a few random characters is enough.
 */
function newCustomGroupId() {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Where an ad-hoc group lives: the day holding it, and its position in that
 * day. Pending edits win over the saved list, so a group staged but not yet
 * saved is still found.
 */
function logCustomEntry(customId) {
  if (!customId) return null;
  for (const m of logsData.logs) {
    const items = logEdits.get(m.id) || m.items || [];
    const index = items.findIndex((it) => it.custom === customId);
    if (index !== -1) return { log: m, index, item: items[index] };
  }
  return null;
}

/** A group by id — saved on the Groups tab, or ad-hoc inside some day. */
function logGroupById(id) {
  const saved = logsData.groups.find((m) => m.id === id);
  if (saved) return saved;
  const found = logCustomEntry(id);
  return found ? customGroupOf(found.item) : undefined;
}

/** The food table that came with the logs payload — for the third-level rows. */
function logFoodByName(name) {
  return (logsData.foods || []).find((f) => f.name.toLowerCase() === String(name).toLowerCase());
}

/**
 * One entry's contribution to the day, in the draft's own nutrient names. Each
 * kind reaches its numbers differently: a saved group has totals of its own, an
 * ad-hoc one is summed from the foods it carries, a lone food is just itself.
 */
function logDraftItemTotals(it) {
  const cols = logsData.nutrientCols;
  const out = Object.fromEntries(cols.map((c) => [c, 0]));
  const qty = it.qty || 1;
  const add = (values, mult) => {
    for (const c of cols) out[c] += (values?.[c] || 0) * mult;
  };
  if (it.food) add(logFoodByName(it.food)?.values, qty);
  else if (it.custom) for (const f of it.items || []) add(logFoodByName(f.item)?.values, (f.qty || 1) * qty);
  else add(logGroupById(it.group)?.totals, qty);
  return out;
}

/** Live day totals for the draft, summed from each entry's own. */
function logDraftTotals() {
  const totals = {};
  for (const c of logsData.nutrientCols) totals[c] = 0;
  for (const it of logDraft?.items || []) {
    const own = logDraftItemTotals(it);
    for (const c of logsData.nutrientCols) totals[c] += own[c];
  }
  return totals;
}

/**
 * One line of the draft. The builder only adds saved groups, but a day
 * being edited can hold ad-hoc groups and lone foods put there from the table,
 * so all three are listed — and, being in the draft, kept when it's saved.
 */
function logDraftLine(it) {
  if (it.food) {
    const food = logFoodByName(it.food);
    return { name: it.food, sub: food ? "food" : "not in the food table", ok: Boolean(food) };
  }
  if (it.custom) {
    return { name: it.name || "Meal", sub: foodListSummary(it.items || []) || "no foods yet", ok: true };
  }
  const group = logGroupById(it.group);
  // The group's own foods, same line the Groups tab shows — no quantity,
  // since a group eaten twice in a day is two entries here.
  return { name: group ? group.name : it.group, sub: group ? foodListSummary(group.resolved) : "meal no longer exists", ok: Boolean(group) };
}

function renderLogDraft() {
  if (!logDraft) return;
  logItemsEl.innerHTML = logDraft.items.length
    ? logDraft.items
        .map((it, i) => {
          const line = logDraftLine(it);
          const cal = line.ok ? fmtNutrient(logDraftItemTotals(it)["Calories"] || 0) : "—";
          return `
            <div class="group-item${line.ok ? "" : " missing"}" data-i="${i}">
              <span class="group-item-name">${escapeHtml(line.name)}<span class="group-item-serving">${escapeHtml(line.sub)}</span></span>
              <span class="group-item-cal">${cal}<span class="nutrition-cal-units">cal</span></span>
              <button class="group-item-remove" data-act="remove" data-i="${i}" type="button" aria-label="Remove">×</button>
            </div>`;
        })
        .join("")
    : `<div class="group-empty-hint">Search above to add ${SAVED_GROUPS_ENABLED ? "meals" : "foods"} to the log.</div>`;

  const totals = logDraftTotals();
  logTotalsEl.hidden = logDraft.items.length === 0;
  logTotalsEl.innerHTML = `
    <div class="group-totals-head">
      <span class="group-totals-label">Log total</span>
      <span class="group-totals-cal">${fmtNutrient(totals["Calories"] || 0)}<span class="nutrition-cal-units">cal</span></span>
    </div>
    ${renderGroupMacroBar(totals)}
    <div class="nutrition-stats">${renderGroupSummaryStats(totals)}</div>`;
}

// The builder's picker. It searched saved groups; with those off it searches
// foods instead, because a new day still has to be able to start with something
// — the API won't save an empty one — and the groups it's made of are composed
// in the table afterwards.
const logGroupCombo = createCombobox({
  input: logGroupSearchEl,
  list: logGroupResultsEl,
  getItems: (q) => {
    const query = q.trim().toLowerCase();
    const all = SAVED_GROUPS_ENABLED ? logsData.groups : logsData.foods || [];
    return (query ? all.filter((m) => m.name.toLowerCase().includes(query)) : all).slice(0, 50);
  },
  valueOf: (m) => (SAVED_GROUPS_ENABLED ? m.id : m.name),
  renderItem: (m) =>
    `<span>${escapeHtml(m.name)}</span>` +
    `<span class="group-food-meta">${SAVED_GROUPS_ENABLED
      ? `${m.resolved.length} food${m.resolved.length === 1 ? "" : "s"} · ${fmtNutrient(m.totals["Calories"] || 0)} cal`
      : `${escapeHtml(`${m.servingSize} ${m.servingUnit}`.trim())} · ${fmtNutrient(m.values["Calories"] || 0)} cal`}</span>`,
  onSelect: (value) => addToLogDraft(value),
  emptyText: SAVED_GROUPS_ENABLED ? "No meals match." : "No foods match.",
});

function addToLogDraft(value) {
  // Always its own entry — the same group or food twice in a day is two lines.
  logDraft.items.push(SAVED_GROUPS_ENABLED ? { group: value, qty: 1 } : { food: value, qty: 1 });
  logGroupSearchEl.value = "";
  logGroupCombo.close();
  renderLogDraft();
}

function clearLogBuilder() {
  logNameEl.value = "";
  logGroupSearchEl.value = "";
  logGroupResultsEl.innerHTML = "";
  logGroupResultsEl.hidden = true;
  logItemsEl.innerHTML = "";
  logTotalsEl.innerHTML = "";
  logTotalsEl.hidden = true;
  logStatusEl.textContent = "";
}

function openLogBuilder(log) {
  // Whole entries rather than a group id apiece: a day can hold ad-hoc groups
  // and lone foods too, and rebuilding the list from ids would drop them on the
  // next Save.
  logDraft = log
    ? { id: log.id, name: log.name, items: (log.items || []).map((it) => ({ ...it })) }
    : { id: null, name: "", items: [] };
  clearLogBuilder();
  logNameEl.value = logDraft.name;
  renderLogDraft();
  logBuilderEl.hidden = false;
  logAiPanel?.close(); // one panel at a time under this header
  // Editing an existing day, the panel below *is* that day — a button
  // offering a new one beside it only reads as a way to lose the edit. When the
  // panel is building a new one it stays put: it's the toggle that opened it.
  logNewBtn.hidden = Boolean(log);
  logNewBtn.classList.add("open");
  logNameEl.focus();
}

function closeLogBuilder() {
  logDraft = null;
  clearLogBuilder();
  logBuilderEl.hidden = true;
  logNewBtn.hidden = false;
  logNewBtn.classList.remove("open");
}

logNewBtn?.addEventListener("click", () => {
  if (logBuilderEl.hidden) openLogBuilder(null);
  else closeLogBuilder();
});
logCancelBtn?.addEventListener("click", closeLogBuilder);
logNameEl?.addEventListener("input", () => { if (logDraft) logDraft.name = logNameEl.value; });
logItemsEl?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn || !logDraft) return;
  const i = Number(btn.dataset.i);
  const item = logDraft.items[i];
  if (!item) return;
  if (btn.dataset.act !== "remove") return;
  logDraft.items.splice(i, 1);
  renderLogDraft();
});

logSaveBtn?.addEventListener("click", async () => {
  if (!logDraft) return;
  if (!logDraft.name.trim()) { logStatusEl.textContent = "Give the log a name."; return; }
  // No check on the list: a name is enough to create the day, and the groups can
  // be added to it from the table below afterwards.
  logSaveBtn.disabled = true;
  logStatusEl.textContent = "Saving…";
  try {
    const res = await fetch("/api/food-logs/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(logDraft),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    closeLogBuilder();
    logsLoaded = false;
    await loadLogs();
    // The day just saved becomes the one on screen. The table shows a single
    // day at a time, and an empty one saved behind another would look like
    // nothing had happened — this puts it in front of its own add row.
    if (data.log?.id) selectLog(data.log.id);
  } catch (err) {
    logStatusEl.textContent = err.message;
  } finally {
    logSaveBtn.disabled = false;
  }
});

/**
 * One group inside an expanded log: its name, and under it the same food
 * summary the Groups tab shows for that group. Eating a group twice in a day is
 * two of these rows, so there's no quantity to show.
 */
function renderLogGroupRow(r) {
  const foods = foodListSummary(r.foods);
  return `<div class="log-group-row">
    <span class="log-group-main">
      <span class="log-group-name">${escapeHtml(r.name)}</span>
      ${foods ? `<span class="log-group-foods">${escapeHtml(foods)}</span>` : ""}
    </span>
    <span class="log-group-cal">${fmtNutrient(r.calories * (r.qty || 1))}<span class="nutrition-cal-units">cal</span></span>
  </div>`;
}

function renderLogCard(log) {
  const open = logsExpanded.has(log.id);
  const groups = log.resolved.map((r) => r.name).join(", ");
  return `
    <div class="group-card${open ? " open" : ""}" data-id="${escapeHtml(log.id)}">
      <button class="group-card-head" type="button" aria-expanded="${open}">
        <span class="group-card-main">
          <span class="group-card-name">${escapeHtml(log.name)}</span>
          <span class="group-card-foods">${escapeHtml(groups) || "no meals"}</span>
        </span>
        <span class="nutrition-cal">${fmtNutrient(log.totals["Calories"] || 0)}<span class="nutrition-cal-units">cal</span></span>
      </button>
      <div class="nutrition-row-viz">
        ${renderGroupMacroBar(log.totals)}
        <div class="nutrition-stats">${renderGroupSummaryStats(log.totals)}</div>
      </div>
      ${log.missing.length ? `<div class="group-missing">Deleted meals still referenced: ${escapeHtml(log.missing.join(", "))}</div>` : ""}
      ${log.missingFoods.length ? `<div class="group-missing">Foods missing from the table: ${escapeHtml(log.missingFoods.join(", "))}</div>` : ""}
      ${open ? `<div class="log-group-list">${log.resolved.map(renderLogGroupRow).join("")}</div>` : ""}
      ${open ? renderTotalsDetail(log.totals, logsData.nutrientCols, logsData.targets) : ""}
      <div class="group-card-actions">
        <button class="group-edit-btn" data-act="edit" data-id="${escapeHtml(log.id)}" type="button">Edit</button>
        <button class="group-delete-btn" data-act="delete" data-id="${escapeHtml(log.id)}" type="button">Delete</button>
      </div>
    </div>`;
}

// Staged, unsaved group lists by log id. Absent = the day is clean.
const logEdits = new Map();
// Staged day names, by log id — present only while a day is being renamed
// from its own row. Saved by the same Save as its list.
const logNameEdits = new Map();

/**
 * Stage a change against a day's pending list, without repainting — for
 * edits made while a control of the row still has focus, which a re-render
 * would take away mid-keystroke.
 */
function stageLogItems(logId, fn) {
  const log = logsData.logs.find((m) => m.id === logId);
  if (!log) return;
  const items = (logEdits.get(logId) || log.items || []).map((it) => ({ ...it }));
  logEdits.set(logId, fn(items) || items);
}

/** Stage a change against a day's pending list and repaint. */
function editLogItems(logId, fn) {
  stageLogItems(logId, fn);
  renderLogsKeepingScroll();
}

// A re-render rebuilds the table, which would otherwise snap back to the first
// column and the top of the list mid-edit.
function renderLogsKeepingScroll() {
  renderTableKeepingScroll(logsContentEl, renderLogs);
}

/**
 * Day totals recomputed locally, so staged edits show before they're saved —
 * both a changed group list and a changed food list one level further down.
 */
function logItemsTotals(cols, items) {
  const totals = {};
  for (const c of cols) totals[c.key] = 0;
  for (const it of items) {
    const own = logEntryValues(cols, it);
    if (!own) continue;
    for (const c of cols) totals[c.key] += (own[c.key] || 0) * (it.qty || 1);
  }
  return totals;
}

/**
 * What one entry of a day contributes per unit — a group's totals, an ad-hoc
 * group's summed foods, or a lone food's own values. Null when the thing it
 * names is gone, which is the row that shows dashes.
 */
function logEntryValues(cols, it) {
  if (it.food) return logFoodByName(it.food)?.values || null;
  const group = it.custom ? customGroupOf(it) : logGroupById(it.group);
  return group ? logGroupTotals(cols, group) : null;
}

function logGroupByName(name) {
  const q = String(name).trim().toLowerCase();
  return logsData.groups.find((m) => m.name.toLowerCase() === q);
}

// Which groups are opened to their foods, keyed by day id and position —
// by position, not group id, since the same group can be listed twice in a day.
const logGroupsExpanded = new Set();

const logGroupKey = (logId, i) => `${logId}::${i}`;

/**
 * Removing a group shifts every later position down by one, which would leave
 * the open keys pointing at the wrong rows. Renumber them instead of clearing,
 * so the groups you had open stay open.
 */
function shiftLogGroupExpanded(logId, removed) {
  const prefix = `${logId}::`;
  const kept = [];
  for (const key of [...logGroupsExpanded]) {
    if (!key.startsWith(prefix)) continue;
    logGroupsExpanded.delete(key);
    const i = Number(key.slice(prefix.length));
    if (i === removed) continue;
    kept.push(i > removed ? i - 1 : i);
  }
  for (const i of kept) logGroupsExpanded.add(logGroupKey(logId, i));
}

/** The same, for an entry arriving: everything from `at` down moves one place. */
function insertLogGroupExpanded(logId, at) {
  const prefix = `${logId}::`;
  const kept = [];
  for (const key of [...logGroupsExpanded]) {
    if (!key.startsWith(prefix)) continue;
    logGroupsExpanded.delete(key);
    const i = Number(key.slice(prefix.length));
    kept.push(i >= at ? i + 1 : i);
  }
  for (const i of kept) logGroupsExpanded.add(logGroupKey(logId, i));
}

/**
 * The same renumbering for a group that moved rather than left: `order` is the
 * day's old positions in their new order, so a group that was open at old
 * position `was` is open at wherever that position now sits.
 */
function reindexLogGroupExpanded(logId, order) {
  const prefix = `${logId}::`;
  const open = new Set();
  for (const key of [...logGroupsExpanded]) {
    if (!key.startsWith(prefix)) continue;
    logGroupsExpanded.delete(key);
    open.add(Number(key.slice(prefix.length)));
  }
  order.forEach((was, now) => {
    if (open.has(was)) logGroupsExpanded.add(logGroupKey(logId, now));
  });
}

/**
 * A group inside a day: its name, as a second disclosure into the foods it
 * holds. No food summary alongside it — the foods have rows of their own one
 * level down, and repeating them as a line of text only crowded the name.
 *
 * There's no quantity here: a day lists what you ate, and eating
 * a group twice is two entries. Rows are addressed by position rather than group
 * id, since the same group can appear more than once.
 *
 * `editing` is the day being edited — Edit clicked, or anything staged against
 * it, adding a food or a group included. Only an ad-hoc group's name answers to
 * it — a saved group is renamed from its card on the Groups tab, and this row
 * only ever reads it.
 */
function logChildControls(logId, it, i, editing) {
  const group = it.custom ? customGroupOf(it) : logGroupById(it.group);
  const name = group ? group.name : it.group;
  const open = logGroupOpen(logId, i, group);
  const rowData = `data-id="${escapeHtml(logId)}" data-i="${i}"`;
  let body;
  if (logCopyingRow(logId, i)) {
    body = logCopyPicker(logId, i, name || "this meal", open, rowData);
  } else if (it.custom && editing) {
    // An ad-hoc group is named right here — it has no card on the Groups tab to
    // be renamed from, and the row is where you decide what it is.
    body = nameEditor({
      name,
      data: `data-log="${escapeHtml(logId)}" data-i="${i}"`,
      placeholder: "Meal",
      aria: "Name of this meal",
      caret: { act: "toggle-group-rows", data: rowData, open, child: true },
    });
  } else if (group) {
    // The caret takes the whole name with it: a saved group's is only ever
    // something to read, and an ad-hoc one's is too until the day's Edit is
    // open. Unnamed, it says what it is rather than showing an empty line.
    body = `<button class="ntable-disclosure ntable-disclosure-child" data-act="toggle-group-rows"
        ${rowData} type="button" aria-expanded="${open}">
        ${CARET_ICON}
        <span class="ntable-name-text${name ? "" : " ntable-name-untitled"}">${escapeHtml(name || "Meal")}</span>
      </button>`;
  } else {
    // A deleted group has nothing to expand into, but it still holds a place in
    // the day, so it keeps its grip like any other row.
    body = `<span class="ntable-name-text">${escapeHtml(name)}</span>`;
  }
  return `<span class="ntable-drag-name"><span class="ntable-drag-handle" data-kind="group"
      title="Drag to reorder this log's meals"
      aria-hidden="true">${DRAG_GRIP_ICON}</span><span class="ntable-drag-name-main">${body}</span></span>`;
}

/**
 * A food eaten on its own, at the same level as the day's groups. Its stepper is
 * the one a food inside a group gets, but what it edits is the day's own list,
 * so it's addressed by position like the group rows around it — and its grip
 * reorders the day rather than moving the food between groups.
 */
function logFoodItemRow(cols, logId, it, i, editing) {
  const food = logFoodByName(it.food);
  const data = `data-id="${escapeHtml(logId)}" data-i="${i}" data-item="${escapeHtml(it.food)}"`;
  return {
    // Dragged as a food, not as a row of the day: it can be picked up into a
    // group as readily as moved along the day, and both are the same gesture.
    nameHtml: foodRowName(it.food, food, { draggable: true }),
    // The amount reads as a figure until the day is being edited, and only then
    // turns into a stepper — a box on every row of a day you're only looking at
    // is an invitation to change it by accident.
    lead: foodLead(food, it.qty),
    leadHtml: editing
      ? { size: foodRowControls({ item: it.food, qty: it.qty }, food, data, { dec: "item-qty-dec", inc: "item-qty-inc" }) }
      : undefined,
    values: scaledFoodValues(cols, food, it.qty),
    actions: removeRowAction("remove-group", `data-id="${escapeHtml(logId)}" data-i="${i}"`, it.food),
    // Three roles: something to pick up, somewhere a food can land in the day's
    // list (at this position), and somewhere a group can land. The index
    // foodDragAttrs carries is this row's place in the day's own entries, since
    // that's the list a loose food is moved around in.
    attrs: `${foodDragAttrs("log", dayFoodOwner(logId), it.food, i)} ` +
      `data-mdrop-owner="${escapeHtml(logId)}" data-mdrop-index="${i}"`,
    variant: "child",
  };
}

/**
 * A group row wears two hats: its own grip reorders the day, and a food dropped
 * onto it moves into that group. Each addresses the row differently — a group by
 * its position in the day, a food by the group it lands in — so they keep
 * separate attribute prefixes and neither reads the other's addresses.
 */
function logGroupRowAttrs(logId, i, group, open) {
  return `data-mdrag-owner="${escapeHtml(logId)}" data-mdrag-index="${i}" ` +
    `data-mdrop-owner="${escapeHtml(logId)}" data-mdrop-index="${i}" ` +
    // A third role, for a food again: the day around this group. See
    // logDayEdgeTarget — the middle of the row goes into the group, the edges
    // either side of it.
    `data-fday-owner="${escapeHtml(dayFoodOwner(logId))}" data-fday-index="${i}"` +
    // Closed, it gives that middle up: with its foods out of sight there's
    // nothing to aim at inside it, and the whole row answers for the day.
    (open ? "" : ` data-fday-only="1"`) +
    (group ? ` ${foodDropAttrs("log", group.id, "start")}` : "");
}

/**
 * The day's own row and its add row, as the two ends of its list — for a group
 * being moved and, since a food can be dropped out of a group and into the day,
 * for a food as well.
 */
function logGroupDropAttrs(logId, pos) {
  return `data-mdrop-owner="${escapeHtml(logId)}" data-mdrop-pos="${pos}" ` +
    foodDropAttrs("log", dayFoodOwner(logId), pos);
}

/**
 * The day itself, as somewhere foods can live. A food with no group around it
 * belongs to the day's own list, so drags name that list as their owner — the
 * prefix keeps it apart from the group ids sharing the same attribute.
 */
const dayFoodOwner = (logId) => `day:${logId}`;
const logIdOfDayOwner = (owner) => (String(owner || "").startsWith("day:") ? String(owner).slice(4) : null);

// Staged, unsaved food lists by *group* id — a food row belongs to the group, not
// to the day it's being viewed through, so the same group listed twice in a
// day (or open in two days) stages one edit and shows it in both places.
const logFoodEdits = new Map();

/** A staged edit forces a group open — collapsing would strand it out of sight. */
function logGroupOpen(logId, i, group) {
  return logGroupsExpanded.has(logGroupKey(logId, i)) || (group ? logFoodEdits.has(group.id) : false);
}

/**
 * Stage a change against a group's pending food list and repaint. An ad-hoc
 * group's foods aren't shared with anything, so they stage in the day's own list
 * instead and go in with the day's Save rather than one of their own.
 */
function editLogGroupFoods(groupId, fn) {
  const custom = logCustomEntry(groupId);
  if (custom) {
    editLogItems(custom.log.id, (items) => {
      const entry = items[custom.index];
      if (!entry) return;
      // The entries were shallow-copied, so the food list has to be cloned
      // before it's edited or the change lands in the saved data too.
      const foods = (entry.items || []).map((f) => ({ ...f }));
      entry.items = fn(foods) || foods;
    });
    return;
  }
  const group = logGroupById(groupId);
  if (!group) return;
  const items = (logFoodEdits.get(groupId) || group.items || []).map((it) => ({ ...it }));
  logFoodEdits.set(groupId, fn(items) || items);
  renderLogsKeepingScroll();
}

/**
 * A group's totals, recomputed from its staged food list when it has one — and
 * always for an ad-hoc group, whose foods only exist in the day's list.
 */
function logGroupTotals(cols, group) {
  const pending = logFoodEdits.get(group.id);
  if (pending) return itemsTotals(cols, pending, logFoodByName);
  if (group.custom) return itemsTotals(cols, group.items, logFoodByName);
  return group.totals;
}

/** True when any group in a day's list has unsaved food edits staged. */
function logHasPendingFoods(items) {
  return items.some((it) => logFoodEdits.has(it.group));
}

/**
 * The saved groups this day has staged food edits against — what its own
 * Save has to write alongside the day, and what its Cancel has to drop. Both
 * lists are read: a group removed from the day since the edit was made still has
 * that edit staged, and Cancel is putting the day back to where both were.
 *
 * Ad-hoc groups aren't here — their foods live in the day's own list, so they
 * stage in `logEdits` and go in with it.
 */
function logStagedGroupIds(log) {
  const ids = new Set();
  for (const list of [logEdits.get(log.id), log.items]) {
    for (const it of list || []) if (it.group && logFoodEdits.has(it.group)) ids.add(it.group);
  }
  return [...ids];
}

/** "Rest day" → "Rest day copy", or the next free number when that's taken. */
function copyName(name, taken) {
  const base = `${name} copy`;
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

/**
 * A food inside a group inside a day — the third level, with the same
 * stepper the Groups tab gives it. Editing here edits the *group*, so it lands in
 * every day that uses it; that's what the Save button's title spells out.
 */
function logFoodControls(groupId, f, i) {
  return foodRowControls(
    f,
    logFoodByName(f.item),
    `data-group="${escapeHtml(groupId)}" data-i="${i}" data-item="${escapeHtml(f.item)}"`,
    { dec: "food-qty-dec", inc: "food-qty-inc" },
  );
}

const LOG_FOOD_LIST_ID = "log-food-options";

/** Same `datalist` reasoning as the Groups tab, over the logs' copy of foods. */
function logAddFoodInput(groupId) {
  return `<input class="ntable-add-input" list="${LOG_FOOD_LIST_ID}" type="text"
      data-group="${escapeHtml(groupId)}" placeholder="+ Add food…"
      autocomplete="off" aria-label="Add a food to this meal" />`;
}

function logFoodDatalist() {
  const foods = [...(logsData.foods || [])].sort((a, b) => a.name.localeCompare(b.name));
  return `<datalist id="${LOG_FOOD_LIST_ID}">${foods
    .map((f) => `<option value="${escapeHtml(f.name)}"></option>`)
    .join("")}</datalist>`;
}

/**
 * A group row's actions: Remove, which drops the group from the day — or, once
 * its foods have been edited, the Save/Cancel for those. Saving here writes the
 * group itself, which every day using it shares; that's what the button's
 * title spells out.
 */
function logGroupActions(logId, i, group, fallbackName) {
  if (group && logFoodEdits.has(group.id)) {
    const data = `data-group="${escapeHtml(group.id)}"`;
    return iconAction("save-group-foods", "save", `Save ${group.name} everywhere it's used`, data, "ntable-icon-go") +
      iconAction("cancel-group-foods", "cancel", "Cancel", data);
  }
  const data = `data-id="${escapeHtml(logId)}" data-i="${i}"`;
  const name = group?.name || fallbackName;
  // Picking where the copy goes: the only way out is choosing a day or backing
  // out, so Remove steps aside for the row's Cancel until one of the two lands.
  if (logCopyingRow(logId, i)) return iconAction("cancel-copy-group", "cancel", "Cancel", data);
  // Always somewhere to copy to, even on the only day on file: the day it's
  // already in counts, which is how you get the same group twice in a morning.
  return removeRowAction("remove-group", data, name) +
    iconAction("copy-group", "copy", `Copy ${name} into a log`, data);
}

// The group row whose "copy to…" picker is open, as { logId, i } — one at a
// time, and only while it's being chosen. Cleared by any repaint that could
// renumber the rows under it: a reload, or switching days.
let logCopyFrom = null;

const logCopyingRow = (logId, i) => logCopyFrom?.logId === logId && logCopyFrom.i === i;

/**
 * Where a copied group is going. A native `<select>` rather than a list of our
 * own, for the same reason the add rows use a `datalist`: the table's wrapper
 * clips anything absolutely positioned inside it, and the browser draws this
 * popup as chrome outside that box.
 *
 * It takes the name cell rather than the actions column, whose width is measured
 * from its contents and pins every row to the left edge — a picker there would
 * widen that column down the whole table.
 */
function logCopyPicker(logId, i, name, open, rowData) {
  // The day it's already in is on the list, said so plainly — a second copy of a
  // group within one day is a real thing to want, and leaving it out would read
  // as the copy having failed.
  const targets = [...logsData.logs].sort((a, b) => a.name.localeCompare(b.name));
  return `<span class="ntable-name-edit">
    <button class="ntable-disclosure ntable-disclosure-caret ntable-disclosure-child"
      data-act="toggle-group-rows" ${rowData} type="button" aria-expanded="${open}"
      aria-label="Show foods">${CARET_ICON}</button>
    <select class="ntable-copy-select" data-id="${escapeHtml(logId)}" data-i="${i}"
      aria-label="Log to copy ${escapeHtml(name)} into">
      <option value="">Copy ${escapeHtml(name)} into…</option>
      ${targets.map((m) => `<option value="${escapeHtml(m.id)}">
        ${escapeHtml(m.name)}${m.id === logId ? " (this one, again)" : ""}</option>`).join("")}
    </select>
  </span>`;
}

/**
 * A day's entry, copied for another day. An ad-hoc group belongs to whichever
 * day holds it and is found by scanning them all for its id (logCustomEntry),
 * so the copy needs one of its own — two days sharing an id would both answer
 * for the same row, and editing either would land in the first.
 */
function copyLogEntry(it) {
  if (!it.custom) return { ...it };
  return { ...it, custom: newCustomGroupId(), items: (it.items || []).map((f) => ({ ...f })) };
}

/** Show a day in the table, keeping the picker and what's stored in step. */
function selectLog(id) {
  logsSelectedId = id;
  logCopyFrom = null;
  try { localStorage.setItem("dash-logs-selected", id); } catch {}
  renderLogs();
}

/**
 * The food rows under one group of a day — the steppers, a Remove per row,
 * and the picker for another food, always live, exactly as the Groups tab has
 * them. Nothing here reaches the server: edits stage against the group until the
 * Save in the group row's own actions.
 *
 * The nutrient cells carry the group's quantity, so they read as this day's
 * contribution; the stepper stays in the group's own amounts, since that's what
 * gets saved back to the group.
 */
function logGrandchildRows(cols, group, groupQty, editing) {
  const items = logFoodEdits.get(group.id) || group.items || [];
  const rows = items.map((f, i) => ({
    nameHtml: foodRowName(f.item, logFoodByName(f.item), { draggable: true }),
    // The stepper edits the group's own amount, so it takes the Serving column;
    // the unit beside it still describes what this day contributes. Outside the
    // day's edit mode the amount is a figure to read, same as every other row.
    lead: foodLead(logFoodByName(f.item), (f.qty || 1) * groupQty),
    leadHtml: editing ? { size: logFoodControls(group.id, f, i) } : undefined,
    values: scaledFoodValues(cols, logFoodByName(f.item), (f.qty || 1) * groupQty),
    // Out in the actions column with every other row's Remove, and addressed by
    // position, since the group can list the same food twice.
    actions: removeRowAction(
      "remove-group-food",
      `data-group="${escapeHtml(group.id)}" data-i="${i}"`,
      f.item,
    ),
    attrs: foodDragAttrs("log", group.id, f.item, i),
    variant: "grandchild",
  }));
  rows.push({
    nameHtml: logAddFoodInput(group.id),
    values: null,
    actions: "",
    attrs: foodDropAttrs("log", group.id, "end"),
    variant: "food-add",
  });
  return rows;
}

const LOG_GROUP_LIST_ID = "log-group-options";

/**
 * The day's add row: a food on its own, or a new group. Separate controls rather
 * than one picker that guesses — a group has no name to type yet, and a food is
 * chosen by name from the table.
 *
 * The saved-group picker sits behind SAVED_GROUPS_ENABLED. With it off, every
 * group made here belongs to this day alone.
 */
function logAddRow(logId) {
  const id = escapeHtml(logId);
  return `<span class="ntable-add-row">
    ${SAVED_GROUPS_ENABLED ? `<input class="ntable-add-input" list="${LOG_GROUP_LIST_ID}" type="text"
      data-log="${id}" placeholder="+ Add meal…"
      autocomplete="off" aria-label="Add a saved meal to this log" />` : ""}
    <input class="ntable-add-input" list="${LOG_FOOD_LIST_ID}" type="text"
      data-log-food="${id}" placeholder="+ Add food…"
      autocomplete="off" aria-label="Add a food straight to this log" />
    <button class="ntable-add-btn" data-act="add-custom" data-id="${id}" type="button"
      title="A meal that lives in this log only">+ Meal</button>
  </span>`;
}

/** One shared option list for every add row on the tab. */
function logGroupDatalist() {
  const groups = [...(logsData.groups || [])].sort((a, b) => a.name.localeCompare(b.name));
  return `<datalist id="${LOG_GROUP_LIST_ID}">${groups
    .map((m) => `<option value="${escapeHtml(m.name)}"></option>`)
    .join("")}</datalist>`;
}

/**
 * Persist a day's list, then refresh the tab. `name` is the renamed one
 * when the row was being renamed too — one write covers both.
 */
async function saveLogItems(log, items, name = log.name) {
  const res = await fetch("/api/food-logs/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: log.id, name, notes: log.notes || "", items }),
  });
  if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
  logsLoaded = false;
  await loadLogs();
}

// Which day the table is showing. Remembered between visits — it's the
// day you're working on, not a transient filter.
let logsSelectedId = null;
try { logsSelectedId = localStorage.getItem("dash-logs-selected"); } catch {}

/** The chosen day, falling back to the first when it's gone or unset. */
function currentLogId(sorted) {
  if (logsSelectedId && sorted.some((m) => m.id === logsSelectedId)) return logsSelectedId;
  return sorted[0]?.id || null;
}

/**
 * Which day the table is showing, chosen from the day's own row. The row is that
 * day's totals line, so its name cell is where the day is already being read —
 * switching from there beats a control above the table that repeats the name
 * sitting right under it. A native `<select>` for the same reason the copy
 * picker uses one: the table's wrapper clips anything absolutely positioned
 * inside it, and the browser draws this popup as chrome outside that box.
 */
function logRowPicker(sorted, selectedId) {
  return `<select class="ntable-log-select" aria-label="Log to show">
    ${sorted
      .map((m) => `<option value="${escapeHtml(m.id)}"${m.id === selectedId ? " selected" : ""}>${escapeHtml(m.name)}</option>`)
      .join("")}
  </select>`;
}

/**
 * What expand/collapse-all acts on. In the table that's the groups of the day on
 * screen — the day row has no caret of its own, so its groups are the only
 * thing left to open. The cards view still stacks every day, so there it
 * stays the days themselves.
 */
function logsExpandAllTarget() {
  if (!logsView.isTable()) return { records: logsData.logs, expanded: logsExpanded };
  const sorted = [...logsData.logs].sort((a, b) => a.name.localeCompare(b.name));
  const log = sorted.find((m) => m.id === currentLogId(sorted));
  const items = log ? logEdits.get(log.id) || log.items || [] : [];
  return {
    // A food on its own has nothing under it, so it isn't one of the rows
    // "expand all" is counting.
    records: items.flatMap((it, i) => (logItemKind(it) === "food" ? [] : [{ id: logGroupKey(log.id, i) }])),
    expanded: logGroupsExpanded,
  };
}

function renderLogs() {
  logsCountEl.textContent = String(logsData.logs.length);
  const expandAll = logsExpandAllTarget();
  syncExpandAllBtn(logsExpandAllBtn, expandAll.records, expandAll.expanded);
  // Every row the cog governs is part of the table's header, so it only has
  // something to act on in table view — and only once there's a table to put a
  // header on. Set ahead of the early returns below so deleting the last plan
  // takes it away.
  logsConfigEl.hidden = !logsView.isTable() || logsData.logs.length === 0;
  if (logsData.logs.length === 0) {
    // No longer conditional on having something to build from: a day can be
    // created from its name alone and filled in from the table afterwards.
    logsContentEl.innerHTML = `<div class="empty">Nothing logged yet. Use “New log” to name one — ${
      SAVED_GROUPS_ENABLED ? "meals" : "foods"
    } can go in now or later.</div>`;
    return;
  }
  const sorted = [...logsData.logs].sort((a, b) => a.name.localeCompare(b.name));
  if (!logsView.isTable()) {
    logsContentEl.innerHTML = sorted.map(renderLogCard).join("");
    return;
  }
  // One day at a time, chosen from the picker in its own row — several days
  // stacked in one grid read as one long list of groups with no clear owner.
  // Nested one level deeper than the Groups tab: totals for the day, then one
  // row per group at its quantity, then — opening a group — its foods, then a
  // picker row for adding another group. Edits stage in `logEdits` and only hit
  // the server on Save, so the rows render from the pending list whenever one
  // exists. The targets ride pinned under the headers as the yardstick.
  const cols = tableColsFromNames(logsData.nutrientCols);
  // The day's own totals get judged against the daily floor and ceiling from
  // raw.csv — short of one or past the other is coloured in the row itself,
  // unless the cog has the colours off. Only the day's row either way: a group
  // is a part of a day, so reading a part of it against a whole day's bounds
  // would flag nearly every one of them.
  const dayBounds = logsConfig.logColors && (logsData.targetsMin || logsData.targetsMax)
    ? { min: logsData.targetsMin?.values, max: logsData.targetsMax?.values }
    : null;
  const rows = [];
  for (const m of sorted.filter((x) => x.id === currentLogId(sorted))) {
    const pending = logEdits.get(m.id);
    const items = pending || m.items || [];
    const staged = logHasPendingFoods(items);
    // One state for the whole day: Edit, a staged change anywhere beneath it,
    // or something just added to it — any of the three opens the same mode, and
    // every control on every row answers to it. Adding a food or a group is an
    // edit like any other, so it brings out the name boxes too rather than
    // leaving you to click Edit for the half of the mode it didn't open.
    const editing = Boolean(pending) || logNameEdits.has(m.id) || staged;
    rows.push({
      // Not a disclosure. The table shows one day only, so a caret here would
      // have nothing to reveal — the row is the totals line for the groups
      // listed under it, which are always listed. Instead the name cell is the
      // picker for which day that is, and editing turns it into a box, the same
      // as a group's row does.
      name: m.name,
      nameHtml: editing
        ? nameEditor({
            // Nothing staged yet means the name is untouched — the box opens on
            // what's saved, and only typing in it stages a rename.
            name: logNameEdits.get(m.id) ?? m.name,
            data: `data-id="${escapeHtml(m.id)}"`,
            aria: "Log name",
          })
        : logRowPicker(sorted, m.id),
      values: pending || staged ? logItemsTotals(cols, items) : m.totals,
      bounds: dayBounds,
      // The day's Save/Cancel covers everything staged beneath it, foods in its
      // groups included — so staged foods bring it out too, and Cancel here puts
      // the whole day back the way it was.
      actions: editing
        ? editRowActions(m.id)
        : rowActions(m.id, iconAction("duplicate", "copy", `Duplicate ${m.name}`, `data-id="${escapeHtml(m.id)}"`)),
      // A group dragged onto the day's own row goes to the top of it.
      attrs: logGroupDropAttrs(m.id, "start"),
      variant: "parent",
    });
    items.forEach((it, i) => {
      // A food put straight in the day has no foods of its own to open into, so
      // it's a row and nothing more.
      if (logItemKind(it) === "food") {
        rows.push(logFoodItemRow(cols, m.id, it, i, editing));
        return;
      }
      const group = it.custom ? customGroupOf(it) : logGroupById(it.group);
      const groupOpen = logGroupOpen(m.id, i, group);
      rows.push({
        nameHtml: logChildControls(m.id, it, i, editing),
        // No "unsaved" caption: the Save/Cancel pair appears in this row's own
        // actions the moment there's something to save, which says it already.
        values: scaledValues(cols, group ? logGroupTotals(cols, group) : null, it.qty),
        // Save/Cancel for this group's staged foods, and Remove — which drops
        // the group from the day rather than changing the group itself.
        actions: logGroupActions(m.id, i, group, it.custom ? "custom group" : it.group),
        // Both roles at once: this group's place in the day, and a landing spot
        // for a food dragged in — which goes to the top of the group, where the
        // line lands.
        attrs: logGroupRowAttrs(m.id, i, group, groupOpen),
        variant: "child",
      });
      // Third level: open a group and its foods sit under it, each scaled to
      // what this day actually contains.
      if (!group || !groupOpen) return;
      rows.push(...logGrandchildRows(cols, group, it.qty, editing));
    });
    rows.push({
      nameHtml: logAddRow(m.id),
      values: null,
      actions: "",
      attrs: logGroupDropAttrs(m.id, "end"),
      variant: "add",
    });
  }
  // The same three-row band the Food tab pins, off the same raw.csv rows and
  // unpinned a row at a time from this tab's own cog — max, target, min, high to
  // low, so the three read as one descending range. No "target" caption on any
  // of them: they're named Daily Nutrition Target and friends, and they're the
  // only coloured band under the header. The min and max are the pair the day
  // row above is flagged against, so showing them makes those yellows and
  // oranges readable rather than just present.
  const pinned = [
    logsConfig.max ? ["target-max", logsData.targetsMax] : null,
    logsConfig.target ? ["target", logsData.targets] : null,
    logsConfig.min ? ["target-min", logsData.targetsMin] : null,
  ]
    .filter((entry) => entry?.[1])
    .map(([variant, row]) => ({ name: row.name, values: row.values, variant }));
  logsContentEl.innerHTML =
    (SAVED_GROUPS_ENABLED ? logGroupDatalist() : "") + logFoodDatalist() +
    renderNutrientTable(cols, rows, { pinned, stickyParents: true });
  syncPinnedTableRows(logsContentEl);
}

const logsView = createViewToggle(
  document.getElementById("logs-view"),
  "dash-logs-view",
  () => renderLogs(),
);

const logsExpandAllBtn = document.getElementById("logs-expand-all");
logsExpandAllBtn?.addEventListener("click", () => {
  const { records, expanded } = logsExpandAllTarget();
  toggleExpandAll(records, expanded, renderLogs);
});

// A group added twice is listed twice — the same group at two points in the day.
logsContentEl?.addEventListener("change", (e) => {
  // Switching days from the day row's own name cell. Anything staged stays
  // staged against the day it was staged on — selectLog only changes which one
  // is on screen — so a half-finished edit survives a look at another day.
  const logSel = e.target.closest(".ntable-log-select");
  if (logSel) {
    selectLog(logSel.value);
    return;
  }
  // A group being copied into a day — another one, or the one it's already in.
  // Staged rather than written: everything else on this tab waits for a Save,
  // and the picker follows the copy across so it can be looked at first.
  const copySel = e.target.closest(".ntable-copy-select");
  if (copySel) {
    const from = copySel.dataset.id;
    const to = copySel.value;
    const entry = logDayItems(from)[Number(copySel.dataset.i)];
    logCopyFrom = null;
    if (!to || !entry) {
      renderLogsKeepingScroll();
      return;
    }
    stageLogItems(to, (items) => { items.push(copyLogEntry(entry)); });
    // Copied into the day already on screen: nothing to switch to, and the row
    // it came from should stay where it is rather than the table jumping.
    if (to === from) renderLogsKeepingScroll();
    else selectLog(to);
    return;
  }
  // Amount edits on a third-level food row. They address the group, so they run
  // ahead of the day-level inputs below.
  const qtyInput = e.target.closest(".ntable-qty-input");
  if (qtyInput) {
    const qty = typedQty(logFoodByName(qtyInput.dataset.item), qtyInput.value);
    // Either way the row is addressed by position (data-i); what differs is
    // whose list it counts in — a group's foods, or the day's own entries.
    if (qtyInput.dataset.group) {
      editLogGroupFoods(qtyInput.dataset.group, (items) => {
        const it = items[Number(qtyInput.dataset.i)];
        if (it) it.qty = qty;
      });
    } else {
      editLogItems(qtyInput.dataset.id, (items) => {
        const it = items[Number(qtyInput.dataset.i)];
        if (it) it.qty = qty;
      });
    }
    return;
  }
  const add = e.target.closest(".ntable-add-input");
  if (add) commitLogAddInput(add);
});

/** One of the day's add rows, committed. */
function commitLogAddInput(add) {
  if (!add.value.trim()) return;
  // A food dropped straight into the day rather than into one of its groups.
  if (add.dataset.logFood) {
    const food = logFoodByName(add.value.trim());
    const logId = add.dataset.logFood;
    add.value = "";
    if (!food) return;
    // Its own entry every time, the same as a group: the same food twice in a
    // day is two helpings of it, at two points in the day, not one bigger one.
    editLogItems(logId, (items) => {
      items.push({ food: food.name, qty: 1 });
    });
    return;
  }
  // Three kinds of picker share the class: a group into a day (data-log),
  // a food into the day itself (data-log-food, handled above), and a food into
  // one of its groups (data-group).
  if (add.dataset.group) {
    // Its own line every time, the same as adding one to the day: a food already
    // in the group can be listed again — two eggs at two points in the meal —
    // rather than folded into the row that's already there.
    const food = logFoodByName(add.value.trim());
    add.value = "";
    if (!food) return;
    editLogGroupFoods(add.dataset.group, (items) => {
      items.push({ item: food.name, qty: 1 });
    });
    return;
  }
  // Only commit on an exact group — a half-typed name shouldn't add anything.
  const group = logGroupByName(add.value);
  if (!group) {
    add.value = "";
    return;
  }
  add.value = "";
  // Block body on purpose: `push` returns a length, and editLogItems takes a
  // returned value as the new list.
  editLogItems(add.dataset.log, (items) => {
    items.push({ group: group.id, qty: 1 });
    // Its day is open, so the new group opens with it.
    logGroupsExpanded.add(logGroupKey(add.dataset.log, items.length - 1));
  });
}

// Names are staged as they're typed and never repaint: the rows' numbers don't
// depend on them, and a re-render would take the caret out of the box — or
// replace the Save button between the blur and the click landing on it. Two
// kinds share the box: the day's own name (data-id) and an ad-hoc group's
// (data-log + data-i).
logsContentEl?.addEventListener("input", (e) => {
  // A food or group taken from the datalist popup goes in as soon as it's
  // picked — see isDatalistPick.
  const add = e.target.closest(".ntable-add-input");
  if (add) {
    if (isDatalistPick(e)) commitLogAddInput(add);
    return;
  }
  const nameInput = e.target.closest(".ntable-name-input");
  if (!nameInput) return;
  if (nameInput.dataset.id) {
    logNameEdits.set(nameInput.dataset.id, nameInput.value);
    return;
  }
  stageLogItems(nameInput.dataset.log, (items) => {
    const it = items[Number(nameInput.dataset.i)];
    if (it) it.name = nameInput.value;
  });
  // Renaming a group that was already saved is the day's first unsaved change,
  // so its Save/Cancel has to appear — but only that cell, or the box being
  // typed in would be rebuilt underneath the caret.
  syncLogRowActions(nameInput.dataset.log);
});

/** Swap the day row's actions for Save/Cancel once it has something to save. */
function syncLogRowActions(logId) {
  if (!logEdits.has(logId) && !logNameEdits.has(logId)) return;
  const cell = logsContentEl?.querySelector(".ntable-row-parent .ntable-actions");
  if (cell) cell.innerHTML = editRowActions(logId);
}

// Enter commits, Escape drops the day's staged edits — the two things the
// keyboard should do in a box with Save and Cancel beside it.
logsContentEl?.addEventListener("keydown", (e) => {
  const nameInput = e.target.closest(".ntable-name-input");
  if (!nameInput || (e.key !== "Enter" && e.key !== "Escape")) return;
  e.preventDefault();
  const act = e.key === "Enter" ? "save-edits" : "cancel-edits";
  logsContentEl.querySelector(`.ntable-row-parent [data-act="${act}"]`)?.click();
});

/**
 * The third level's own controls. They address a group rather than a day —
 * the food belongs to the group — so they're handled before the log lookup and
 * carry `data-group` instead of `data-id`.
 */
async function handleLogFoodAction(actBtn) {
  const group = logGroupById(actBtn.dataset.group);
  if (!group) return;
  const act = actBtn.dataset.act;
  // The row's place in the group's list. By name this would take the first of
  // two lines holding the same food, whichever of them was clicked.
  const i = Number(actBtn.dataset.i);
  // Staged edits — nothing reaches the server until Save.
  if (act === "food-qty-inc" || act === "food-qty-dec") {
    const dir = act === "food-qty-inc" ? 1 : -1;
    const food = logFoodByName(actBtn.dataset.item);
    editLogGroupFoods(group.id, (items) => {
      const it = items[i];
      if (it) it.qty = steppedQty(food, it.qty, dir);
    });
    return;
  }
  if (act === "remove-group-food") {
    editLogGroupFoods(group.id, (items) => items.filter((_, n) => n !== i));
    return;
  }
  if (act === "cancel-group-foods") {
    logFoodEdits.delete(group.id);
    renderLogsKeepingScroll();
    return;
  }
  if (act === "save-group-foods") {
    const items = logFoodEdits.get(group.id);
    // The button only exists while something is staged, so this is belt and
    // braces — a second click on one already saving.
    if (!items) return;
    setBtnBusy(actBtn, "Saving…");
    logFoodEdits.delete(group.id);
    try {
      // Writes the group itself, then reloads the groups and — through
      // invalidateNutritionBelow — this tab, so every day using it repaints.
      await saveGroupItems(group, items);
    } catch (err) {
      logFoodEdits.set(group.id, items); // put the edits back so they aren't lost
      renderLogsKeepingScroll();
      console.error(err);
    }
  }
}

logsContentEl?.addEventListener("click", async (e) => {
  const actBtn = e.target.closest("[data-act]");
  if (actBtn) {
    if (actBtn.dataset.group) {
      await handleLogFoodAction(actBtn);
      return;
    }
    const log = logsData.logs.find((m) => m.id === actBtn.dataset.id);
    if (!log) return;
    const act = actBtn.dataset.act;
    // No "toggle-rows" here: the table's day row isn't a disclosure, and
    // the cards view opens its own through .group-card-head at the foot of this
    // handler.
    if (act === "toggle-group-rows") {
      const key = logGroupKey(log.id, Number(actBtn.dataset.i));
      if (logGroupsExpanded.has(key)) logGroupsExpanded.delete(key);
      else logGroupsExpanded.add(key);
      renderLogsKeepingScroll();
      return;
    }
    // A group made up on the spot: it belongs to this day only, so it starts
    // empty and open, with the caret in its name box ready to be told what it is.
    if (act === "add-custom") {
      // Adding to the day opens its edit mode by itself now, so the name box
      // this focuses into is already there by the time the repaint lands.
      let at = -1;
      editLogItems(log.id, (items) => {
        at = items.length;
        items.push({ custom: newCustomGroupId(), name: "", items: [], qty: 1 });
        logGroupsExpanded.add(logGroupKey(log.id, at));
      });
      logsContentEl.querySelector(`.ntable-name-input[data-i="${at}"]`)?.focus();
      return;
    }
    // Copying this group into another day. The picker takes over the row's name
    // cell until a day is chosen or the row's Cancel backs out.
    if (act === "copy-group") {
      logCopyFrom = { logId: log.id, i: Number(actBtn.dataset.i) };
      renderLogsKeepingScroll();
      logsContentEl.querySelector(".ntable-copy-select")?.focus();
      return;
    }
    if (act === "cancel-copy-group") {
      logCopyFrom = null;
      renderLogsKeepingScroll();
      return;
    }
    // A day of its own with the same list — the groups by reference, since
    // they're shared, and the ad-hoc ones copied outright with new ids.
    if (act === "duplicate") {
      setBtnBusy(actBtn, "Duplicating…");
      try {
        const res = await fetch("/api/food-logs/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: copyName(log.name, logsData.logs.map((m) => m.name)),
            notes: log.notes || "",
            items: (log.items || []).map(copyLogEntry),
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        logsLoaded = false;
        await loadLogs();
        // Straight to the copy — it's the one you're about to change, and it's
        // otherwise indistinguishable from the original but for its name.
        if (data.log?.id) selectLog(data.log.id);
      } catch (err) {
        setBtnBusy(actBtn, "Duplicate failed", { failed: true });
        console.error(err);
      }
      return;
    }
    // The stepper on a food sitting in the day's own list — the same edit a
    // group's food gets, one level up.
    if (act === "item-qty-inc" || act === "item-qty-dec") {
      const dir = act === "item-qty-inc" ? 1 : -1;
      const food = logFoodByName(actBtn.dataset.item);
      editLogItems(log.id, (items) => {
        const it = items[Number(actBtn.dataset.i)];
        if (it) it.qty = steppedQty(food, it.qty, dir);
      });
      return;
    }
    // Staged edits — nothing reaches the server until Save.
    if (act === "remove-group") {
      // By position, not group id: the same group can be listed more than once.
      const i = Number(actBtn.dataset.i);
      shiftLogGroupExpanded(log.id, i);
      editLogItems(log.id, (items) => items.filter((_, n) => n !== i));
      return;
    }
    if (act === "cancel-edits") {
      // The day's Cancel is the whole day's: a group's foods are edited from
      // these rows, so leaving those staged would put the row back into Save the
      // moment it repainted, with no obvious way to be rid of it.
      for (const id of logStagedGroupIds(log)) logFoodEdits.delete(id);
      logEdits.delete(log.id);
      logNameEdits.delete(log.id);
      logCopyFrom = null;
      renderLogsKeepingScroll();
      return;
    }
    if (act === "save-edits") {
      const items = logEdits.get(log.id);
      const name = logNameEdits.get(log.id);
      // Each of these is a group of its own — shared with every day using it, so
      // written on its own rather than folded into the day's list.
      const foods = new Map(logStagedGroupIds(log).map((id) => [id, logFoodEdits.get(id)]));
      // The button only exists while something is staged — this catches a second
      // click on a Save already in flight.
      if (!items && name === undefined && foods.size === 0) return;
      setBtnBusy(actBtn, "Saving…");
      logEdits.delete(log.id);
      logNameEdits.delete(log.id);
      for (const id of foods.keys()) logFoodEdits.delete(id);
      try {
        // Groups first, then the day — whose reload reads the totals they just
        // changed. One reload for the lot; see postGroupItems.
        for (const [id, list] of foods) {
          const group = logsData.groups.find((g) => g.id === id);
          if (group) await postGroupItems(group, list);
        }
        // A name typed away to nothing isn't a rename — the server would reject
        // it, and the row has nowhere to say so, so the old name stands.
        await saveLogItems(log, items || log.items || [], name?.trim() || log.name);
        // saveLogItems has already refetched this tab; the two below it read the
        // same groups, so drop their caches and let them refetch on arrival —
        // invalidateNutritionBelow would refetch the logs a second time.
        if (foods.size) {
          groupsLoaded = false;
          compareDataRequested = false;
        }
      } catch (err) {
        // Put the edits back so they aren't lost.
        if (items) logEdits.set(log.id, items);
        if (name !== undefined) logNameEdits.set(log.id, name);
        for (const [id, list] of foods) logFoodEdits.set(id, list);
        renderLogsKeepingScroll();
        console.error(err);
      }
      return;
    }
    if (act === "edit") {
      // In the table the row is the editor — the name turns into a box, the
      // actions into Save/Cancel. The cards view has no such row, so there Edit
      // still opens the builder, which is also where the group list is composed.
      if (logsView.isTable()) {
        logNameEdits.set(log.id, log.name);
        renderLogsKeepingScroll();
        logsContentEl.querySelector(`.ntable-name-input[data-id="${CSS.escape(log.id)}"]`)?.focus();
        return;
      }
      openLogBuilder(log);
      logBuilderEl.scrollIntoView({ block: "nearest" });
    } else if (act === "delete") {
      const count = (log.items || []).length;
      if (!confirm(`Delete the log ${log.name}? It has ${count} ${count === 1 ? "entry" : "entries"} in it.`)) return;
      setBtnBusy(actBtn, "Deleting…");
      // Taken before the write: what comes back from a reload won't have it.
      const deleted = { id: log.id, name: log.name, notes: log.notes || "", items: log.items || [] };
      try {
        const res = await fetch("/api/food-logs/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: log.id }),
        });
        if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
        setLogUndo(deleted);
        logsLoaded = false;
        await loadLogs();
      } catch (err) {
        setBtnBusy(actBtn, "Delete failed", { failed: true });
        console.error(err);
      }
    }
    return;
  }
  const head = e.target.closest(".group-card-head");
  if (!head) return;
  const id = head.closest(".group-card").dataset.id;
  if (logsExpanded.has(id)) logsExpanded.delete(id);
  else logsExpanded.add(id);
  renderLogs();
});

async function loadLogs() {
  if (logsLoaded) return;
  logsLoaded = true;
  // Rows are addressed by position, and a reload can renumber them — so an open
  // "copy to…" picker can't be pointing at the same group afterwards.
  logCopyFrom = null;
  try {
    const res = await fetch("/api/food-logs", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    logsData = await res.json();
    renderLogs();
  } catch (err) {
    logsLoaded = false;
    logsContentEl.innerHTML = `<div class="empty">Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}

// ── Meal Log tab helper ──────────────────────────────
// The same panel as the Food tab's, over the days rather than the foods: review
// the day on screen against the daily target, edit it, or build a new one
// out of the table. A proposal is a whole day — costed by the server against the
// same CSV this tab renders — and goes in through the ordinary save.
let logAiProposals = [];
let logAiTargets = null;
// Set at the bottom of this block; openLogBuilder closes the panel through it.
let logAiPanel = null;

/** Calories/macros for a proposed day, beside the target row where there is one. */
function renderLogAiTotals(totals, previousTotals) {
  return GROUP_SUMMARY_COLS.map(([col, units]) => {
    const label = col.replace(/\s*\([^)]*\)$/, "");
    const now = totals[col] || 0;
    const before = previousTotals ? previousTotals[col] || 0 : null;
    const target = logAiTargets ? logAiTargets.values[col] : null;
    const moved = before !== null && Math.round(before * 10) !== Math.round(now * 10);
    return `<div class="nutrition-diff-cell">
      <span class="nutrition-diff-label">${escapeHtml(label)}</span>
      <span class="nutrition-diff-values">
        ${moved ? `<span class="nutrition-diff-from">${fmtNutrient(before)}</span><span class="nutrition-diff-arrow">→</span>` : ""}
        <span class="nutrition-diff-to">${fmtNutrient(now)}<span class="nutrition-cell-units">${units}</span></span>
      </span>
      ${target ? `<span class="nutrition-diff-target">of ${fmtNutrient(target)} target</span>` : ""}
    </div>`;
  }).join("");
}

/** The day itself — sections indented under their own line, as the tab shows them. */
function renderLogAiItems(resolved) {
  return resolved
    .map((r) => {
      const kids = (r.foods || [])
        .map((f) => `<li class="nutrition-plan-food">${fmtNutrient(f.qty)}× ${escapeHtml(f.item)}</li>`)
        .join("");
      return `<li class="nutrition-plan-item">
        <span class="nutrition-plan-name">${fmtNutrient(r.qty)}× ${escapeHtml(r.name)}</span>
        <span class="nutrition-plan-cal">${fmtNutrient(r.calories * (r.qty || 1))} cal</span>
        ${kids ? `<ul class="nutrition-plan-foods">${kids}</ul>` : ""}
      </li>`;
    })
    .join("");
}

const LOG_AI_CHANGE_LABEL = { added: "added", removed: "removed", qty: "amount" };

function renderLogAiProposal(p, i) {
  const changes = p.changes
    .map(
      (c) => `<li class="nutrition-plan-change" data-kind="${c.kind}">
        <span class="nutrition-plan-change-kind">${LOG_AI_CHANGE_LABEL[c.kind]}</span>
        ${escapeHtml(c.name)}${c.kind === "qty" ? ` ${fmtNutrient(c.from)}× → ${fmtNutrient(c.to)}×` : ""}
      </li>`,
    )
    .join("");

  return `<div class="nutrition-diff" data-index="${i}">
    <div class="nutrition-diff-head">
      <span class="nutrition-diff-name">${escapeHtml(p.name)}</span>
      <span class="nutrition-diff-badge${p.isNew ? " is-new" : ""}">${p.isNew ? "new log" : "replaces this log"}</span>
      <span class="nutrition-diff-count">${p.resolved.length} item${p.resolved.length === 1 ? "" : "s"}</span>
    </div>
    ${p.reason ? `<div class="nutrition-diff-reason">${escapeHtml(p.reason)}</div>` : ""}
    ${p.missingFoods.length ? `<div class="nutrition-review-dupe">Not in the food table, so left out and counted as nothing: ${escapeHtml(p.missingFoods.join(", "))}</div>` : ""}
    <ul class="nutrition-plan">${renderLogAiItems(p.resolved)}</ul>
    <div class="nutrition-diff-grid">${renderLogAiTotals(p.totals, p.previousTotals)}</div>
    ${changes ? `<ul class="nutrition-plan-changes">${changes}</ul>` : ""}
    <div class="nutrition-review-actions">
      <button class="nutrition-save-btn nutrition-plan-apply" type="button" data-index="${i}">${p.isNew ? "Create log" : "Replace log"}</button>
      <span class="nutrition-add-status" data-status="${i}"></span>
    </div>
  </div>`;
}

function renderLogAiResult(data) {
  const answer = data.answer || "";
  const body = answer
    ? window.marked
      ? window.marked.parse(answer)
      : `<pre>${escapeHtml(answer)}</pre>`
    : `<p class="muted">No answer came back.</p>`;
  const sources = Array.isArray(data.sources) ? data.sources : [];
  return `
    <div class="nutrition-ai-answer">${body}</div>
    ${sources.length ? `<div class="nutrition-review-sources">Sources: ${escapeHtml(sources.join(" · "))}</div>` : ""}
    ${logAiProposals.length ? `<div class="nutrition-ai-proposals">
      <h4 class="nutrition-ai-proposals-title">Proposed logs — nothing is saved until you apply</h4>
      ${logAiProposals.map(renderLogAiProposal).join("")}
    </div>` : ""}`;
}

async function applyLogAiProposal(index, resultEl) {
  const p = logAiProposals[index];
  if (!p) return;
  const card = resultEl.querySelector(`.nutrition-diff[data-index="${index}"]`);
  const btn = card?.querySelector(".nutrition-plan-apply");
  const statusEl = card?.querySelector(`[data-status="${index}"]`);
  if (btn) btn.disabled = true;
  if (statusEl) statusEl.textContent = "Saving…";
  try {
    const res = await fetch("/api/food-logs/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // No id means create; saveLog writes a day back under the id it's given.
      body: JSON.stringify({ id: p.id || undefined, name: p.name, notes: p.notes, items: p.items }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (statusEl) statusEl.textContent = `Saved ${data.log?.name || p.name}.`;
    if (btn) btn.textContent = "Applied";
    card?.classList.add("is-applied");
    clearAiPanelWhenAllApplied(logAiPanel, resultEl);
    logsLoaded = false;
    await loadLogs();
    // Land on what was just written — a new day is otherwise saved out of sight.
    if (data.log?.id) selectLog(data.log.id);
  } catch (err) {
    if (btn) btn.disabled = false;
    if (statusEl) statusEl.textContent = err.message;
  }
}

logAiPanel = createAiPanel({
  prefix: "log-ai",
  endpoint: "/api/food-logs/assist",
  busyText: "Working through the log — this can take a minute or two.",
  // Same rule as the builder's own toggle: opening this closes the draft below,
  // unsaved edits and all.
  onOpen: () => { if (!logBuilderEl.hidden) closeLogBuilder(); },
  // "This day" is whichever day the tab is showing.
  body: () => ({ logId: currentLogId([...logsData.logs].sort((a, b) => a.name.localeCompare(b.name))) || "" }),
  onData: (data) => {
    logAiProposals = Array.isArray(data?.templates) ? data.templates : [];
    logAiTargets = data?.targets || null;
  },
  render: renderLogAiResult,
  onApply: (e, resultEl) => {
    const btn = e.target.closest(".nutrition-plan-apply");
    if (btn) applyLogAiProposal(Number(btn.dataset.index), resultEl);
  },
});

// ── Dragging rows ─────────────────────────────────────
// Order is data here — groups.json and food-logs.json both keep their lists in the
// order they're given — so the rows carry a grip. Two things can be dragged,
// told apart by the grip's own `data-kind`:
//
//   "food" — a food row, up and down inside its group or onto another group to
//     move it there. Both tabs have these: the Groups tab drags between the
//     groups of the tab ("group" scope), the Meal Log tab between the groups of a
//     day ("log" scope). Either way the food belongs to a *group*, so the edit
//     stages against that group and saves through its own Save button.
//   "group" — a group row on the Meal Log tab, reordering the day it's in.
//     Addressed by position, since the same group can be listed twice.
//
// A group row is both at once — a source for one kind and a target for the
// other — so the two use separate attribute prefixes: data-drag/data-drop for
// foods, data-mdrag/data-mdrop for groups. No drop touches the server.
//
// Pointer events rather than HTML5 drag-and-drop: the latter never fires on
// touch, and the dashboard gets used from the phone as well as the Mac.

/** How each scope reads and stages a group's food list. */
function foodDragApi(scope) {
  if (scope === "log") {
    return {
      // The day's own foods answer here too, as the list they look like from a
      // drag's point of view — see logDayFoods.
      items: (owner) =>
        logIdOfDayOwner(owner)
          ? logDayFoods(logIdOfDayOwner(owner))
          : logFoodEdits.get(owner) || logGroupById(owner)?.items || [],
      edit: editLogGroupFoods,
    };
  }
  return {
    items: (owner) => groupEdits.get(owner) || groupsData.groups.find((m) => m.id === owner)?.items || [],
    edit: editGroupItems,
  };
}

const FOOD_DRAG_THRESHOLD = 4; // px of travel before a press counts as a drag
const DRAG_SCROLL_EDGE = 44; // how close to the wrapper's edge starts autoscroll
const DRAG_SCROLL_STEP = 10; // px per frame while there

// The drag in flight, or null. Held in one place so the move/up/cancel handlers
// on `document` — the drag has to survive the pointer leaving the row — can all
// see it.
let foodDrag = null;
let dragScrollDelta = 0;
let dragScrollRaf = 0;

function startFoodDrag(e) {
  if (e.button > 0) return;
  const handle = e.target.closest?.(".ntable-drag-handle");
  const kind = handle?.dataset.kind === "group" ? "group" : "food";
  const row = handle?.closest(kind === "group" ? "tr[data-mdrag-owner]" : "tr[data-drag-owner]");
  const wrap = row?.closest(".ntable-wrap");
  if (!wrap) return;
  // Otherwise the press selects the row's text on the way past.
  e.preventDefault();
  foodDrag = {
    kind,
    scope: row.dataset.dragScope,
    owner: kind === "group" ? row.dataset.mdragOwner : row.dataset.dragOwner,
    // The name is what the drag shows and what the food is looked up by; where
    // the row *is* is the index below, since the same food can be listed twice.
    item: row.dataset.dragItem,
    // Its place in the list its owner holds: a group in the day, a food in the
    // group it sits in — or in the day itself when it's loose there.
    index: Number(kind === "group" ? row.dataset.mdragIndex : row.dataset.dragIndex),
    handle, row, wrap,
    pointerId: e.pointerId,
    startY: e.clientY,
    x: e.clientX,
    y: e.clientY,
    moved: false,
    target: null,
  };
  handle.setPointerCapture?.(e.pointerId);
}

function moveFoodDrag(e) {
  if (!foodDrag || e.pointerId !== foodDrag.pointerId) return;
  foodDrag.x = e.clientX;
  foodDrag.y = e.clientY;
  if (!foodDrag.moved) {
    // A press that never travels is a click on the grip, not a drag.
    if (Math.abs(e.clientY - foodDrag.startY) < FOOD_DRAG_THRESHOLD) return;
    foodDrag.moved = true;
    foodDrag.row.classList.add("is-dragging");
    document.body.classList.add("is-row-dragging");
  }
  e.preventDefault();
  aimFoodDrag();
  autoScrollFoodDrag();
}

/** Re-read what's under the pointer and move the drop line to it. */
function aimFoodDrag() {
  foodDrag.target = foodDropTargetAt(foodDrag.x, foodDrag.y);
  showDropLine(foodDrag.target);
}

/**
 * The row under the pointer, as somewhere to drop — which half of it decides
 * whether the dragged row lands above or below. A null means this isn't a drop:
 * no line is drawn, and letting go there changes nothing.
 */
function foodDropTargetAt(x, y) {
  const sel = foodDrag.kind === "group" ? "tr[data-mdrop-owner]" : "tr[data-drop-owner]";
  const row = document.elementFromPoint(x, y)?.closest?.(sel);
  if (!row || !foodDrag.wrap.contains(row)) return null;
  if (foodDrag.kind === "group") return groupDropTarget(row, y);
  if (row.dataset.dropScope !== foodDrag.scope) return null;
  // A group row answers for two lists at once — see logDayEdgeTarget — so which
  // one this drop belongs to has to be settled before the rules below, which all
  // turn on where the food is going.
  const dayEdge = logDayEdgeTarget(row, y);
  const owner = dayEdge ? dayEdge.owner : row.dataset.dropOwner;
  // A saved group has to keep at least one food — the server rejects an empty
  // one — so its last food can be reordered but not dragged out of it. The day
  // is under no such rule, and neither is an ad-hoc group.
  const leaving = owner !== foodDrag.owner && !logIdOfDayOwner(foodDrag.owner);
  if (leaving && !logGroupById(foodDrag.owner)?.custom &&
      foodDragApi(foodDrag.scope).items(foodDrag.owner).length < 2) return null;
  if (dayEdge) return dayEdge;
  const rect = row.getBoundingClientRect();
  // Every row that holds a food says where it sits in its owner's list — that's
  // what a drop is measured against. Null on the rows that stand for the ends of
  // a list: a group's own row and its add row.
  const index = row.dataset.dropIndex === undefined ? null : Number(row.dataset.dropIndex);
  if (row.dataset.dropItem) {
    const after = y > rect.top + rect.height / 2;
    return { owner, item: row.dataset.dropItem, index, after, edge: after ? rect.bottom : rect.top };
  }
  // A group row takes the food at the top of its list, its add row at the
  // bottom — each right where the line comes to rest.
  const end = row.dataset.dropPos === "end";
  return { owner, item: null, index, end, edge: end ? rect.top : rect.bottom };
}

/**
 * Same idea one level up, for a group being moved around its day. Positions
 * rather than names, and the line has further to travel: a group owns the food
 * rows under it, so landing "after" one means after its whole block — which is
 * exactly where the next row that can take a group begins.
 */
function groupDropTarget(row, y) {
  const owner = row.dataset.mdropOwner;
  // Only ever one day on screen, so this is a guard rather than a case.
  if (owner !== foodDrag.owner) return null;
  const rect = row.getBoundingClientRect();
  if (row.dataset.mdropIndex === undefined) {
    const end = row.dataset.mdropPos === "end";
    return { owner, index: null, end, edge: end ? rect.top : rect.bottom };
  }
  const after = y > rect.top + rect.height / 2;
  return { owner, index: Number(row.dataset.mdropIndex), after, edge: after ? logRowBlockEnd(row) : rect.top };
}

/**
 * Where a row's block ends on screen. A group owns the food rows under it, so
 * landing "after" one means after the lot — which is exactly where the next row
 * that can take a group begins.
 */
function logRowBlockEnd(row) {
  let next = row.nextElementSibling;
  while (next && next.dataset.mdropOwner === undefined) next = next.nextElementSibling;
  return next ? next.getBoundingClientRect().top : row.getBoundingClientRect().bottom;
}

// How much of a group row's height, at each end, means the day rather than the
// group. Enough to aim at without swallowing the middle, which is the commoner
// drop of the two.
const LOG_DAY_EDGE = 0.3;

/**
 * A group row in a day takes a food two ways. Across its middle the food
 * goes *into* the group; along either edge it goes into the day beside it, at
 * the same level as the group itself.
 *
 * Without the edges the day's own level is only reachable from its first and
 * last rows, so a food could be dropped into a group but never put back out
 * between two of them — nor moved along a day it was already loose in, since
 * every row in between belongs to a group.
 *
 * Null when this isn't one of those rows, or when the pointer is in the middle.
 */
function logDayEdgeTarget(row, y) {
  if (!row.dataset.fdayOwner) return null;
  const rect = row.getBoundingClientRect();
  // Half the row either side leaves no middle at all — a closed group has no
  // inside to aim at, so anywhere on it means above or below, never in.
  const band = row.dataset.fdayOnly ? rect.height / 2 : rect.height * LOG_DAY_EDGE;
  if (y > rect.top + band && y < rect.bottom - band) return null;
  const after = y > rect.top + rect.height / 2;
  return {
    owner: row.dataset.fdayOwner,
    item: null,
    index: Number(row.dataset.fdayIndex),
    after,
    edge: after ? logRowBlockEnd(row) : rect.top,
  };
}

/** The line showing where the row would land, drawn inside the scroller. */
function showDropLine(target) {
  const wrap = foodDrag.wrap;
  let line = wrap.querySelector(".ntable-drop-line");
  if (!target) {
    line?.remove();
    return;
  }
  if (!line) {
    line = document.createElement("div");
    line.className = "ntable-drop-line";
    wrap.appendChild(line);
  }
  const rect = wrap.getBoundingClientRect();
  // Absolute inside the scroller, so it has to be placed in scrolled
  // coordinates; clientTop takes the wrapper's own border out.
  line.style.top = `${target.edge - rect.top - wrap.clientTop + wrap.scrollTop}px`;
  line.style.width = `${wrap.querySelector(".ntable")?.offsetWidth || wrap.scrollWidth}px`;
}

/**
 * A day's worth of rows is taller than the table, so dragging to the edge
 * scrolls it. Runs on its own frames rather than off pointermove — held still
 * at the edge, the pointer stops sending events but the scroll should continue.
 */
function autoScrollFoodDrag() {
  const rect = foodDrag.wrap.getBoundingClientRect();
  const near = (d) => Math.max(0, (DRAG_SCROLL_EDGE - d) / DRAG_SCROLL_EDGE);
  dragScrollDelta =
    Math.round(DRAG_SCROLL_STEP * (near(rect.bottom - foodDrag.y) - near(foodDrag.y - rect.top)));
  if (!dragScrollDelta || dragScrollRaf) return;
  const tick = () => {
    dragScrollRaf = 0;
    if (!foodDrag || !dragScrollDelta) return;
    foodDrag.wrap.scrollTop += dragScrollDelta;
    // The rows moved under a stationary pointer, so the target has to be retaken.
    aimFoodDrag();
    dragScrollRaf = requestAnimationFrame(tick);
  };
  dragScrollRaf = requestAnimationFrame(tick);
}

function endFoodDrag(commit) {
  if (!foodDrag) return;
  const drag = foodDrag;
  foodDrag = null;
  dragScrollDelta = 0;
  if (dragScrollRaf) cancelAnimationFrame(dragScrollRaf);
  dragScrollRaf = 0;
  try { drag.handle.releasePointerCapture?.(drag.pointerId); } catch {}
  drag.row.classList.remove("is-dragging");
  document.body.classList.remove("is-row-dragging");
  drag.wrap.querySelector(".ntable-drop-line")?.remove();
  if (!commit || !drag.moved || !drag.target) return;
  // Picked up and put back where it was: nothing has changed, so nothing is
  // staged and the day stays as it was. The row is already back in place — the
  // dragging class and the drop line came off above — so there's nothing to
  // repaint either.
  if (!foodDragMoves(drag, drag.target)) return;
  // Moving something is editing the day, so the day opens the whole way — name
  // in a box, serving controls back on every row. Applying the move on its own
  // only stages a change, which brings out Save/Cancel and nothing else.
  // A group drag is only ever a day's group — its row carries a drop scope but
  // no drag one, so the kind is what says where it came from.
  if (drag.kind === "group" || drag.scope === "log") openLogEditing();
  applyFoodDrag(drag, drag.target);
}

/** How long the list is that the dragged row was picked up out of. */
function foodDragListLength(drag) {
  if (drag.kind === "group") return logDayItems(drag.owner).length;
  const day = logIdOfDayOwner(drag.owner);
  if (day) return logDayItems(day).length;
  return foodDragApi(drag.scope).items(drag.owner).length;
}

/**
 * Whether the drop would actually move the row. Landing on the half of its own
 * neighbour that faces it — or on either half of itself — puts it back where it
 * started, which is no edit at all.
 *
 * Crossing into another list always is one, even if it lands at the same number.
 */
function foodDragMoves(drag, target) {
  if (drag.kind !== "group" && target.owner !== drag.owner) return true;
  if (!Number.isInteger(drag.index)) return true;
  // Counted in the list with the row already taken out of it — the same sum the
  // move itself does.
  const len = Math.max(0, foodDragListLength(drag) - 1);
  return groupDropIndex(drag.index, target, len) !== drag.index;
}

/** The day the table is showing, or null. */
function currentLog() {
  const sorted = [...logsData.logs].sort((a, b) => a.name.localeCompare(b.name));
  return logsData.logs.find((m) => m.id === currentLogId(sorted)) || null;
}

/** Put that day into edit mode, the same as its own Edit button does. */
function openLogEditing() {
  const log = currentLog();
  if (log && !logNameEdits.has(log.id)) logNameEdits.set(log.id, log.name);
}

/**
 * Where the dragged food belongs in `items`, which no longer contains it. By
 * the position the line came to rest at, not by the name of the row it landed
 * on — a group can list the same food twice, and by name both rows would answer
 * to the first one's place.
 *
 * A target with no index is one of the rows that stand for the ends of the list:
 * a group's own row (the top) or its add row (the bottom).
 */
function foodDropIndex(items, target) {
  if (target.index === null || target.index === undefined) return target.end ? items.length : 0;
  return Math.max(0, Math.min(target.index + (target.after ? 1 : 0), items.length));
}

/**
 * Where a moved group belongs, counted in the list it's already been taken out
 * of. The target's index still refers to the day as it was, so a row that sat
 * below the one being moved has since come up one place.
 */
function groupDropIndex(from, target, len) {
  if (target.index === null) return target.end ? len : 0;
  const i = target.index + (target.after ? 1 : 0);
  return Math.max(0, Math.min(i > from ? i - 1 : i, len));
}

/** The day's own foods, as the flat list a drag reads them as. */
function logDayFoods(logId) {
  return logDayItems(logId)
    .filter((it) => it.food)
    .map((it) => ({ item: it.food, qty: it.qty || 1 }));
}

/** A day's entries, pending edits first. */
function logDayItems(logId) {
  return logEdits.get(logId) || logsData.logs.find((m) => m.id === logId)?.items || [];
}

/**
 * Where a food dropped on the day belongs in its list of entries. Foods land
 * between whatever is there — a group, another loose food — so the position
 * comes from the row the line came to rest on, not from the foods alone. Which
 * is the same sum a food landing inside a group gets; only the list differs.
 */
const logDayDropIndex = foodDropIndex;

/**
 * Add a food to a day's list at `at` — always as its own entry, even when the
 * same food is already loose in the day. A day can hold two helpings of a thing
 * at two points in it, and folding them together would be the day saying it was
 * eaten once.
 */
function insertLogDayFood(logId, name, qty, at) {
  editLogItems(logId, (items) => {
    const i = logDayDropIndex(items, { index: at.index, after: at.after, end: at.end });
    items.splice(i, 0, { food: name, qty });
    // Which rows are open is keyed by position, so everything below the new
    // entry has come down one place.
    insertLogGroupExpanded(logId, i);
  });
}

/**
 * A food crossing between a group and the day itself. The generic path below
 * can't carry these: one side isn't a food list at all, it's the day's mixed
 * list of groups and loose foods, so each direction is spelled out.
 */
function applyLogDayFoodDrag(drag, target) {
  const fromDay = logIdOfDayOwner(drag.owner);
  const toDay = logIdOfDayOwner(target.owner);

  if (fromDay && toDay) {
    // Moved around the day it's already in.
    editLogItems(fromDay, (items) => {
      const from = drag.index;
      if (!items[from]?.food) return;
      // Dropped back on itself — nothing to do, and the index maths below would
      // read the gap it leaves as a move by one place.
      if (target.index === from) return;
      const order = [...items.keys()];
      const [moved] = items.splice(from, 1);
      const [was] = order.splice(from, 1);
      const to = groupDropIndex(from, { index: target.index ?? null, after: target.after, end: target.end }, items.length);
      items.splice(to, 0, moved);
      order.splice(to, 0, was);
      reindexLogGroupExpanded(fromDay, order);
    });
    return;
  }

  if (fromDay) {
    // Out of the day and into one of its groups.
    const moved = logDayItems(fromDay)[drag.index];
    if (!moved?.food) return;
    const qty = moved.qty || 1;
    const name = moved.food;
    editLogItems(fromDay, (items) => {
      const i = drag.index;
      if (!items[i]?.food) return;
      shiftLogGroupExpanded(fromDay, i);
      return items.filter((_, n) => n !== i);
    });
    // A line of its own where the drop line came to rest, even when the group
    // already lists that food — the same rule the day itself follows.
    editLogGroupFoods(target.owner, (items) => {
      items.splice(foodDropIndex(items, target), 0, { item: name, qty });
    });
    return;
  }

  // Out of a group and loose in the day.
  const moved = foodDragApi(drag.scope).items(drag.owner)[drag.index];
  if (!moved) return;
  editLogGroupFoods(drag.owner, (items) => items.filter((_, n) => n !== drag.index));
  insertLogDayFood(toDay, moved.item, moved.qty || 1, target);
}

/** Stage the move the drop asks for. */
function applyFoodDrag(drag, target) {
  if (drag.kind === "group") {
    editLogItems(drag.owner, (items) => {
      if (!items[drag.index]) return;
      const from = drag.index;
      // The positions ride along: the same two splices over 0…n-1 say where
      // each group ended up, which is what renumbers the open ones below.
      const order = [...items.keys()];
      const [moved] = items.splice(from, 1);
      const [was] = order.splice(from, 1);
      const to = groupDropIndex(from, target, items.length);
      items.splice(to, 0, moved);
      order.splice(to, 0, was);
      // Which groups are open is keyed by position, so the same shuffle has to
      // reach those keys or the wrong groups come back open.
      reindexLogGroupExpanded(drag.owner, order);
    });
    return;
  }
  // Either end of the move being the day itself rather than a group.
  if (logIdOfDayOwner(drag.owner) || logIdOfDayOwner(target.owner)) {
    applyLogDayFoodDrag(drag, target);
    return;
  }
  const { items: listOf, edit } = foodDragApi(drag.scope);
  const sameGroup = target.owner === drag.owner;
  // Dropped back on itself — nothing to do, and the index maths below would read
  // the gap it leaves as a move by one place.
  if (sameGroup && target.index === drag.index) return;
  if (sameGroup) {
    edit(drag.owner, (items) => {
      const from = drag.index;
      if (!items[from]) return;
      // Out first, then the index — dropping below a row two places down means
      // the second place in what's left, not in the list it was counted from.
      const [moved] = items.splice(from, 1);
      items.splice(groupDropIndex(from, target, items.length), 0, moved);
    });
    return;
  }
  // Across groups: two staged edits, out of one list and into the other, so each
  // group keeps its own unsaved state and its own Save.
  const moved = listOf(drag.owner)[drag.index];
  if (!moved) return;
  edit(drag.owner, (items) => items.filter((_, n) => n !== drag.index));
  // Its own row where the line came to rest, even if the group already lists
  // that food — two rows of it is a group saying it's eaten twice.
  edit(target.owner, (items) => {
    items.splice(foodDropIndex(items, target), 0, { ...moved });
  });
}

for (const el of [groupsContentEl, logsContentEl]) el?.addEventListener("pointerdown", startFoodDrag);
// On the document, not the row: the pointer is captured to the grip, but the
// drag still has to end when the button comes up anywhere at all.
document.addEventListener("pointermove", moveFoodDrag);
document.addEventListener("pointerup", () => endFoodDrag(true));
document.addEventListener("pointercancel", () => endFoodDrag(false));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") endFoodDrag(false);
});

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function getActiveFile() {
  return currentTab === "library" && currentLibraryPath ? `dashbook/${currentLibraryPath}` : null;
}

// --- Markdown edit buttons ---
// Only text files get here — loadLibraryItem hides the button for anything
// else — so the editor is always looking at something it can write back.
libraryEditBtn.addEventListener("click", () => {
  if (!currentLibraryPath) return;
  enterEditMode(libraryBodyEl, libraryEditBtn, libraryRawText, async (newContent) => {
    if (newContent === null) {
      renderLibraryContent(currentLibraryPath, libraryRawText);
      return true;
    }
    if (isJsonPath(currentLibraryPath)) {
      try { JSON.parse(newContent); }
      catch (err) { alert("Invalid JSON: " + err.message); return false; }
    }
    try {
      await saveLibraryFile(currentLibraryPath, newContent);
      renderLibraryContent(currentLibraryPath, newContent);
      return true;
    } catch (err) {
      alert("Save failed: " + err.message);
      return false;
    }
  });
});

/**
 * A tab's URL, preserving the deep-link path for the Library's open file.
 * Home is the bare "/" — the app's front door has no route of its own.
 */
function pathForTab(tab) {
  if (tab === "library" && currentLibraryPath) return `/library/${encodePath(currentLibraryPath)}`;
  return tab === "home" ? "/" : `/${tab}`;
}

// Keep the URL in sync with the active tab. Called from tab clicks and from
// sidebar/home nav — each of which is a real navigation, so it gets pushed:
// Back then walks back through the tabs you visited instead of leaving the app
// on the first press. Landing on the tab you're already on changes no URL and
// records nothing, so repeat clicks can't stack identical entries.
function updatePathForTab(tab) {
  const path = pathForTab(tab);
  if (path === location.pathname) return;
  history.pushState({ tab }, "", path);
}

tabBtns.forEach((btn) => {
  btn.addEventListener("click", () => setTab(btn.dataset.tab));
});

/**
 * Resolve a route segment to a tab: either a tab's own key (`/groups`, and the
 * `/library/some-id` form whose first segment is `library`) or a page name, which
 * lands on that page's first tab (`/nutrition` → the Food tab).
 */
// Routes that have been renamed. Keeps old bookmarks landing somewhere real.
const TAB_ALIASES = {
  log: "food-logs",
  "food-templates": "food-logs",
  "meal-plans": "food-logs",
  "meal-log": "food-logs",
  // The four tabs the Library replaced. Their file links keep working too —
  // see routeLibraryPath, which maps each old root onto its folder.
  notes: "library",
  dash: "library",
  images: "library",
  reports: "library",
};

function tabForKey(key) {
  if (!key) return null;
  const k = TAB_ALIASES[key] || key;
  // Hidden tabs don't answer: a hand-typed /groups has to fall through to the
  // page's first live tab rather than route to nothing.
  if (document.querySelector(`.tab[data-tab="${CSS.escape(k)}"]:not([hidden])`)) return k;
  return (tabsOfPage[k] || [])[0] || null;
}

// Routes are real paths — the server hands back the app for any of them — so
// the current one is read off the pathname. Segments are decoded one at a time:
// they were encoded that way, and a file name is free to contain a "%2F".
function routeSegments() {
  return location.pathname.split("/").filter(Boolean).map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
}

// Each retired tab's root, for reading its old links: /reports/pnc/x.csv is
// the library's data/reports/pnc/x.csv.
const LEGACY_LIBRARY_ROOTS = {
  notes: "notes",
  dash: "dash",
  images: "images",
  reports: "data/reports",
};

/** The file the route deep-links to: /library/notes/a/b.md → "notes/a/b.md". */
function routeLibraryPath() {
  const parts = routeSegments();
  if (!parts.length || parts.length === 1) return "";
  if (parts[0] === "library") return parts.slice(1).join("/");
  const root = LEGACY_LIBRARY_ROOTS[parts[0]];
  return root ? [root, ...parts.slice(1)].join("/") : "";
}

function tabFromPath() {
  return tabForKey(routeSegments()[0] || "home");
}

// Route without rewriting the path we just read — and without pushing a fresh
// entry for a tab the user got to by walking the history.
function routeFromPath() {
  const tab = tabFromPath();
  if (tab && tab !== currentTab) setTab(tab, { updatePath: false });
}

// Back/forward through the pushed entries. A hand-edited path is a real
// navigation, so it reloads the page and comes back through initRoute.
window.addEventListener("popstate", routeFromPath);

// Initial route: a deep link in the path wins, otherwise every fresh load
// starts at home. Nothing is restored from the previous visit — opening the app
// in a new tab, or after closing the browser, should land somewhere predictable.
(function initRoute() {
  // Routes used to live in the hash. Old bookmarks, and the URL an installed
  // PWA saved back then, get rewritten to the path form before anything reads
  // them; an unrecognized one falls back to home.
  const legacy = location.hash.replace(/^#/, "");
  if (legacy) {
    const segs = legacy.split("/").filter(Boolean);
    let key = segs[0] || "";
    try { key = decodeURIComponent(key); } catch { /* leave it as typed */ }
    history.replaceState(null, "", tabForKey(key) ? `/${segs.join("/")}` : "/");
  }

  const fromPath = tabFromPath();
  if (fromPath) {
    setTab(fromPath, { updatePath: false });
    // A route that resolved to a tab of another name — an old one like
    // /food-templates, or a page name — settles onto the tab's own path, so the
    // URL says where you actually are. Only for a bare route: the longer form
    // carries a file the tab hasn't loaded yet, and rewriting would drop it.
    const segs = routeSegments();
    if (segs.length === 1 && segs[0] !== fromPath) {
      history.replaceState({ tab: fromPath }, "", `/${fromPath}`);
    }
    return;
  }
  const tab = "home";
  setTab(tab, { updatePath: false });
  // Replace, not push: this is the entry Back should leave the app from, and a
  // second one stacked on it would turn the first Back press into a no-op.
  history.replaceState({ tab }, "", pathForTab(tab));
})();

connectLibraryStream();
connectRemindersStream();
connectMessagesStream();

// ── Tab scroll hint ────────────────────────────────────
(function setupTabsScroll() {
  const tabsEl = document.querySelector(".tabs");
  const hintEl = document.getElementById("tabs-scroll-hint");
  const backEl = document.getElementById("tabs-scroll-hint-back");
  if (!tabsEl || !hintEl) return;
  function update() {
    const overflow = tabsEl.scrollWidth - tabsEl.clientWidth;
    const atEnd = tabsEl.scrollLeft >= overflow - 2;
    const atStart = tabsEl.scrollLeft <= 2;
    hintEl.hidden = overflow <= 2 || atEnd;
    if (backEl) backEl.hidden = overflow <= 2 || atStart;
  }
  const step = () => Math.max(120, tabsEl.clientWidth * 0.6);
  hintEl.addEventListener("click", () => {
    tabsEl.scrollBy({ left: step(), behavior: "smooth" });
  });
  if (backEl) backEl.addEventListener("click", () => {
    tabsEl.scrollBy({ left: -step(), behavior: "smooth" });
  });
  refreshTabsScroll = update;
  tabsEl.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update);
  // Run after layout settles and when fonts load
  setTimeout(update, 50);
  setTimeout(update, 300);
})();

// ── Mobile swipe to change tab ────────────────────────
(function setupTabSwipe() {
  if (!mainEl) return;
  const mobileMQ = window.matchMedia("(max-width: 768px)");
  const COMMIT_FRACTION = 0.25;     // % of width to commit
  const COMMIT_VELOCITY = 0.5;      // px/ms — flick threshold
  const ANIM_MS = 240;
  const RATIO = 1.2;                // horizontal must beat vertical by this

  // States: 'idle' (no touch), 'detecting' (touch down, axis undecided),
  // 'dragging' (horizontal axis locked), 'animating' (release in progress).
  let state = "idle";
  let startX = 0, startY = 0, startT = 0;
  let lastX = 0, lastT = 0, vx = 0;
  let activePanel = null, prevPanel = null, nextPanel = null;
  let activeBtn = null, prevBtn = null, nextBtn = null;

  function isInteractive(el) {
    return !!(el && el.closest && el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
  }

  function hasHorizontalScroll(target) {
    let el = target;
    while (el && el !== mainEl && el.nodeType === 1) {
      const cs = getComputedStyle(el);
      if ((cs.overflowX === "auto" || cs.overflowX === "scroll") && el.scrollWidth > el.clientWidth + 1) return true;
      el = el.parentElement;
    }
    return false;
  }

  function pinAdjacent(panel, side) {
    // Pin an adjacent panel as a fixed overlay on top of mainEl, sized to its
    // visible rect so vertical scroll on the underlying panel is irrelevant.
    // Inherit main's padding so content aligns with the in-flow active panel
    // (avoids a visible jump when the swipe completes and styles are cleared).
    const rect = mainEl.getBoundingClientRect();
    const cs = getComputedStyle(mainEl);
    panel.style.position = "fixed";
    panel.style.top = rect.top + "px";
    panel.style.left = rect.left + "px";
    panel.style.width = rect.width + "px";
    panel.style.height = rect.height + "px";
    panel.style.boxSizing = "border-box";
    panel.style.paddingTop = cs.paddingTop;
    panel.style.paddingRight = cs.paddingRight;
    panel.style.paddingBottom = cs.paddingBottom;
    panel.style.paddingLeft = cs.paddingLeft;
    panel.style.overflow = "hidden";
    panel.style.zIndex = "5";
    panel.style.transition = "none";
    panel.style.willChange = "transform";
    panel.style.transform = `translate3d(${side === "next" ? "100%" : "-100%"}, 0, 0)`;
    panel.hidden = false;
  }

  function clearPanelStyles(panel) {
    if (!panel) return;
    panel.style.position = "";
    panel.style.top = "";
    panel.style.left = "";
    panel.style.width = "";
    panel.style.height = "";
    panel.style.boxSizing = "";
    panel.style.paddingTop = "";
    panel.style.paddingRight = "";
    panel.style.paddingBottom = "";
    panel.style.paddingLeft = "";
    panel.style.overflow = "";
    panel.style.zIndex = "";
    panel.style.transition = "";
    panel.style.transform = "";
    panel.style.willChange = "";
  }

  function beginDrag() {
    state = "dragging";
    // Swipe moves between sub-tabs of the current page only — never across
    // pages, which is what the sidebar is for.
    const tabs = Array.from(tabBtns).filter(
      (b) => (b.dataset.page || b.dataset.tab) === currentPage,
    );
    const idx = tabs.findIndex((b) => b.dataset.tab === currentTab);
    activeBtn = tabs[idx] || null;
    prevBtn = idx > 0 ? tabs[idx - 1] : null;
    nextBtn = idx < tabs.length - 1 ? tabs[idx + 1] : null;
    activePanel = tabPanels[currentTab] || null;
    prevPanel = prevBtn ? tabPanels[prevBtn.dataset.tab] : null;
    nextPanel = nextBtn ? tabPanels[nextBtn.dataset.tab] : null;
    if (!activePanel) { state = "idle"; return; }
    activePanel.style.transition = "none";
    activePanel.style.willChange = "transform";
    if (prevPanel) pinAdjacent(prevPanel, "prev");
    if (nextPanel) pinAdjacent(nextPanel, "next");
  }

  function applyDrag(dx) {
    let off = dx;
    // Rubber-band when there's no neighbor in that direction.
    if (off > 0 && !prevPanel) off = off * 0.25;
    if (off < 0 && !nextPanel) off = off * 0.25;
    activePanel.style.transform = `translate3d(${off}px, 0, 0)`;
    if (prevPanel) prevPanel.style.transform = `translate3d(calc(-100% + ${off}px), 0, 0)`;
    if (nextPanel) nextPanel.style.transform = `translate3d(calc(100% + ${off}px), 0, 0)`;
  }

  function springBack() {
    state = "animating";
    const easing = "cubic-bezier(0.2, 0.8, 0.2, 1)";
    activePanel.style.transition = `transform ${ANIM_MS}ms ${easing}`;
    activePanel.style.transform = "translate3d(0, 0, 0)";
    if (prevPanel) {
      prevPanel.style.transition = `transform ${ANIM_MS}ms ${easing}`;
      prevPanel.style.transform = "translate3d(-100%, 0, 0)";
    }
    if (nextPanel) {
      nextPanel.style.transition = `transform ${ANIM_MS}ms ${easing}`;
      nextPanel.style.transform = "translate3d(100%, 0, 0)";
    }
    setTimeout(finishCleanup, ANIM_MS + 20);
  }

  function commit(direction) {
    state = "animating";
    const easing = "cubic-bezier(0.2, 0.8, 0.2, 1)";
    const targetBtn = direction === "next" ? nextBtn : prevBtn;
    const incoming = direction === "next" ? nextPanel : prevPanel;
    const outgoing = direction === "next" ? prevPanel : nextPanel; // the unused neighbor
    activePanel.style.transition = `transform ${ANIM_MS}ms ${easing}`;
    activePanel.style.transform = `translate3d(${direction === "next" ? "-100%" : "100%"}, 0, 0)`;
    if (incoming) {
      incoming.style.transition = `transform ${ANIM_MS}ms ${easing}`;
      incoming.style.transform = "translate3d(0, 0, 0)";
    }
    if (outgoing) {
      // Slide unused neighbor back off-screen.
      outgoing.style.transition = `transform ${ANIM_MS}ms ${easing}`;
      outgoing.style.transform = `translate3d(${direction === "next" ? "-100%" : "100%"}, 0, 0)`;
    }
    setTimeout(() => {
      // Trigger the existing tab click handler (handles the URL + lazy loads).
      if (targetBtn) targetBtn.click();
      finishCleanup();
      if (targetBtn) targetBtn.scrollIntoView?.({ behavior: "smooth", block: "nearest", inline: "center" });
    }, ANIM_MS + 20);
  }

  function finishCleanup() {
    // pinAdjacent un-hid prev/next so they could overlay during the drag.
    // After spring-back currentTab is unchanged (so both must be re-hidden);
    // after commit setTab already hid everything except the new active tab,
    // but the old neighbor on the unused side still needs hiding.
    const activeKey = currentTab;
    if (prevPanel && tabPanels[activeKey] !== prevPanel) prevPanel.hidden = true;
    if (nextPanel && tabPanels[activeKey] !== nextPanel) nextPanel.hidden = true;
    clearPanelStyles(activePanel);
    clearPanelStyles(prevPanel);
    clearPanelStyles(nextPanel);
    activePanel = prevPanel = nextPanel = null;
    activeBtn = prevBtn = nextBtn = null;
    state = "idle";
  }

  function isViewportZoomed() {
    const vv = window.visualViewport;
    return !!(vv && vv.scale > 1.01);
  }

  mainEl.addEventListener("touchstart", (e) => {
    if (state !== "idle") return;
    if (!mobileMQ.matches || e.touches.length !== 1) return;
    if (isViewportZoomed()) return;
    if (isInteractive(e.target) || hasHorizontalScroll(e.target)) return;
    const t = e.touches[0];
    startX = lastX = t.clientX;
    startY = t.clientY;
    startT = lastT = Date.now();
    vx = 0;
    state = "detecting";
  }, { passive: true });

  mainEl.addEventListener("touchmove", (e) => {
    if (state === "idle" || state === "animating") return;
    if (e.touches.length !== 1) {
      if (state === "dragging") springBack(); else state = "idle";
      return;
    }
    const t = e.touches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    if (state === "detecting") {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (Math.abs(dx) > Math.abs(dy) * RATIO) {
        beginDrag();
        if (state !== "dragging") return;
      } else {
        state = "idle";
        return;
      }
    }
    if (state === "dragging") {
      // Track velocity for flick detection.
      const now = Date.now();
      const ddt = Math.max(1, now - lastT);
      vx = (t.clientX - lastX) / ddt;
      lastX = t.clientX;
      lastT = now;
      applyDrag(dx);
      if (e.cancelable) e.preventDefault();
    }
  }, { passive: false });

  function endGesture(e) {
    if (state === "detecting") { state = "idle"; return; }
    if (state !== "dragging") return;
    const t = e.changedTouches[0];
    const dx = t.clientX - startX;
    const w = mainEl.clientWidth || window.innerWidth;
    const flick = Math.abs(vx) > COMMIT_VELOCITY;
    const moved = Math.abs(dx) > w * COMMIT_FRACTION;
    if (dx < 0 && nextPanel && (moved || (flick && vx < 0))) commit("next");
    else if (dx > 0 && prevPanel && (moved || (flick && vx > 0))) commit("prev");
    else springBack();
  }

  mainEl.addEventListener("touchend", endGesture, { passive: true });
  mainEl.addEventListener("touchcancel", (e) => {
    if (state === "dragging") springBack();
    else state = "idle";
  }, { passive: true });
})();

// ── Omnipresent Dash composer ──────────────────────────
(function setupDashComposer() {
  const micBtn = document.getElementById("dash-mic");
  const clearBtn = document.getElementById("dash-clear");
  const responseEl = document.getElementById("dash-response");
  const textEl = document.getElementById("dash-text");
  const sendBtn = document.getElementById("dash-send");

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let listening = false;
  let canceled = false;
  let baseText = "";
  let finalTranscript = "";

  function clearComposer() {
    if (listening) cancelListening();
    responseEl.hidden = true;
    responseEl.textContent = "";
    responseEl.classList.remove("error");
    finalTranscript = "";
    baseText = "";
    textEl.value = "";
    updateClearVisibility();
    setTimeout(() => textEl.focus({ preventScroll: true }), 30);
  }

  function updateClearVisibility() {
    const hasText = textEl.value.trim().length > 0;
    const hasResponse = !responseEl.hidden && responseEl.textContent.length > 0;
    clearBtn.hidden = !(hasText || hasResponse);
  }

  function updateSendDisabled() {
    sendBtn.disabled = micBtn.classList.contains("busy");
  }

  function setBusy(busy) {
    micBtn.classList.toggle("busy", busy);
    updateSendDisabled();
  }

  async function sendMessage(text) {
    const msg = (text || "").trim();
    if (!msg) return;
    setBusy(true);
    responseEl.hidden = true;
    responseEl.textContent = "";
    responseEl.classList.remove("error");
    try {
      const useTelegram = currentTab === "telegram";
      const url = useTelegram ? "/api/telegram-message" : "/api/dash-chat";
      const body = useTelegram
        ? { text: msg }
        : { text: msg, activeFile: getActiveFile(), activeTab: currentTab };
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (!useTelegram) {
        responseEl.textContent = data.response || "(no response)";
        responseEl.hidden = false;
      }
      textEl.value = "";
      finalTranscript = "";
      baseText = "";
      updateClearVisibility();
    } catch (err) {
      responseEl.textContent = `Error: ${err.message}`;
      responseEl.classList.add("error");
      responseEl.hidden = false;
      updateClearVisibility();
    } finally {
      setBusy(false);
    }
  }

  function stopListening() {
    if (recognition && listening) {
      try { recognition.stop(); } catch {}
    }
  }

  function cancelListening() {
    canceled = true;
    stopListening();
  }

  function showCancel(show) {
    sendBtn.classList.toggle("listening", show);
    sendBtn.setAttribute("aria-label", show ? "Cancel listening" : "Send");
  }

  function startListening() {
    if (!SR) {
      responseEl.textContent = "Your browser doesn't support speech recognition. Type your message instead.";
      responseEl.classList.add("error");
      responseEl.hidden = false;
      updateClearVisibility();
      return;
    }
    canceled = false;
    baseText = textEl.value || "";
    finalTranscript = "";

    recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";

    recognition.onstart = () => {
      listening = true;
      micBtn.classList.add("listening");
      showCancel(true);
      textEl.disabled = true;
      updateSendDisabled();
      titleEl.textContent = "Listening… tap mic to send";
    };
    recognition.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const chunk = e.results[i][0].transcript;
        if (e.results[i].isFinal) {
          finalTranscript += (finalTranscript && !finalTranscript.endsWith(" ") ? " " : "") + chunk.trim();
        } else {
          interim += chunk;
        }
      }
      const live = (finalTranscript + (interim ? " " + interim : "")).trim();
      const sep = baseText && !baseText.endsWith(" ") ? " " : "";
      textEl.value = baseText + sep + live;
      updateClearVisibility();
    };
    recognition.onerror = (e) => {
      responseEl.textContent = `Mic error: ${e.error}`;
      responseEl.classList.add("error");
      responseEl.hidden = false;
      updateClearVisibility();
    };
    recognition.onend = () => {
      listening = false;
      micBtn.classList.remove("listening");
      showCancel(false);
      textEl.disabled = false;
      updateSendDisabled();
      if (canceled) {
        // Restore whatever was typed before listening began
        textEl.value = baseText;
        updateClearVisibility();
        finalTranscript = "";
        canceled = false;
        return;
      }
      const finalText = textEl.value.trim();
      if (finalText) {
        sendMessage(finalText);
      }
    };

    try {
      recognition.start();
    } catch (err) {
      responseEl.textContent = `Couldn't start mic: ${err.message}`;
      responseEl.classList.add("error");
      responseEl.hidden = false;
      updateClearVisibility();
    }
  }

  micBtn.addEventListener("click", () => {
    if (micBtn.classList.contains("busy")) return;
    if (listening) stopListening();
    else startListening();
  });
  clearBtn.addEventListener("click", clearComposer);
  sendBtn.addEventListener("click", () => {
    if (listening) cancelListening();
    else sendMessage(textEl.value);
  });
  textEl.addEventListener("input", () => {
    updateClearVisibility();
  });
  textEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      sendMessage(textEl.value);
    }
  });
})();

// ── Telegram tab composer ──────────────────────────────
(function setupTelegramComposer() {
  const textEl = document.getElementById("telegram-compose-text");
  const sendBtn = document.getElementById("telegram-compose-send");
  const micBtn = document.getElementById("telegram-compose-mic");
  if (!textEl || !sendBtn) return;

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let listening = false;
  let canceled = false;
  let baseText = "";
  let finalTranscript = "";

  function autosize() {
    textEl.style.height = "auto";
    textEl.style.height = Math.min(textEl.scrollHeight, 8 * 16) + "px";
  }

  async function send() {
    const msg = textEl.value.trim();
    if (!msg) return;
    sendBtn.disabled = true;
    textEl.disabled = true;
    try {
      const res = await fetch("/api/telegram-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: msg }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      textEl.value = "";
      autosize();
    } catch (err) {
      alert(`Send failed: ${err.message}`);
    } finally {
      sendBtn.disabled = false;
      textEl.disabled = false;
      textEl.focus({ preventScroll: true });
    }
  }

  function showCancel(show) {
    sendBtn.classList.toggle("listening", show);
    sendBtn.setAttribute("aria-label", show ? "Cancel listening" : "Send via Telegram");
  }

  function stopListening() {
    if (recognition && listening) {
      try { recognition.stop(); } catch {}
    }
  }

  function cancelListening() {
    canceled = true;
    stopListening();
  }

  function startListening() {
    if (!SR) {
      alert("Your browser doesn't support speech recognition. Type your message instead.");
      return;
    }
    canceled = false;
    baseText = textEl.value || "";
    finalTranscript = "";

    recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";

    recognition.onstart = () => {
      listening = true;
      micBtn.classList.add("listening");
      showCancel(true);
      textEl.disabled = true;
    };
    recognition.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const chunk = e.results[i][0].transcript;
        if (e.results[i].isFinal) {
          finalTranscript += (finalTranscript && !finalTranscript.endsWith(" ") ? " " : "") + chunk.trim();
        } else {
          interim += chunk;
        }
      }
      const live = (finalTranscript + (interim ? " " + interim : "")).trim();
      const sep = baseText && !baseText.endsWith(" ") ? " " : "";
      textEl.value = baseText + sep + live;
      autosize();
    };
    recognition.onerror = () => {};
    recognition.onend = () => {
      listening = false;
      micBtn.classList.remove("listening");
      showCancel(false);
      textEl.disabled = false;
      if (canceled) {
        textEl.value = baseText;
        autosize();
        finalTranscript = "";
        canceled = false;
        return;
      }
      const finalText = textEl.value.trim();
      if (finalText) send();
    };

    try {
      recognition.start();
    } catch {}
  }

  textEl.addEventListener("input", autosize);
  textEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  sendBtn.addEventListener("click", () => {
    if (listening) cancelListening();
    else send();
  });
  if (micBtn) {
    micBtn.addEventListener("click", () => {
      if (listening) stopListening();
      else startListening();
    });
  }
})();
