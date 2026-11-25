import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  buildRunTimeline,
  exportRunHtml,
  exportRunJson,
  listSavedTimelines,
  loadRunTimeline,
  replayRunAt,
  saveRunTimeline,
  sortTimelineEvents,
  TimelineRecorder,
  writeRunExport,
} from "../../dist/metrics/index.js";
import { Relay } from "../../dist/relay.js";

function tempDir(t) {
  const parent = realpathSync(tmpdir());
  const dir = mkdtempSync(join(parent, "agent-pair-replay-"));
  t.after(() => {
    if (dirname(resolve(dir)) === parent) rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const fixtureRun = {
  id: "run-replay-1",
  mode: "team",
  workspace: "D:\\Projects\\fixture",
  workspaceName: "fixture",
  tag: "9K2M",
  missingSessionIds: [],
  waitingFor: 0,
  createdAt: 1_000,
  expiresAt: 60_000,
  members: [
    { member: "orchestrator", profile: "codex", isOrchestrator: true, connected: true, claimed: true, hasSessionId: true, status: "done", unread: 0 },
    { member: "worker-b", profile: "antigravity", isOrchestrator: false, connected: true, claimed: true, hasSessionId: true, status: "done", unread: 0 },
  ],
  tasks: [
    { id: "t1", owner: "orchestrator", profile: "codex", title: "Core", paths: ["src/core"], checks: ["pass"], dependsOn: [], state: "accepted", note: "Core ok" },
    { id: "t2", owner: "worker-b", profile: "antigravity", title: "UI", paths: ["src/ui"], checks: ["pass"], dependsOn: ["t1"], state: "accepted", note: "UI fixed" },
  ],
  messages: [
    { id: 1, taskId: "t2", kind: "handoff", body: "Ready for review", from: "worker-b", to: "orchestrator", createdAt: new Date(10_000).toISOString(), acknowledged: true },
  ],
  // Deliberately out of order to verify deterministic sorting by monotonic id
  events: [
    { id: 10, timestamp: 12_000, runId: "run-replay-1", type: "task.accepted", member: "orchestrator", taskId: "t2", data: { state: "accepted", note: "UI fixed" } },
    { id: 2, timestamp: 1_100, runId: "run-replay-1", type: "member.joined", member: "orchestrator", data: { profile: "codex" } },
    { id: 1, timestamp: 1_000, runId: "run-replay-1", type: "run.started" },
    { id: 5, timestamp: 4_000, runId: "run-replay-1", type: "task.handoff", member: "orchestrator", taskId: "t1", data: { state: "ready", note: "Core ok", checks: ["ok"] } },
    { id: 3, timestamp: 1_200, runId: "run-replay-1", type: "member.joined", member: "worker-b", data: { profile: "antigravity" } },
    { id: 6, timestamp: 5_000, runId: "run-replay-1", type: "task.accepted", member: "orchestrator", taskId: "t1", data: { state: "accepted", note: "Core ok" } },
    { id: 4, timestamp: 2_000, runId: "run-replay-1", type: "task.started", member: "orchestrator", taskId: "t1", data: { state: "active" } },
    { id: 7, timestamp: 6_000, runId: "run-replay-1", type: "task.started", member: "worker-b", taskId: "t2", data: { state: "active" } },
    { id: 8, timestamp: 9_000, runId: "run-replay-1", type: "task.handoff", member: "worker-b", taskId: "t2", data: { state: "ready", note: "UI done", checks: ["ok"] } },
    { id: 9, timestamp: 10_000, runId: "run-replay-1", type: "message.sent", member: "worker-b", taskId: "t2", data: { message: { id: 1, taskId: "t2", kind: "handoff", from: "worker-b", to: "orchestrator", body: "Ready for review", createdAt: new Date(10_000).toISOString() } } },
  ],
};

test("sorts timeline events deterministically and replays fixture run to final task states", () => {
  const sorted = sortTimelineEvents(fixtureRun.events);
  assert.deepEqual(sorted.map((e) => e.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  const timeline = buildRunTimeline(fixtureRun);
  assert.deepEqual(timeline.events.map((e) => e.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  const initial = replayRunAt(timeline, -1);
  assert.deepEqual(initial.run.tasks.map((t) => t.state), ["pending", "pending"]);
  assert.deepEqual(initial.run.members.map((m) => m.status), ["waiting", "waiting"]);

  const mid = replayRunAt(timeline, 6); // after event id 7: t1 accepted, t2 active
  assert.deepEqual(mid.run.tasks.map((t) => t.state), ["accepted", "active"]);
  assert.equal(mid.run.members.find((m) => m.member === "worker-b")?.status, "working");

  const finalFrame = replayRunAt(timeline, timeline.events.length - 1);
  assert.deepEqual(
    finalFrame.run.tasks.map((t) => ({ id: t.id, state: t.state })),
    fixtureRun.tasks.map((t) => ({ id: t.id, state: t.state })),
  );
  assert.deepEqual(finalFrame.run.members.map((m) => m.status), ["done", "done"]);
  assert.equal(finalFrame.run.messages.length, 1);
});

test("exports self-contained JSON and offline static HTML reports", (t) => {
  const dir = tempDir(t);
  const timeline = buildRunTimeline(fixtureRun);
  saveRunTimeline(timeline, dir);
  assert.deepEqual(listSavedTimelines(dir), ["run-replay-1"]);
  assert.equal(loadRunTimeline("run-replay-1", dir)?.events.length, 10);

  const jsonText = exportRunJson(timeline);
  const parsed = JSON.parse(jsonText);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.timeline.runId, "run-replay-1");
  assert.deepEqual(parsed.finalState.tasks.map((task) => task.state), ["accepted", "accepted"]);

  const html = exportRunHtml(timeline);
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /Agent Pair — Offline Run Report/);
  assert.match(html, /id="run-data" type="application\/json"/);
  // Offline guarantee: no external http(s) script or stylesheet URLs
  assert.doesNotMatch(html, /<(script|link)[^>]+https?:\/\//i);

  const outHtml = join(dir, "report.html");
  const written = writeRunExport("run-replay-1", { format: "html", outputPath: outHtml, baseDir: dir });
  assert.equal(written.format, "html");
  assert.ok(written.bytes > 1000);
  assert.equal(readFileSync(outHtml, "utf8"), html);
});

test("TimelineRecorder persists live relay runs without dashboard clients and finalizes on close", async (t) => {
  const dir = tempDir(t);
  let clock = 50_000;
  const relay = new Relay(dir, () => clock);
  const recorder = new TimelineRecorder(dir);
  const detach = recorder.attach(relay);
  t.after(() => detach());

  const signal = new AbortController().signal;
  const started = await relay.execute({
    action: "teamStart",
    role: "codex",
    workspace: dir,
    enforce: "off",
    workerCount: 1,
    allowedProfiles: ["antigravity"],
    assignments: [
      { id: "a", owner: "orchestrator", profile: "codex", title: "A", paths: ["src/a"], checks: ["ok"] },
      { id: "b", owner: "worker-b", profile: "antigravity", title: "B", paths: ["src/b"], checks: ["ok"] },
    ],
  }, signal);

  clock += 1_000;
  await relay.execute({ action: "teamUpdate", role: "codex", handle: started.handle, taskId: "a", transition: "start" }, signal);
  clock += 1_000;
  await relay.execute({ action: "teamUpdate", role: "codex", handle: started.handle, taskId: "a", transition: "handoff", note: "done", checks: ["ok"] }, signal);
  clock += 500;
  await relay.execute({ action: "teamUpdate", role: "codex", handle: started.handle, taskId: "a", transition: "accept" }, signal);
  clock += 500;
  await relay.execute({ action: "disconnect", role: "codex", handle: started.handle }, signal);

  const saved = loadRunTimeline(started.runId, dir);
  assert.ok(saved);
  assert.equal(saved.closedAt, 53_000);
  const replayed = replayRunAt(saved, saved.events.length - 1);
  assert.equal(replayed.run.tasks.find((task) => task.id === "a")?.state, "accepted");
  assert.equal(replayed.run.tasks.find((task) => task.id === "b")?.state, "pending");
});
