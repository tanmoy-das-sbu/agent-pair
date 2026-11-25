import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { listBenchTasks, runBenchmark, runHiddenAcceptance } from "./runner.mjs";
import { generateMarkdownSummary } from "./summarize.mjs";

const benchDir = dirname(fileURLToPath(import.meta.url));

function tempDir(t) {
  const parent = realpathSync(tmpdir());
  const dir = mkdtempSync(join(parent, "agent-pair-bench-test-"));
  t.after(() => {
    if (dirname(resolve(dir)) === parent) rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("all benchmark tasks exist and their starter code fails hidden acceptance tests", () => {
  const tasks = listBenchTasks();
  assert.ok(tasks.length >= 3 && tasks.length <= 5, `Expected 3-5 tasks, found ${tasks.length}`);
  for (const task of tasks) {
    assert.ok(existsSync(task.starterDir), `Missing starter dir for ${task.id}`);
    assert.ok(existsSync(task.hiddenTestPath), `Missing hidden acceptance test for ${task.id}`);
    const starterOutcome = runHiddenAcceptance(task.starterDir, task.hiddenTestPath);
    assert.notEqual(starterOutcome.exitCode, 0, `Starter code for ${task.id} should fail hidden acceptance tests`);
  }
});

test("runner executes --dry-run with stub agents across solo and team modes and writes valid results JSON", (t) => {
  const dir = tempDir(t);
  const outPath = join(dir, "dry-run.json");
  const { report, outputPath } = runBenchmark({ dryRun: true, mode: "both", out: outPath });

  assert.equal(outputPath, resolve(outPath));
  assert.equal(existsSync(outPath), true);
  assert.equal(report.dryRun, true);
  assert.equal(report.syntheticFixture, false);
  assert.equal(report.results.length, 8); // 4 tasks x 2 modes

  for (const entry of report.results) {
    assert.equal(entry.status, "passed", `Expected ${entry.taskId} (${entry.mode}) to pass`);
    assert.equal(entry.testPassRate, 1);
    assert.equal(entry.mergeConflicts, 0);
    assert.equal(entry.rejectedHandoffs, 0);
    assert.equal(entry.tokens, null);
    assert.equal(entry.costUsd, null);
    assert.ok(entry.wallTimeMs >= 0);
  }

  const parsed = JSON.parse(readFileSync(outPath, "utf8"));
  assert.equal(parsed.results.length, 8);
});

test("summary generator produces a markdown comparison table from fixture results", () => {
  const fixturePath = join(benchDir, "fixtures", "sample-results.json");
  const md = generateMarkdownSummary([fixturePath]);

  assert.match(md, /^# Benchmark Summary \(Team vs Solo\)/m);
  assert.match(md, /synthetic fixture/i);
  assert.match(md, /\| 01-cli-flag \| solo \| passed \| 100\.0% \(3\/3\) \| 12\.00 s \| 0 \| 0 \| 2,400 \| \$0\.0180 \|/);
  assert.match(md, /\| 01-cli-flag \| team \| passed \| 100\.0% \(3\/3\) \| 9\.50 s \| 0 \| 1 \| Not reported \| Not reported \|/);
  assert.match(md, /## Mode Averages/);
});
