# Agent Pair

Coordinate Codex, Google Antigravity, and Claude Code in the workspace you have open. An orchestrator divides the project plan into work it owns and work for separate worker sessions. Each fresh team gets its own in-memory coordination state. The same installation works across repositories.

## Install on Windows

Use Node.js 24 or later, the CLIs you plan to use, and Windows Terminal for the optional resume command.

```powershell
npm.cmd install -g '@tnmy57/agent-pair'
agent-pair.cmd setup --dry-run --profiles codex,antigravity,claude
agent-pair.cmd setup --apply --profiles codex,antigravity,claude
agent-pair.cmd doctor --profiles codex,antigravity,claude
```

Choose the installed clients with `--profiles`. The default is `codex,antigravity`. Setup adds the shared skill, a stdio MCP registration, and a session-start hook for each selected client. It preserves other configuration entries and backs up edited files. Open fresh client sessions after setup. Approve the Agent Pair session-start hook if your client prompts and you want automatic session bookmarks. Team coordination works without the hook metadata.

## Coordinate a team

Run `agent-pair init` in a project to create a starter `plan.md` with task IDs, owners, client profiles, owned paths, dependencies, and acceptance checks. Edit the example assignments to match your project.

Give one session the orchestrator prompt.

> Use Agent Pair as the orchestrator to implement this workspace’s `plan.md`. Assign yourself a workstream and divide the rest among workers with clear file ownership, dependencies, and acceptance checks. Ask me how many workers to expect and which clients I want to use. Start the team, tell me when it is waiting, and work on your assignments while the workers work on theirs. Review their handoffs and run the project’s integration checks.

Open the requested worker sessions in the same workspace and give each the same prompt.

> Use the Agent Pair skill to join the team waiting in this workspace. Follow your assigned tasks and file boundaries, and report blockers and handoffs to the orchestrator.

The relay validates overlapping file and directory assignments across owners and requires accepted dependencies before a task can start. Agents enforce the agreed file ownership when they edit. Workers hand off their changes and check results to the orchestrator for review. This version supports up to 64 tasks per team and up to 64 sessions when tasks have distinct owners, including the orchestrator.

## Pair Codex and Antigravity

Open the same folder in fresh Codex and Antigravity sessions and give both the same prompt.

> Use Agent Pair to connect and work through this project's `plan.md`.

The first session waits briefly for its peer. The relay matches both live requests by workspace and opens an empty inbox. Closing a pairing discards its messages. An inactive pairing expires after 30 minutes. When you open a second project, use the same prompt in both new sessions. Each project keeps its own files and each pairing gets its own inbox.

## Reopen native sessions

When every member supplies a native session ID, Agent Pair reports a four-character project tag. The bookmark contains the workspace path, member IDs, client profiles, and native session IDs. Agent Pair keeps live coordination state in memory.

```powershell
agent-pair resume 6G7D --dry-run
agent-pair resume 6G7D
```

The launcher opens one Windows Terminal tab per bookmarked member in the saved project folder, using `codex resume`, `agy --conversation`, or `claude --resume`. The native clients load their own histories. To coordinate the reopened sessions, start a fresh run. The launcher targets CLI-created sessions and supports existing two-agent bookmarks.

## Local data and development

The Windows data directory is `%LOCALAPPDATA%\AgentPair`. It stores a local relay key and the optional bookmark database. Set `AGENT_PAIR_DATA_DIR` before setup if both clients need a different writable local directory. The relay stops after becoming idle. A relay restart discards live messages.

```powershell
npm.cmd ci
npm.cmd test
npm.cmd pack
node dist/cli.js --help
```

## Architecture and verification

Each session uses a stdio MCP process configured for its native client. These processes connect to a local relay over a Windows named pipe. Workers claim an available slot for their client profile in the same workspace. It routes messages by member and tracks task state in memory.

The automated tests cover a four-session mixed-client team, task boundaries and dependencies, directed messages, fresh runs, repeatable setup, and the exact native IDs used for resume. The original Codex and Antigravity workflow was verified with both native clients.

The full implementation plan, including the Mermaid diagram and build milestones, is bundled as `PLAN.md` in the npm package.
