#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const benchRoot = dirname(fileURLToPath(import.meta.url));
const tasksRoot = join(benchRoot, "tasks");
const defaultResultsDir = join(benchRoot, "results");

export function listBenchTasks() {
  return readdirSync(tasksRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((id) => {
      const dir = join(tasksRoot, id);
      const manifest = JSON.parse(readFileSync(join(dir, "task.json"), "utf8"));
      return {
        ...manifest,
        dir,
        starterDir: join(dir, "starter"),
        hiddenTestPath: join(dir, "hidden", "acceptance.test.mjs"),
      };
    });
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Agent Pair Bench",
      GIT_AUTHOR_EMAIL: "bench@agent-pair.local",
      GIT_COMMITTER_NAME: "Agent Pair Bench",
      GIT_COMMITTER_EMAIL: "bench@agent-pair.local",
    },
  });
  return result;
}

function initTaskRepo(starterDir, parentDir, label) {
  const repoDir = join(parentDir, label);
  cpSync(starterDir, repoDir, { recursive: true });
  const init = runGit(repoDir, ["init", "-b", "main"]);
  if (init.status !== 0) {
    runGit(repoDir, ["init"]);
    runGit(repoDir, ["checkout", "-B", "main"]);
  }
  runGit(repoDir, ["config", "user.name", "Agent Pair Bench"]);
  runGit(repoDir, ["config", "user.email", "bench@agent-pair.local"]);
  runGit(repoDir, ["add", "."]);
  const commit = runGit(repoDir, ["commit", "-m", "starter"]);
  if (commit.status !== 0) {
    throw new Error(`Failed to initialize benchmark repo: ${commit.stderr || commit.stdout}`);
  }
  return repoDir;
}

