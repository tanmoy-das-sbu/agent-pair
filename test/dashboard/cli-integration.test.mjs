import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliEntry = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const repoRoot = resolve(dirname(cliEntry), "..");

function tempDir(t) {
  const parent = realpathSync(tmpdir());
  const dir = mkdtempSync(join(parent, "agent-pair-cli-int-"));
  t.after(() => {
    if (dirname(resolve(dir)) === parent) rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("CLI help, team-start flags, replay, export, and bench forwarding work end-to-end", (t) => {
  const dir = tempDir(t);
  const workspace = join(dir, "workspace");
  const dataDir = join(dir, "data");
  mkdirSync(workspace, { recursive: true });
  const env = {
    ...process.env,
    AGENT_PAIR_DATA_DIR: dataDir,
    AGENT_PAIR_NO_DASHBOARD: "1",
  };
  const runCli = (args, cwd = repoRoot) => execFileSync(process.execPath, [cliEntry, ...args], {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });

  // 1. Help text exposes all v0.4 commands and flags
  const helpText = runCli(["--help"]);
  for (const token of ["team-start", "replay", "export", "bench", "--enforce", "--isolation", "--persist", "--stall-timeout-ms", "--experimental-adapters", "--tmux"]) {
    assert.ok(helpText.includes(token), `Expected --help to include ${token}`);
  }

  // 2. team-start parses flags, starts a team, records timeline, and closes cleanly
  const teamInputPath = join(dir, "team.json");
  writeFileSync(teamInputPath, JSON.stringify({
    workspace,
    workerCount: 1,
    allowedProfiles: ["antigravity"],
    assignments: [
      { id: "core", owner: "orchestrator", profile: "codex", title: "Core", paths: ["src/core"], checks: ["pass"] },
      { id: "ui", owner: "worker-b", profile: "antigravity", title: "UI", paths: ["src/ui"], checks: ["pass"] },
    ],
  }), "utf8");

  const started = JSON.parse(runCli([
    "team-start",
    "--input", teamInputPath,
    "--profile", "codex",
    "--enforce", "warn",
    "--isolation", "shared",
    "--persist",
    "--stall-timeout-ms", "5000",
  ]));
  assert.ok(started.runId);
  assert.equal(started.waitingFor, 1);

  const closed = JSON.parse(runCli(["close", started.runId]));
  assert.equal(closed.closed, true);

  // 3. replay and export work against the recorded timeline after close
  const replayUrl = runCli(["replay", started.runId, "--no-open"]).trim();
  assert.match(replayUrl, new RegExp(`^http://127\\.0\\.0\\.1:\\d+/d/[a-f0-9]{32}/\\?replay=${started.runId}$`));
  assert.throws(() => runCli(["replay", "nonexistent-run", "--no-open"]), /No recorded timeline found/);

  const outJson = join(dir, "out.json");
  const outHtml = join(dir, "out.html");
  const jsonMeta = JSON.parse(runCli(["export", started.runId, "--format", "json", "--output", outJson]));
  assert.equal(jsonMeta.format, "json");
  assert.equal(existsSync(outJson), true);
  assert.equal(JSON.parse(readFileSync(outJson, "utf8")).timeline.runId, started.runId);

  const htmlMeta = JSON.parse(runCli(["export", started.runId, "--format", "html", "--output", outHtml]));
  assert.equal(htmlMeta.format, "html");
  assert.equal(existsSync(outHtml), true);
  assert.match(readFileSync(outHtml, "utf8"), /Agent Pair — Offline Run Report/);

  // 4. bench forwarding works for both runner --dry-run and summarize
  const benchOut = join(dir, "bench-cli.json");
  const benchStdout = runCli(["bench", "--dry-run", "--tasks", "01-cli-flag", "--out", benchOut]);
  assert.match(benchStdout, /2\/2 runs passed/);
  assert.equal(existsSync(benchOut), true);

  const summaryStdout = runCli(["bench", "summarize", join(repoRoot, "bench", "fixtures", "sample-results.json")]);
  assert.match(summaryStdout, /# Benchmark Summary \(Team vs Solo\)/);
  assert.match(summaryStdout, /01-cli-flag/);
});
