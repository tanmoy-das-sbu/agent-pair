---
name: agent-pair
description: Coordinate fresh Codex, Google Antigravity, and Claude Code sessions in the current workspace when the user asks to use Agent Pair.
---

# Agent Pair

Use the current workspace and its plan, project instructions, and file ownership. Pass the absolute workspace path when connecting. If this conversation has Agent Pair metadata from a session-start hook, include its `sessionId` for the optional resume bookmark. Omit the ID when unavailable. Keep returned handles in this conversation. Report the project tag when available.

## Orchestrator

Call `team_setup` with the absolute workspace before asking about the roster. If a dashboard setup exists, use its exact worker counts per client and pass its `id` as `setupId` to `team_start`. The worker counts exclude the lead. If your `currentProfile` differs from the setup's `leadProfile`, ask the user to open the selected orchestrator in this folder. If the user asked to use a saved setup and none is returned, share the returned `dashboardUrl` when available and ask them to save the setup for this workspace there. For ordinary runs without a setup, ask about the roster as described below.

1. Identify your own client from the MCP tool description or session metadata. Before starting a run, ask how many additional worker sessions the user wants under you (explicitly note that workers are in addition to you as the orchestrator—for example, 2 workers means 3 total sessions) and which clients those workers should use (Codex, Antigravity, Claude Code). Use a multi-select picker when available, or accept a text reply. Respect any choices already supplied and confirm the total team breakdown (orchestrator + worker sessions per client) if the mix is ambiguous. Read `plan.md` or `PLAN.md`. Turn its deliverables into assignments with `id`, `owner`, `profile`, `title`, `paths`, `checks`, and optional `dependsOn` task IDs. Reserve `orchestrator` for yourself and assign yourself a deliverable. Use a distinct member ID for each worker, even when several use the same client. Assign each file or directory to one owner. Give shared contracts and integration files an owner and list dependencies that constrain when work can start.
2. Call `team_start` with `workerCount`, `allowedProfiles`, `assignments`, and your `sessionId` from Agent Pair session-start metadata when available. Use task-based member names like frontend or quality. Tell the user the exact number of worker sessions to open per client (noting that your orchestrator session is separate), that the team is waiting, and that the 4-character resume tag will be created once all workers join with session metadata. Workers use the same join prompt in every session. Keep the orchestrator active and check `pair_status` with `waitMs` while waiting for workers.
3. Once `pair_status` shows `waitingFor: 0`, report the connected roster and the 4-character project tag (`tag`, used with `agent-pair resume <tag>`) to the user; if `tag` is not present, explain why using `missingSessionIds` or `bookmarkError`. Use `team_update` with `transition: "start"` for independent tasks you own while workers join and work. Check `pair_status` and `pair_inbox` at task boundaries. Resolve blockers and send decisions to affected members. Make shared-file changes through their assigned owners.
4. Review each ready handoff and its check results. Use `transition: "accept"` to approve it or `transition: "revise"` with a note to request changes. Use the same handoff and acceptance flow for your own assignments. Run the integration checks, report results (including the 4-character project tag if available), and call `pair_disconnect` when the work and handoff acknowledgments are complete.

## Worker

1. Call `team_join` with the absolute workspace and your `sessionId` from Agent Pair session-start metadata when available. If multiple runs are active, obtain the intended run ID from the orchestrator. If `tag` is returned, report the 4-character project tag (`agent-pair resume <tag>`) to the user. Read the returned tasks and the relevant parts of the plan.
2. Use `team_update` with `transition: "start"` before working on an assignment. If a dependency is pending, check `pair_status` and work on an independent assigned task. Edit only the paths assigned to you. Send requests for other changes to the assigned owner or orchestrator.
3. Use `transition: "block"` with a note when work stops. Send the orchestrator a blocker message. When ready, use `transition: "handoff"` with a summary and actual check results. Send the orchestrator a handoff message. Check for feedback and address any revisions within your assigned paths.
4. After your tasks are accepted and you have processed outstanding messages, call `pair_disconnect` to leave your slot.

## Messages

Use `pair_send` with the task ID and a new request ID for each message. Address a teammate using `to` with their member ID. Reuse a request ID only to retry the same message. Check `pair_inbox` at task boundaries or use a short wait when awaiting a response. Use `pair_ack` after processing messages. Use `pair_status` for the roster, assignment states, dependencies, and handoff evidence.

## Original Codex and Antigravity workflow

When the user gives both clients the same pairing prompt without team roles, call `pair_connect` and retry a short wait if both sessions are open. Codex coordinates the backend and integration, and Antigravity owns the frontend, subject to the project's plan. Use the message tools for assignments and handoffs. Call `pair_disconnect` when both agents finish and acknowledge the final handoff.

## Generic worker prompt

> Use the Agent Pair skill to join the team waiting in this workspace. Follow your assigned tasks and file boundaries, and report blockers and handoffs to the orchestrator.
