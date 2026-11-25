import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadRunTimeline, replayRunAt, sortTimelineEvents, type RunTimeline } from "./timeline.js";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]!));
}

function safeEmbeddedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

export function exportRunJson(timeline: RunTimeline): string {
  const ordered = { ...timeline, events: sortTimelineEvents(timeline.events) };
  const finalFrame = replayRunAt(ordered, ordered.events.length - 1);
  return JSON.stringify({
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    timeline: ordered,
    finalState: {
      tasks: finalFrame.run.tasks,
      members: finalFrame.run.members,
      messages: finalFrame.run.messages,
      metrics: finalFrame.run.metrics,
    },
  }, null, 2) + "\n";
}

export function exportRunHtml(timeline: RunTimeline): string {
  const ordered: RunTimeline = { ...timeline, events: sortTimelineEvents(timeline.events) };
  const embedded = safeEmbeddedJson(ordered);
  const title = `Agent Pair Replay — ${ordered.workspaceName} (${ordered.runId.slice(0, 8)})`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --bg: #1c1b29; --surface: #262538; --surface-2: #302f46; --ink: #f5efe6;
      --muted: #b9b2c9; --border: #464362; --accent: #a799ff;
      --ok: #8ce9c1; --warn: #f9d88b; --err: #ffaaaa; --rev: #bfcaff;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, sans-serif; background: var(--bg); color: var(--ink); line-height: 1.45; }
    .wrap { max-width: 1120px; margin: 0 auto; padding: 20px 18px 40px; }
    .panel { background: var(--surface); border: 2px solid var(--border); border-radius: 16px; padding: 16px; margin-bottom: 16px; }
    h1, h2, h3 { margin: 0 0 10px; }
    .muted { color: var(--muted); font-size: 0.85rem; }
    .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 12px; }
    button, select { font: inherit; font-weight: 700; color: var(--ink); background: var(--surface-2); border: 1.5px solid var(--border); border-radius: 999px; padding: 6px 14px; cursor: pointer; }
    input[type="range"] { flex: 1; min-width: 180px; accent-color: var(--accent); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
    .card { background: var(--surface-2); border: 1.5px solid var(--border); border-radius: 12px; padding: 10px 12px; }
    .card.pulse { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(167,153,255,0.35); }
    .badge { display: inline-block; font-size: 0.74rem; font-weight: 800; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); }
    .st-accepted, .st-done { color: var(--ok); border-color: var(--ok); }
    .st-active, .st-working { color: var(--ok); }
    .st-blocked { color: var(--err); border-color: var(--err); }
    .st-ready, .st-review { color: var(--rev); border-color: var(--rev); }
    .st-pending, .st-waiting { color: var(--warn); }
    table { width: 100%; border-collapse: collapse; font-size: 0.84rem; }
    th, td { text-align: left; padding: 7px 9px; border-bottom: 1px solid var(--border); }
    th { color: var(--muted); font-size: 0.75rem; text-transform: uppercase; }
    .events { max-height: 280px; overflow-y: auto; display: grid; gap: 6px; }
    .ev { padding: 7px 10px; border-radius: 10px; background: var(--surface-2); border: 1px solid var(--border); cursor: pointer; font-size: 0.82rem; }
    .ev.current { border-color: var(--accent); background: #362f52; }
    .mono { font-family: ui-monospace, Consolas, monospace; font-size: 0.78rem; }
  </style>
</head>
<body>
  <div class="wrap">
    <section class="panel">
      <h1>Agent Pair — Offline Run Report</h1>
      <div class="muted" id="meta"></div>
    </section>
    <section class="panel">
      <h2>Timeline Replay</h2>
      <div class="controls">
        <button id="playBtn" type="button">Play</button>
        <button id="prevBtn" type="button">Prev</button>
        <button id="nextBtn" type="button">Next</button>
        <input id="scrub" type="range" min="0" max="0" value="0" aria-label="Timeline step" />
        <select id="speed" aria-label="Playback speed">
          <option value="1200">0.5x</option>
          <option value="650" selected>1x</option>
          <option value="280">2x</option>
        </select>
        <span class="mono" id="stepLabel"></span>
      </div>
      <div class="muted" id="eventDetail"></div>
    </section>
    <section class="panel">
      <h2>Team Map</h2>
      <div class="grid" id="teamGrid"></div>
    </section>
    <section class="panel">
      <h2>Tasks</h2>
      <div id="taskWrap"></div>
    </section>
    <section class="panel">
      <h2>Metrics &amp; Cost</h2>
      <div id="metricsWrap"></div>
    </section>
    <section class="panel">
      <h2>Timeline Events</h2>
      <div class="events" id="eventList"></div>
    </section>
  </div>
  <script id="run-data" type="application/json">${embedded}</script>
  <script>
    const TIMELINE = JSON.parse(document.getElementById("run-data").textContent);
    const EVENTS = [...(TIMELINE.events || [])].sort((a, b) => (a.id - b.id) || (a.timestamp - b.timestamp));
    let step = EVENTS.length ? EVENTS.length - 1 : -1;
    let timer = null;

    const scrub = document.getElementById("scrub");
    const playBtn = document.getElementById("playBtn");
    const speedSel = document.getElementById("speed");
    scrub.min = EVENTS.length ? "0" : "-1";
    scrub.max = String(Math.max(-1, EVENTS.length - 1));
    scrub.value = String(step);

    function esc(v) {
      return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    }
    function fmtMs(ms) {
      if (ms === null || ms === undefined) return "—";
      if (ms < 1000) return ms + "ms";
      return (ms / 1000).toFixed(1) + "s";
    }
    function replayAt(index) {
      const slice = index >= 0 ? EVENTS.slice(0, index + 1) : [];
      const tasks = new Map(TIMELINE.tasks.map((t) => [t.id, { ...t, state: "pending", note: undefined }]));
      const connected = new Set();
      const claimed = new Set();
      const activeMembers = new Set();
      for (const ev of slice) {
        if (ev.type === "member.joined" && ev.member) { connected.add(ev.member); claimed.add(ev.member); }
        if (ev.type === "member.disconnected" && ev.member) connected.delete(ev.member);
        if (ev.taskId && tasks.has(ev.taskId)) {
          const t = tasks.get(ev.taskId);
          if (ev.type === "task.started") t.state = ev.data?.state || "active";
          if (ev.type === "task.blocked" || ev.type === "task.stalled") t.state = "blocked";
          if (ev.type === "task.handoff") t.state = ev.data?.state || "ready";
          if (ev.type === "task.revised") t.state = ev.data?.state || "pending";
          if (ev.type === "task.accepted") t.state = ev.data?.state || "accepted";
          if (typeof ev.data?.note === "string") t.note = ev.data.note;
        }
      }
      const cur = index >= 0 ? EVENTS[index] : null;
      if (cur?.member) activeMembers.add(cur.member);
      const taskList = [...tasks.values()];
      const members = TIMELINE.members.map((m) => {
        const owned = taskList.filter((t) => t.owner === m.member);
        let status = !claimed.has(m.member) ? "waiting"
          : owned.length && owned.every((t) => t.state === "accepted") ? "done"
          : !connected.has(m.member) ? "disconnected"
          : owned.some((t) => t.state === "active") ? "working"
          : owned.some((t) => t.state === "blocked") ? "blocked"
          : owned.some((t) => t.state === "ready") ? "review" : "idle";
        return { ...m, status };
      });
      return { cur, tasks: taskList, members, activeMembers };
    }
    function render() {
      const frame = replayAt(step);
      document.getElementById("meta").textContent =
        TIMELINE.workspaceName + " · Run " + TIMELINE.runId + (TIMELINE.tag ? " · Tag " + TIMELINE.tag : "") +
        " · " + EVENTS.length + " events";
      document.getElementById("stepLabel").textContent = EVENTS.length ? ("Step " + (step + 1) + " / " + EVENTS.length) : "0 events";
      scrub.value = String(step);
      document.getElementById("eventDetail").textContent = frame.cur
        ? ("#" + frame.cur.id + " · " + new Date(frame.cur.timestamp).toISOString() + " · " + frame.cur.type +
          (frame.cur.member ? " · " + frame.cur.member : "") + (frame.cur.taskId ? " · task " + frame.cur.taskId : ""))
        : "Initial state before events.";
      document.getElementById("teamGrid").innerHTML = frame.members.map((m) =>
        '<div class="card' + (frame.activeMembers.has(m.member) ? " pulse" : "") + '">' +
          '<strong>' + esc(m.member) + '</strong> <span class="muted">(' + esc(m.profile) + ')</span>' +
          '<div><span class="badge st-' + esc(m.status) + '">' + esc(m.status) + '</span></div></div>'
      ).join("");
      document.getElementById("taskWrap").innerHTML =
        '<table><thead><tr><th>Task</th><th>Owner</th><th>State</th><th>Note</th></tr></thead><tbody>' +
        frame.tasks.map((t) =>
          '<tr><td class="mono">' + esc(t.id) + '</td><td>' + esc(t.owner) + '</td>' +
          '<td><span class="badge st-' + esc(t.state) + '">' + esc(t.state) + '</span></td>' +
          '<td>' + esc(t.note || "") + '</td></tr>'
        ).join("") + '</tbody></table>';
      const mt = TIMELINE.metrics?.totals || {};
      const cost = mt.usage?.costUsd !== null && mt.usage?.costUsd !== undefined ? "$" + Number(mt.usage.costUsd).toFixed(4) : "Not reported";
      const tokens = mt.usage?.totalTokens !== null && mt.usage?.totalTokens !== undefined ? String(mt.usage.totalTokens) : "Not reported";
      document.getElementById("metricsWrap").innerHTML =
        '<table><thead><tr><th>Duration</th><th>Tasks Accepted</th><th>Handoffs</th><th>Revisions</th><th>Violations</th><th>Messages</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>' +
        '<tr><td>' + esc(fmtMs(TIMELINE.metrics?.durationMs)) + '</td><td>' + esc((mt.acceptedTasks ?? 0) + " / " + (mt.tasks ?? 0)) +
        '</td><td>' + esc(mt.handoffs ?? 0) + '</td><td>' + esc(mt.revisions ?? 0) + '</td><td>' + esc(mt.ownershipViolations ?? 0) +
        '</td><td>' + esc(mt.messagesSent ?? 0) + '</td><td>' + esc(tokens) + '</td><td>' + esc(cost) + '</td></tr></tbody></table>';
      document.getElementById("eventList").innerHTML = EVENTS.map((ev, idx) =>
        '<div class="ev' + (idx === step ? " current" : "") + '" data-idx="' + idx + '">' +
        '<span class="mono">#' + ev.id + '</span> <strong>' + esc(ev.type) + '</strong>' +
        (ev.member ? ' · ' + esc(ev.member) : '') + (ev.taskId ? ' · <span class="mono">' + esc(ev.taskId) + '</span>' : '') + '</div>'
      ).join("");
    }
    function stop() {
      if (timer) clearInterval(timer);
      timer = null;
      playBtn.textContent = "Play";
    }
    playBtn.addEventListener("click", () => {
      if (timer) { stop(); return; }
      if (!EVENTS.length) return;
      if (step >= EVENTS.length - 1) step = 0;
      playBtn.textContent = "Pause";
      render();
      timer = setInterval(() => {
        if (step >= EVENTS.length - 1) { stop(); return; }
        step += 1;
        render();
      }, Number(speedSel.value));
    });
    document.getElementById("prevBtn").addEventListener("click", () => { stop(); if (step > 0) { step -= 1; render(); } });
    document.getElementById("nextBtn").addEventListener("click", () => { stop(); if (step < EVENTS.length - 1) { step += 1; render(); } });
    scrub.addEventListener("input", () => { stop(); step = Number(scrub.value); render(); });
    document.getElementById("eventList").addEventListener("click", (e) => {
      const row = e.target.closest("[data-idx]");
      if (!row) return;
      stop();
      step = Number(row.dataset.idx);
      render();
    });
    render();
  </script>
</body>
</html>
`;
}

export function writeRunExport(
  runId: string,
  options: { format: "json" | "html"; outputPath?: string; baseDir?: string },
): { path: string; format: "json" | "html"; bytes: number } {
  const timeline = loadRunTimeline(runId, options.baseDir);
  if (!timeline) {
    throw new Error(`No recorded timeline found for run ${runId}.`);
  }
  const content = options.format === "html" ? exportRunHtml(timeline) : exportRunJson(timeline);
  const ext = options.format === "html" ? "html" : "json";
  const outputPath = resolve(options.outputPath ?? `agent-pair-${runId}.${ext}`);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, content, "utf8");
  return { path: outputPath, format: options.format, bytes: Buffer.byteLength(content, "utf8") };
}
