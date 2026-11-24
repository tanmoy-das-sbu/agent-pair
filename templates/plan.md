# Project name

## Goal

Describe the outcome the user should be able to verify.

## Assignments

Choose a client profile for each member from `codex`, `antigravity`, and `claude`. The same profile can serve multiple member IDs through separate sessions. Keep the member ID `orchestrator` for the session that coordinates the run and owns its own work.

| Task ID | Owner | Client profile | Deliverable | Owned paths | Depends on | Acceptance checks |
| --- | --- | --- | --- | --- | --- | --- |
| api | orchestrator | codex | Implement the API and publish its interface | `src/api/`, `docs/api.md` | — | API tests pass and the response shape is documented |
| ui | frontend | antigravity | Implement the frontend | `src/ui/` | api | The UI handles API success and error responses |
| ci | automation | claude | Verify the build in CI | `.github/workflows/` | — | The build and test jobs run on the supported platform |

Replace the example with the project's actual tasks. List file or directory paths relative to the workspace root. Give each shared file one owner. List a dependency when the task must wait for another task's accepted handoff. Use an empty path list for review-only assignments.

## Shared interfaces and decisions

Record API contracts, shared-file owners, and decisions workers need to follow.

## Done when

List end-to-end checks, commands, and expected results. Identify who will run them.

## Constraints

Record project-specific constraints and decisions that require user input.
