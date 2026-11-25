import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { DashboardServer } from "../../dist/dashboard.js";
import { Relay } from "../../dist/relay.js";

function tempDir(t) {
  const parent = realpathSync(tmpdir());
  const dir = mkdtempSync(join(parent, "agent-pair-dash-replay-"));
  t.after(() => {
    if (dirname(resolve(dir)) === parent) rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("dashboard exposes replay timeline endpoints and offline JSON/HTML export", async (t) => {
  const dir = tempDir(t);
  let clock = 100_000;
  const relay = new Relay(dir, () => clock);
  const dashboard = new DashboardServer(relay, dir);
  t.after(() => dashboard.close());

  const url = await dashboard.ensureStarted();
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
  clock += 1_000;
  await relay.execute({ action: "teamUpdate", role: "codex", handle: started.handle, taskId: "t1", transition: "start" }, signal);
  clock += 2_000;
  await relay.execute({ action: "teamUpdate", role: "codex", handle: started.handle, taskId: "t1", transition: "handoff", note: "ready", checks: ["ok"] }, signal);
  clock += 1_000;
  await relay.execute({ action: "teamUpdate", role: "codex", handle: started.handle, taskId: "t1", transition: "accept" }, signal);
  clock += 1_000;
  await relay.execute({ action: "disconnect", role: "codex", handle: started.handle }, signal);

  const page = await fetch(url);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /id="replayBtn"/);
  assert.match(html, /id="replayPanel"/);

  const listRes = await fetch(`${url}api/timelines`);
  assert.equal(listRes.status, 200);
  const list = await listRes.json();
  assert.equal(list.runs.length, 1);
  assert.equal(list.runs[0].runId, started.runId);
  assert.equal(list.runs[0].closedAt, 105_000);

  const tlRes = await fetch(`${url}api/timeline?runId=${encodeURIComponent(started.runId)}`);
  assert.equal(tlRes.status, 200);
  const tl = await tlRes.json();
  assert.ok(tl.events.length >= 5);

  const exportJsonRes = await fetch(`${url}api/export?runId=${encodeURIComponent(started.runId)}&format=json`);
  assert.equal(exportJsonRes.status, 200);
  const exportedJson = await exportJsonRes.json();
  assert.equal(exportedJson.finalState.tasks.find((task) => task.id === "t1")?.state, "accepted");

  const exportHtmlRes = await fetch(`${url}api/export?runId=${encodeURIComponent(started.runId)}&format=html`);
  assert.equal(exportHtmlRes.status, 200);
  const exportedHtml = await exportHtmlRes.text();
  assert.match(exportedHtml, /Agent Pair — Offline Run Report/);
  assert.doesNotMatch(exportedHtml, /<(script|link)[^>]+https?:\/\//i);
});
