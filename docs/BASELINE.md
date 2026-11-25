# v0.4 Baseline (T0)

Recorded by the orchestrator during task **T0** before v0.4 feature work began.

## Environment

- **Platform:** Windows
- **Node.js:** `v24.21.0`
- **npm:** `11.19.0`
- **Base commit:** `11b70c7` (`Update version to 0.3.0 and enhance Team Map functionality in dashboard`)
- **Working tree note:** The checkout already contained uncommitted v0.3.1 / pre-run edits (including `PLAN.md`, `package.json`, `package-lock.json`, `skills/agent-pair/SKILL.md`, `src/dashboard.ts`, `src/doctor.ts`, `src/ipc.ts`, `src/server.ts`, and `test/agent-pair.test.mjs`). Those pre-existing changes were preserved rather than bundled into a T0 commit.

## Verification Results

| Command | Result | Details |
| --- | --- | --- |
| `npm ci` | Pass | 99 packages installed |
| `npm run build` | Pass | Completed in 4.07 s |
| `npm test` | Pass | 7/7 tests passed, 0 failures |

## Reconciled Repository Layout

The codebase uses a flat layout under `src/` with a single existing test file (`test/agent-pair.test.mjs`). File ownership for the v0.4 run was reconciled against the real tree in `plan.md`:

- **orchestrator:** `plan.md`, `package.json`, `package-lock.json`, `src/cli.ts`, `CHANGELOG.md`, `docs/CASE_STUDY.md`
- **worker-a (Codex):** `src/relay.ts`, `src/team.ts`, `src/types.ts`, `src/ipc.ts`, `src/workspace.ts`, `src/resume.ts`, `src/bookmarks.ts`, `src/server.ts`, `src/transport/`, `src/core/`, `src/git/`, `test/relay/`, `test/transport/`, `test/git/`, `test/agent-pair.test.mjs`
- **worker-b (Antigravity):** `src/dashboard.ts`, `src/metrics/`, `src/adapters/`, `src/setup.ts`, `src/capture.ts`, `src/doctor.ts`, `bench/`, `README.md`, `LICENSE`, `.github/`, `docs/BASELINE.md`, `docs/WRITING_AN_ADAPTER.md`, `test/dashboard/`, `test/metrics/`, `test/adapters/`
