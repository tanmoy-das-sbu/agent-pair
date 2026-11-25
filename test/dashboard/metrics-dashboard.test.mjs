import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { DashboardServer } from "../../dist/dashboard.js";
import { loadRunMetrics } from "../../dist/metrics/index.js";
import { Relay } from "../../dist/relay.js";

function tempDir(t) {
  const parent = realpathSync(tmpdir());
  const dir = mkdtempSync(join(parent, "agent-pair-dash-metrics-"));
  t.after(() => {
    if (dirname(resolve(dir)) === parent) rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("dashboard serves run metrics, persists metrics JSON, and accepts optional usage reports", async (t) => {
  const dir = tempDir(t);
  let clock = 10_000;
  const relay = new Relay(dir, () => clock);
  const dashboard = new DashboardServer(relay, dir);
  t.after(() => dashboard.close());

  const url = await dashboard.ensureStarted();
  const origin = new URL(url).origin;
  const signal = new AbortController().signal;

  const started = await relay.execute({
    action: "teamStart",
    role: "codex",
    workspace: dir,
    enforce: "off",
    workerCount: 1,
    allowedProfiles: ["antigravity"],
    assignments: [
      { id: "api", owner: "orchestrator", profile: "codex", title: "API", paths: ["src/api"], checks: ["pass"] },
      { id: "ui", owner: "worker-b", profile: "antigravity", title: "UI", paths: ["src/ui"], checks: ["pass"] },
    ],
  }, signal);

  clock += 1_000;
  const worker = await relay.execute({ action: "teamJoin", role: "antigravity", workspace: dir }, signal);

  clock += 1_000;
  await relay.execute({ action: "teamUpdate", role: "antigravity", handle: worker.handle, taskId: "ui", transition: "start" }, signal);
  clock += 3_000;
  await relay.execute({ action: "teamUpdate", role: "antigravity", handle: worker.handle, taskId: "ui", transition: "handoff", note: "Done", checks: ["ok"] }, signal);
  clock += 1_000;
  await relay.execute({ action: "teamUpdate", role: "codex", handle: started.handle, taskId: "ui", transition: "revise", note: "Fix spacing" }, signal);
  clock += 1_000;
  await relay.execute({ action: "send", role: "codex", handle: started.handle, taskId: "ui", kind: "update", body: "Please adjust", requestId: "m1" }, signal);

  const page = await fetch(url);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Metrics &amp; Cost/);
  assert.match(html, /Not reported/);

  const stateRes = await fetch(`${url}api/state`);
  assert.equal(stateRes.status, 200);
  const state = await stateRes.json();
  assert.equal(state.runs.length, 1);
  const runMetrics = state.runs[0].metrics;
  assert.equal(runMetrics.totals.handoffs, 1);
  assert.equal(runMetrics.totals.revisions, 1);
  assert.equal(runMetrics.totals.messagesSent, 1);
  assert.equal(runMetrics.tasks.ui.activeTimeMs, 3_000);
  assert.equal(runMetrics.totals.usage.costUsd, null);
  assert.equal(runMetrics.totals.usage.totalTokens, null);

  const persistedBefore = loadRunMetrics(started.runId, dir);
  assert.equal(persistedBefore?.totals.revisions, 1);

  const usageRes = await fetch(`${url}api/metrics/usage`, {
    method: "POST",
    headers: { origin, "Content-Type": "application/json" },
    body: JSON.stringify({
      runId: started.runId,
      member: "worker-b",
      taskId: "ui",
      inputTokens: 900,
      outputTokens: 300,
      costUsd: 0.021,
      model: "antigravity-pro",
    }),
  });
  assert.equal(usageRes.status, 201);
  const usageBody = await usageRes.json();
  assert.equal(usageBody.metrics.totals.usage.totalTokens, 1200);
  assert.equal(usageBody.metrics.totals.usage.costUsd, 0.021);

  const metricsApi = await fetch(`${url}api/metrics?runId=${encodeURIComponent(started.runId)}`);
  assert.equal(metricsApi.status, 200);
  const fetched = await metricsApi.json();
  assert.equal(fetched.agents["worker-b"].usage.costUsd, 0.021);
  assert.equal(fetched.agents.orchestrator.usage.costUsd, null);

  clock += 2_000;
  await relay.execute({ action: "disconnect", role: "codex", handle: started.handle }, signal);
  const afterClose = loadRunMetrics(started.runId, dir);
  assert.equal(afterClose?.closedAt, clock);
  assert.equal(afterClose?.totals.usage.costUsd, 0.021);
});

test("DashboardServer persists per-run metrics even when HTTP server is never started and retains them on close", async (t) => {
  const dir = tempDir(t);
  let clock = 20_000;
  const relay = new Relay(dir, () => clock);
  const dashboard = new DashboardServer(relay, dir);
  t.after(() => dashboard.close());
  assert.equal(dashboard.isStarted, false);

  const signal = new AbortController().signal;
  const started = await relay.execute({
    action: "teamStart",
    role: "codex",
    workspace: dir,
    enforce: "off",
    workerCount: 1,
    allowedProfiles: ["antigravity"],
    assignments: [
      { id: "t1", owner: "orchestrator", profile: "codex", title: "T1", paths: ["src/t1"], checks: ["ok"] },
      { id: "t2", owner: "worker-b", profile: "antigravity", title: "T2", paths: ["src/t2"], checks: ["ok"] },
    ],
  }, signal);

  clock += 1_500;
  await relay.execute({ action: "teamUpdate", role: "codex", handle: started.handle, taskId: "t1", transition: "start" }, signal);
  clock += 2_500;
  await relay.execute({ action: "teamUpdate", role: "codex", handle: started.handle, taskId: "t1", transition: "handoff", note: "ready", checks: ["ok"] }, signal);
  clock += 500;
  await relay.execute({ action: "teamUpdate", role: "codex", handle: started.handle, taskId: "t1", transition: "accept" }, signal);

  const persistedActive = loadRunMetrics(started.runId, dir);
  assert.equal(persistedActive?.totals.acceptedTasks, 1);
  assert.equal(persistedActive?.tasks.t1.wallTimeMs, 3_000);

  clock += 500;
  await relay.execute({ action: "disconnect", role: "codex", handle: started.handle }, signal);
  assert.equal(dashboard.isStarted, false);

  const persistedClosed = loadRunMetrics(started.runId, dir);
  assert.equal(persistedClosed?.closedAt, 25_000);
  assert.equal(persistedClosed?.totals.acceptedTasks, 1);
});