function writeFiles(rootDir, fileMap) {
  for (const [relPath, content] of Object.entries(fileMap)) {
    const abs = join(rootDir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
}

function buildPlanMarkdown(task) {
  const lines = [
    `# Benchmark Plan: ${task.title}`,
    "",
    task.description,
    "",
    "## Assignments",
    "",
  ];
  for (const item of task.teamPlan) {
    lines.push(`### ${item.id}: ${item.title}`);
    lines.push(`- Owner: ${item.owner}`);
    lines.push(`- Owned paths: ${item.paths.join(", ")}`);
    lines.push("- Acceptance: `node --test test/public.test.mjs` passes.");
    lines.push("");
  }
  return lines.join("\n");
}

export function runHiddenAcceptance(workspaceDir, hiddenTestPath) {
  const env = { ...process.env, BENCH_WORKSPACE: workspaceDir };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", basename(hiddenTestPath)], {
    cwd: dirname(hiddenTestPath),
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    env,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const passMatch = /^# pass (\d+)/m.exec(output);
  const failMatch = /^# fail (\d+)/m.exec(output);
  const totalMatch = /^# tests (\d+)/m.exec(output);
  const passed = passMatch ? Number(passMatch[1]) : 0;
  const failed = failMatch ? Number(failMatch[1]) : (result.status === 0 ? 0 : 1);
  const total = totalMatch ? Number(totalMatch[1]) : Math.max(1, passed + failed);
  return {
    exitCode: result.status ?? 1,
    testsPassed: passed,
    testsTotal: total,
    testPassRate: total > 0 ? Number((passed / total).toFixed(4)) : 0,
    output: output.trim(),
  };
}

function runShellTemplate(template, vars, cwd) {
  const cmd = template
    .replaceAll("{workspace}", vars.workspace)
    .replaceAll("{prompt}", vars.prompt)
    .replaceAll("{plan}", vars.plan ?? "");
  const result = spawnSync(cmd, {
    cwd,
    shell: true,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30 * 60_000,
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function readLatestMetricsForWorkspace(metricsDir, workspaceDir) {
  if (!metricsDir) return null;
  const dir = join(metricsDir, "metrics");
  if (!existsSync(dir)) return null;
  const target = realpathSync(workspaceDir).toLowerCase();
  let best = null;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (typeof parsed.workspace === "string" && realpathSync(parsed.workspace).toLowerCase() === target) {
        if (!best || (parsed.updatedAt ?? 0) > (best.updatedAt ?? 0)) best = parsed;
      }
    } catch {
      // Ignore unreadable files or missing workspaces.
    }
  }
  return best;
}

function executeStubSolo(task, repoDir) {
  for (const files of Object.values(task.stubChanges)) {
    writeFiles(repoDir, files);
  }
  return { mergeConflicts: 0, rejectedHandoffs: 0, ownershipViolations: 0 };
}

function executeStubTeam(task, repoDir, scratchDir) {
  let mergeConflicts = 0;
  const worktrees = [];
  try {
    for (const assignment of task.teamPlan) {
      const branch = `agent-pair/bench-${task.id}/${assignment.owner}`;
      const wtDir = join(scratchDir, `wt-${task.id}-${assignment.owner}`);
      const added = runGit(repoDir, ["worktree", "add", "-b", branch, wtDir, "HEAD"]);
      if (added.status !== 0) {
        throw new Error(`git worktree add failed: ${added.stderr || added.stdout}`);
      }
      worktrees.push({ wtDir, branch });
      const changes = task.stubChanges[assignment.id] ?? {};
      writeFiles(wtDir, changes);
      runGit(wtDir, ["add", "."]);
      const commit = runGit(wtDir, ["commit", "-m", `${assignment.id}: ${assignment.title}`]);
      if (commit.status !== 0) {
        throw new Error(`stub commit failed for ${assignment.id}: ${commit.stderr || commit.stdout}`);
      }
    }
    for (const { branch } of worktrees) {
      const merge = runGit(repoDir, ["merge", "--no-ff", branch, "-m", `merge ${branch}`]);
      if (merge.status !== 0) {
        mergeConflicts += 1;
        runGit(repoDir, ["merge", "--abort"]);
      }
    }
  } finally {
    for (const { wtDir, branch } of worktrees) {
      runGit(repoDir, ["worktree", "remove", "--force", wtDir]);
      runGit(repoDir, ["branch", "-D", branch]);
    }
  }
  return { mergeConflicts, rejectedHandoffs: 0, ownershipViolations: 0 };
}

export function runBenchmark(options = {}) {
  const dryRun = Boolean(options.dryRun);
  const modeOption = options.mode ?? "both";
  const modes = modeOption === "both" ? ["solo", "team"] : [modeOption];
  const allTasks = listBenchTasks();
  const filter = options.tasks?.length ? new Set(options.tasks) : null;
  const selectedTasks = filter ? allTasks.filter((t) => filter.has(t.id)) : allTasks;

  if (!selectedTasks.length) {
    throw new Error("No benchmark tasks matched the selection.");
  }
  if (!dryRun && modes.includes("solo") && !options.soloCmd) {
    throw new Error("Provide --solo-cmd \"<command>\" for live solo runs, or pass --dry-run to use stub agents.");
  }
  if (!dryRun && modes.includes("team") && !options.teamCmd) {
    throw new Error("Provide --team-cmd \"<command>\" for live team runs, or pass --dry-run to use stub agents.");
  }

  const startedAt = new Date().toISOString();
  const parent = realpathSync(tmpdir());
  const scratchDir = mkdtempSync(join(parent, "agent-pair-bench-"));
  const entries = [];

  try {
    for (const task of selectedTasks) {
      for (const mode of modes) {
        const repoDir = initTaskRepo(task.starterDir, scratchDir, `${task.id}-${mode}`);
        const planPath = join(repoDir, "plan.md");
        if (mode === "team") {
          writeFileSync(planPath, buildPlanMarkdown(task), "utf8");
          runGit(repoDir, ["add", "plan.md"]);
          runGit(repoDir, ["commit", "-m", "add benchmark plan"]);
        }

        const t0 = Date.now();
        let mergeConflicts = 0;
        let rejectedHandoffs = 0;
        let ownershipViolations = 0;
        let tokens = null;
        let costUsd = null;
        let agentExitCode = 0;

        if (dryRun) {
          const outcome = mode === "team"
            ? executeStubTeam(task, repoDir, scratchDir)
            : executeStubSolo(task, repoDir);
          mergeConflicts = outcome.mergeConflicts;
          rejectedHandoffs = outcome.rejectedHandoffs;
          ownershipViolations = outcome.ownershipViolations;
        } else {
          const template = mode === "team" ? options.teamCmd : options.soloCmd;
          const run = runShellTemplate(
            template,
            { workspace: repoDir, prompt: task.soloPrompt, plan: planPath },
            repoDir,
          );
          agentExitCode = run.exitCode;
          const metrics = readLatestMetricsForWorkspace(options.metricsDir, repoDir);
          if (metrics) {
            rejectedHandoffs = (metrics.totals?.revisions ?? 0) + (metrics.totals?.ownershipRejections ?? 0);
            ownershipViolations = metrics.totals?.ownershipViolations ?? 0;
            tokens = metrics.totals?.usage?.totalTokens ?? null;
            costUsd = metrics.totals?.usage?.costUsd ?? null;
          }
        }

        const wallTimeMs = Math.max(0, Date.now() - t0);
        const acceptance = runHiddenAcceptance(repoDir, task.hiddenTestPath);

        entries.push({
          taskId: task.id,
          title: task.title,
          mode,
          dryRun,
          agent: dryRun ? "stub" : (mode === "team" ? "team-cli" : "solo-cli"),
          agentExitCode,
          wallTimeMs,
          testsPassed: acceptance.testsPassed,
          testsTotal: acceptance.testsTotal,
          testPassRate: acceptance.testPassRate,
          mergeConflicts,
          rejectedHandoffs,
          ownershipViolations,
          tokens,
          costUsd,
          status: acceptance.exitCode === 0 && agentExitCode === 0 && mergeConflicts === 0 ? "passed" : "failed",
        });
      }
    }
  } finally {
    if (dirname(resolve(scratchDir)) === parent) {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  }

  const report = {
    schemaVersion: 1,
    dryRun,
    syntheticFixture: false,
    startedAt,
    completedAt: new Date().toISOString(),
    platform: process.platform,
    nodeVersion: process.version,
    results: entries,
  };

  if (options.writeOutput !== false) {
    const stamp = startedAt.replace(/[:.]/g, "-");
    const outputPath = resolve(options.out ?? join(defaultResultsDir, `bench-${dryRun ? "dryrun-" : ""}${stamp}.json`));
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
    return { report, outputPath };
  }

  return { report, outputPath: null };
}

function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

if (isMain()) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "dry-run": { type: "boolean", default: false },
      mode: { type: "string", default: "both" },
      tasks: { type: "string" },
      "solo-cmd": { type: "string" },
      "team-cmd": { type: "string" },
      "metrics-dir": { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log(`Usage: node bench/runner.mjs [options]

Options:
  --dry-run                Run stub agents against all tasks in temporary git repos
  --mode solo|team|both    Benchmark mode (default: both)
  --tasks id1,id2          Comma-separated task IDs (default: all)
  --solo-cmd "<cmd>"       Shell command template for live solo runs ({workspace}, {prompt})
  --team-cmd "<cmd>"       Shell command template for live team runs ({workspace}, {plan}, {prompt})
  --metrics-dir <dir>      Agent Pair data directory to ingest B2 metrics (rejections/tokens/cost)
  --out <path>             Output JSON path (default: bench/results/bench-*.json)
`);
    process.exit(0);
  }

  const { report, outputPath } = runBenchmark({
    dryRun: values["dry-run"],
    mode: values.mode,
    tasks: values.tasks ? values.tasks.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    soloCmd: values["solo-cmd"],
    teamCmd: values["team-cmd"],
    metricsDir: values["metrics-dir"],
    out: values.out,
  });

  const passed = report.results.filter((r) => r.status === "passed").length;
  console.log(`Benchmark complete (${report.dryRun ? "dry-run stub" : "live"}): ${passed}/${report.results.length} runs passed.`);
  if (outputPath) console.log(`Saved results to ${outputPath}`);
}
