#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function fmtPct(rate) {
  if (typeof rate !== "number" || Number.isNaN(rate)) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

function fmtTime(ms) {
  if (typeof ms !== "number" || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function fmtTokens(value) {
  if (value === null || value === undefined) return "Not reported";
  return Math.round(value).toLocaleString("en-US");
}

function fmtCost(value) {
  if (value === null || value === undefined) return "Not reported";
  return `$${Number(value).toFixed(4)}`;
}

function avgOrNull(values) {
  const valid = values.filter((v) => typeof v === "number" && !Number.isNaN(v));
  if (!valid.length) return null;
  return valid.reduce((sum, v) => sum + v, 0) / valid.length;
}

function sum(values) {
  return values.reduce((acc, v) => acc + (typeof v === "number" ? v : 0), 0);
}

export function generateMarkdownSummary(reports) {
  const normalized = reports.map((item) => (typeof item === "string" ? JSON.parse(readFileSync(item, "utf8")) : item));
  const allRows = normalized.flatMap((report) => report.results ?? []);
  const hasDryRun = normalized.some((r) => r.dryRun);
  const hasSynthetic = normalized.some((r) => r.syntheticFixture);

  const lines = ["# Benchmark Summary (Team vs Solo)", ""];
  if (hasSynthetic) {
    lines.push("> **Note:** Includes synthetic fixture data used to test summary formatting. Do not cite fixture numbers as real benchmark results.", "");
  }
  if (hasDryRun) {
    lines.push("> **Note:** Includes `--dry-run` stub agent executions (verifying harness plumbing, worktree merges, and hidden acceptance tests only).", "");
  }

  lines.push("## Per-Task Results", "");
  lines.push("| Task | Mode | Status | Pass Rate | Wall Time | Merge Conflicts | Rejected Handoffs | Tokens | Cost |");
  lines.push("| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const row of allRows) {
    lines.push(
      `| ${row.taskId} | ${row.mode} | ${row.status} | ${fmtPct(row.testPassRate)} (${row.testsPassed}/${row.testsTotal}) | ${fmtTime(row.wallTimeMs)} | ${row.mergeConflicts ?? 0} | ${row.rejectedHandoffs ?? 0} | ${fmtTokens(row.tokens)} | ${fmtCost(row.costUsd)} |`,
    );
  }

  lines.push("", "## Mode Averages", "");
  lines.push("| Mode | Runs | Mean Pass Rate | Mean Wall Time | Total Merge Conflicts | Total Rejected Handoffs | Mean Tokens | Mean Cost |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const mode of ["solo", "team"]) {
    const subset = allRows.filter((r) => r.mode === mode);
    if (!subset.length) continue;
    lines.push(
      `| ${mode} | ${subset.length} | ${fmtPct(avgOrNull(subset.map((r) => r.testPassRate)))} | ${fmtTime(avgOrNull(subset.map((r) => r.wallTimeMs)))} | ${sum(subset.map((r) => r.mergeConflicts))} | ${sum(subset.map((r) => r.rejectedHandoffs))} | ${fmtTokens(avgOrNull(subset.map((r) => r.tokens)))} | ${fmtCost(avgOrNull(subset.map((r) => r.costUsd)))} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

if (isMain()) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error("Usage: node bench/summarize.mjs <results.json> [more.json...]");
    process.exit(1);
  }
  process.stdout.write(generateMarkdownSummary(files));
}
