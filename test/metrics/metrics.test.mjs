import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  aggregateRunMetrics,
  attachMetricsTracker,
  listSavedMetrics,
  loadRunMetrics,
  MetricsTracker,
  saveRunMetrics,
} from "../../dist/metrics/index.js";
import { Relay } from "../../dist/relay.js";

function tempDir(t) {
  const parent = realpathSync(tmpdir());
  const dir = mkdtempSync(join(parent, "agent-pair-metrics-"));
  t.after(() => {
    if (dirname(resolve(dir)) === parent) rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const fixtureTasks = [
  { id: "t1", owner: "orchestrator", profile: "codex", title: "Core API", paths: ["src/api"], checks: ["test"], dependsOn: [], state: "accepted" },
  { id: "t2", owner: "worker-b", profile: "antigravity", title: "UI Panel", paths: ["src/ui"], checks: ["test"], dependsOn: ["t1"], state: "accepted" },
];

const fixtureMembers = [
  { member: "orchestrator", profile: "codex", isOrchestrator: true, connected: true, claimed: true, hasSessionId: true, status: "done", unread: 0 },
  { member: "worker-b", profile: "antigravity", isOrchestrator: false, connected: true, claimed: true, hasSessionId: true, status: "done", unread: 0 },
];

const fixtureEvents = [
  { id: 1, timestamp: 1_000, runId: "run-1", type: "run.started" },
  { id: 2, timestamp: 1_100, runId: "run-1", type: "member.joined", member: "orchestrator", data: { profile: "codex" } },
  { id: 3, timestamp: 1_200, runId: "run-1", type: "member.joined", member: "worker-b", data: { profile: "antigravity" } },
  { id: 4, timestamp: 2_000, runId: "run-1", type: "task.started", member: "orchestrator", taskId: "t1", data: { state: "active" } },
  { id: 5, timestamp: 5_000, runId: "run-1", type: "task.handoff", member: "orchestrator", taskId: "t1", data: { state: "ready" } },
  { id: 6, timestamp: 6_000, runId: "run-1", type: "task.accepted", member: "orchestrator", taskId: "t1", data: { state: "accepted" } },
  { id: 7, timestamp: 6_500, runId: "run-1", type: "message.sent", member: "orchestrator", taskId: "t2", data: { message: { id: 1, from: "orchestrator", to: "worker-b", taskId: "t2" } } },
  { id: 8, timestamp: 6_800, runId: "run-1", type: "message.acked", member: "worker-b", taskId: "t2", data: { messageId: 1 } },
  { id: 9, timestamp: 7_000, runId: "run-1", type: "task.started", member: "worker-b", taskId: "t2", data: { state: "active" } },
  { id: 10, timestamp: 9_000, runId: "run-1", type: "ownership.violation", member: "worker-b", taskId: "t2", data: { files: ["src/api/secret.ts"], mode: "strict", rejected: true } },
  { id: 11, timestamp: 11_000, runId: "run-1", type: "task.handoff", member: "worker-b", taskId: "t2", data: { state: "ready" } },
  { id: 12, timestamp: 12_000, runId: "run-1", type: "task.revised", member: "orchestrator", taskId: "t2", data: { state: "pending", note: "Add edge case test" } },
  { id: 13, timestamp: 13_000, runId: "run-1", type: "task.started", member: "worker-b", taskId: "t2", data: { state: "active" } },
  { id: 14, timestamp: 16_000, runId: "run-1", type: "task.handoff", member: "worker-b", taskId: "t2", data: { state: "ready" } },
  { id: 15, timestamp: 17_000, runId: "run-1", type: "task.accepted", member: "orchestrator", taskId: "t2", data: { state: "accepted" } },
];

test("aggregates task timings, rejections, ownership violations, messages, and optional usage reports", () => {
  const metrics = aggregateRunMetrics({
    runId: "run-1",
    events: fixtureEvents,
    tasks: fixtureTasks,
    members: fixtureMembers,
    usageReports: [
      { runId: "run-1", member: "worker-b", taskId: "t2", inputTokens: 1200, outputTokens: 800, costUsd: 0.0425, model: "gemini" },
      { runId: "run-1", member: "orchestrator", taskId: "t1", inputTokens: 500, outputTokens: 250, costUsd: 0.015, model: "codex" },
    ],
    now: 20_000,
  });

  assert.equal(metrics.startedAt, 1_000);
  assert.equal(metrics.durationMs, 19_000);
  assert.equal(metrics.eventCount, 15);
  assert.equal(metrics.totals.tasks, 2);
  assert.equal(metrics.totals.acceptedTasks, 2);
  assert.equal(metrics.totals.handoffs, 3);
  assert.equal(metrics.totals.revisions, 1);
  assert.equal(metrics.totals.ownershipViolations, 1);
  assert.equal(metrics.totals.ownershipRejections, 1);
  assert.equal(metrics.totals.messagesSent, 1);
  assert.equal(metrics.totals.messagesAcked, 1);

  assert.equal(metrics.tasks.t1.wallTimeMs, 4_000);
  assert.equal(metrics.tasks.t1.activeTimeMs, 3_000);
  assert.equal(metrics.tasks.t2.wallTimeMs, 10_000);
  assert.equal(metrics.tasks.t2.activeTimeMs, 7_000);
  assert.equal(metrics.tasks.t2.handoffCount, 2);
  assert.equal(metrics.tasks.t2.revisionCount, 1);
  assert.equal(metrics.tasks.t2.ownershipViolationCount, 1);
  assert.equal(metrics.tasks.t2.ownershipRejectionCount, 1);
  assert.equal(metrics.tasks.t2.messageCount, 1);

  assert.equal(metrics.agents["worker-b"].revisionsReceived, 1);
  assert.equal(metrics.agents["worker-b"].ownershipViolations, 1);
  assert.equal(metrics.agents["worker-b"].handoffsSubmitted, 2);
  assert.equal(metrics.agents["worker-b"].messagesReceived, 1);
  assert.equal(metrics.agents["worker-b"].messagesAcked, 1);
  assert.equal(metrics.agents.orchestrator.messagesSent, 1);

  assert.equal(metrics.totals.usage.totalTokens, 2750);
  assert.equal(metrics.totals.usage.costUsd, 0.0575);
  assert.deepEqual(metrics.totals.usage.models, ["codex", "gemini"]);
  assert.equal(metrics.tasks.t2.usage.totalTokens, 2000);
  assert.equal(metrics.tasks.t2.usage.costUsd, 0.0425);
});

test("degrades gracefully when token and cost data are missing", () => {
  const metrics = aggregateRunMetrics({
    runId: "run-1",
    events: fixtureEvents,
    tasks: fixtureTasks,
    members: fixtureMembers,
    now: 20_000,
  });

  assert.equal(metrics.totals.usage.inputTokens, null);
  assert.equal(metrics.totals.usage.outputTokens, null);
  assert.equal(metrics.totals.usage.totalTokens, null);
  assert.equal(metrics.totals.usage.costUsd, null);
  assert.equal(metrics.totals.usage.reportCount, 0);
  assert.equal(metrics.tasks.t1.usage.costUsd, null);
  assert.equal(metrics.agents["worker-b"].usage.totalTokens, null);
});

test("persists per-run metrics as JSON and reloads cleanly", (t) => {
  const dir = tempDir(t);
  const metrics = aggregateRunMetrics({
    runId: "run-persist-1",
    events: fixtureEvents.map((ev) => ({ ...ev, runId: "run-persist-1" })),
    tasks: fixtureTasks,
    members: fixtureMembers,
    now: 20_000,
  });

  const savedPath = saveRunMetrics(metrics, dir);
  assert.ok(savedPath.endsWith("run-persist-1.json"));
  assert.deepEqual(listSavedMetrics(dir), ["run-persist-1"]);
  const loaded = loadRunMetrics("run-persist-1", dir);
  assert.deepEqual(loaded, metrics);
  assert.equal(loadRunMetrics("missing-run", dir), null);
  assert.throws(() => saveRunMetrics({ ...metrics, runId: "../escape" }, dir), /Invalid run ID/);
});

test("MetricsTracker syncs snapshots and attaches usage reports", (t) => {
  const dir = tempDir(t);
  const tracker = new MetricsTracker(dir);
  const snapshot = {
    now: 20_000,
    pendingPairs: [],
    setups: [],
    runs: [{
      id: "run-track-1",
      mode: "team",
      workspace: dir,
      workspaceName: "demo",
      missingSessionIds: [],
      waitingFor: 0,
      createdAt: 1_000,
      expiresAt: 60_000,
      members: fixtureMembers,
      tasks: fixtureTasks,
      messages: [],
      events: fixtureEvents.map((ev) => ({ ...ev, runId: "run-track-1" })),
    }],
  };

  const first = tracker.syncSnapshot(snapshot);
  assert.equal(first["run-track-1"].totals.usage.costUsd, null);

  tracker.recordUsage({
    runId: "run-track-1",
    member: "worker-b",
    taskId: "t2",
    totalTokens: 1500,
    costUsd: 0.03,
  });

  const updated = tracker.getMetrics("run-track-1");
  assert.equal(updated?.totals.usage.totalTokens, 1500);
  assert.equal(updated?.totals.usage.costUsd, 0.03);
  const onDisk = loadRunMetrics("run-track-1", dir);
  assert.equal(onDisk?.totals.usage.costUsd, 0.03);
});

test("attachMetricsTracker persists live relay events without dashboard clients and retains final metrics on close", async (t) => {
  const dir = tempDir(t);
  let clock = 5_000;
  const relay = new Relay(dir, () => clock);
  const { tracker, detach } = attachMetricsTracker(relay, dir);
  t.after(() => detach());

  const signal = new AbortController().signal;
  const run = await relay.execute({
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
  const worker = await relay.execute({ action: "teamJoin", role: "antigravity", workspace: dir }, signal);
  clock += 500;
  await relay.execute({ action: "teamUpdate", role: "antigravity", handle: worker.handle, taskId: "b", transition: "start" }, signal);
  clock += 2_000;
  await relay.execute({ action: "teamUpdate", role: "antigravity", handle: worker.handle, taskId: "b", transition: "handoff", note: "done", checks: ["ok"] }, signal);
  clock += 500;
  await relay.execute({ action: "teamUpdate", role: "codex", handle: run.handle, taskId: "b", transition: "accept" }, signal);

  const beforeClose = loadRunMetrics(run.runId, dir);
  assert.equal(beforeClose?.totals.acceptedTasks, 1);
  assert.equal(beforeClose?.closedAt, undefined);

  clock += 1_000;
  await relay.execute({ action: "disconnect", role: "codex", handle: run.handle }, signal);

  const afterClose = loadRunMetrics(run.runId, dir);
  assert.equal(afterClose?.totals.acceptedTasks, 1);
  assert.equal(afterClose?.tasks.b.wallTimeMs, 2_500);
  assert.equal(afterClose?.closedAt, 10_000);
  assert.equal(afterClose?.durationMs, 5_000);
  assert.equal(tracker.getMetrics(run.runId)?.closedAt, 10_000);
});
