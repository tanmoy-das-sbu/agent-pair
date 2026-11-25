# Agent Pair Benchmark Harness (Team vs Solo)

This directory contains a self-contained benchmark harness for comparing a **solo** coding agent against an **Agent Pair team** across small, reproducible software engineering tasks with hidden acceptance tests.

> **No fabricated results:** This repository does not include claimed benchmark scores. `bench/fixtures/sample-results.json` is explicitly flagged `"syntheticFixture": true` and exists solely to unit-test `bench/summarize.mjs`. Run the harness with real agent CLIs to collect real numbers in `bench/results/*.json`.

## Tasks

| Task ID | Description | Team split |
| --- | --- | --- |
| `01-cli-flag` | Add `--format json\|text` flag to a CLI with error handling | Core formatter/CLI vs tests |
| `02-rest-endpoint` | Build `/health` and `/items` REST endpoints with validation | Item store vs HTTP server & tests |
| `03-module-refactor` | Extract pure tax/discount helpers and refactor invoice totals | `src/tax.mjs` vs `src/invoice.mjs` & tests |
| `04-seeded-bugs` | Fix 3 seeded bugs (queue capacity, FIFO ties, retry backoff cap) | `src/queue.mjs` vs `src/retry.mjs` & tests |

Each task under `bench/tasks/<id>/` contains:

- `task.json`: task metadata, solo prompt, team assignment split, and deterministic stub changes (for `--dry-run` only)
- `starter/`: minimal starter project copied into a fresh temporary git repository per run
- `hidden/acceptance.test.mjs`: hidden acceptance test suite executed after the agent finishes (never copied into the agent's workspace)

## Quickstart: Dry Run with Stub Agents

Verify the harness end-to-end without calling any paid LLM or external CLI:

```powershell
node bench/runner.mjs --dry-run
```

In `--dry-run` mode, the runner:

1. Copies each task's `starter/` into a fresh temporary Git repository.
2. Applies deterministic stub changes in `solo` mode, and in `team` mode creates isolated Git worktrees/branches (`agent-pair/bench-<task>/<owner>`) and merges them back into `main`.
3. Runs `hidden/acceptance.test.mjs` against the resulting workspace.
4. Writes a JSON report (`dryRun: true`) to `bench/results/bench-dryrun-*.json`.

## Running with Real Agent CLIs

Pass shell command templates for `--solo-cmd` and/or `--team-cmd`. Available template placeholders:

- `{workspace}` — absolute path to the temporary Git checkout for this task
- `{prompt}` — the task's solo prompt string
- `{plan}` — path to the generated `plan.md` inside `{workspace}` (in `team` mode)

Example running `solo` mode with Codex CLI:

```powershell
node bench/runner.mjs --mode solo --solo-cmd 'codex exec "{prompt}"' --out bench/results/codex-solo.json
```

Example running `team` mode with a custom wrapper script that launches your Agent Pair orchestrator + workers (optionally passing `--metrics-dir` so rejected handoffs, ownership violations, tokens, and cost are ingested from Agent Pair's persisted B2 metrics JSON):

```powershell
node bench/runner.mjs --mode team --team-cmd 'node my-team-launcher.mjs --workspace "{workspace}" --plan "{plan}"' --metrics-dir "$env:LOCALAPPDATA\AgentPair" --out bench/results/team-run.json
```

## Generating a Markdown Summary

Turn one or more result JSON files into a comparison table:

```powershell
node bench/summarize.mjs bench/results/codex-solo.json bench/results/team-run.json
```

Missing token or cost metrics degrade gracefully to `Not reported`.

## Recorded Fields

Every task/mode entry records:

- `wallTimeMs`: elapsed time from agent start to finish
- `testsPassed`, `testsTotal`, `testPassRate`: hidden acceptance test pass rate
- `mergeConflicts`: number of git merge conflicts encountered in team worktree merges
- `rejectedHandoffs`, `ownershipViolations`: ingested from B2 metrics when `--metrics-dir` is provided
- `tokens`, `costUsd`: `null` unless reported by the agent/metrics store
