import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { captureSession } from "../dist/capture.js";
import { Relay } from "../dist/relay.js";
import { pathKey } from "../dist/workspace.js";

const entry = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const toolNames = ["pair_connect", "team_start", "team_join", "team_update", "pair_send", "pair_inbox", "pair_ack", "pair_status", "pair_disconnect"];

function fixture(t) {
  const parent = realpathSync(tmpdir());
  const directory = mkdtempSync(join(parent, "agent-pair-test-"));
  t.after(() => {
    if (dirname(resolve(directory)) === parent) rmSync(directory, { recursive: true, force: true });
  });
  const env = {
    ...process.env,
    AGENT_PAIR_CONFIG_HOME: join(directory, "config"),
    AGENT_PAIR_DATA_DIR: join(directory, "data"),
    AGENT_PAIR_NO_DASHBOARD: "1",
  };
  function command(args, options = {}) {
    return execFileSync(process.execPath, [entry, ...args], {
      env, encoding: "utf8", windowsHide: true, ...options,
    });
  }
  return { directory, env, command };
}

async function openClient(role, env) {
  const client = new Client({ name: `test-${role}`, version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, "serve", "--profile", role],
    env,
    stderr: "ignore",
  });
  await client.connect(transport);
  return client;
}

async function tool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content[0].text;
  if (result.isError) throw new Error(text);
  return JSON.parse(text);
}

test("matches the current workspace, isolates new runs and persists only exact resume bookmarks", async (t) => {
  const { directory, env, command } = fixture(t);
  const first = join(directory, "Project One");
  const second = join(directory, "Project Two");
  mkdirSync(first);
  mkdirSync(second);
  const codex = await openClient("codex", env);
  t.after(() => codex.close());
  const agy = await openClient("antigravity", env);
  t.after(() => agy.close());
  assert.deepEqual((await codex.listTools()).tools.map((entry) => entry.name), toolNames);
  assert.deepEqual((await agy.listTools()).tools.map((entry) => entry.name), toolNames);

  await Promise.all([
    assert.rejects(tool(codex, "pair_connect", { workspace: first, waitMs: 1000 }), /waiting for antigravity/),
    assert.rejects(tool(agy, "pair_connect", { workspace: second, waitMs: 1000 }), /waiting for codex/),
  ]);

  const pair = (workspace, codexId, agyId) => Promise.all([
    tool(codex, "pair_connect", { workspace, waitMs: 4000, sessionId: codexId }),
    tool(agy, "pair_connect", { workspace, waitMs: 4000, sessionId: agyId }),
  ]);
  const ids1 = [randomUUID(), randomUUID()];
  const ids2 = [randomUUID(), randomUUID()];
  const [left1, right1] = await pair(first, ...ids1);
  const [left2, right2] = await pair(second, ...ids2);
  assert.equal(left1.runId, right1.runId);
  assert.equal(left1.role, "codex");
  assert.equal(right1.role, "antigravity");
  assert.notEqual(left1.runId, left2.runId);
  assert.match(left1.tag, /^[A-Z0-9]{4}$/);
  assert.notEqual(left1.tag, left2.tag);

  const waiting = tool(agy, "pair_inbox", { handle: right1.handle, waitMs: 4000, taskId: "M1" });
  const envelope = {
    handle: left1.handle, taskId: "M1", kind: "assignment", body: "Use the agreed API",
    requestId: "once", checks: ["Interface documented"],
  };
  const [message, reverse] = await Promise.all([
    tool(codex, "pair_send", envelope),
    tool(agy, "pair_send", {
      handle: right1.handle, taskId: "M2", kind: "question", body: "Which result shape?",
      requestId: "ask",
    }),
  ]);
  assert.equal(reverse.to, "codex");
  assert.deepEqual((await waiting).messages, [message]);
  assert.deepEqual(await tool(codex, "pair_send", envelope), message);
  await assert.rejects(tool(codex, "pair_send", { ...envelope, body: "Different" }), /already used/);
  await assert.rejects(tool(agy, "pair_inbox", { handle: left1.handle }), /another session/);
  assert.deepEqual((await tool(agy, "pair_inbox", { handle: right2.handle })).messages, []);
  await assert.rejects(tool(codex, "pair_ack", { handle: left1.handle, ids: [message.id] }), /only messages sent/);
  await tool(agy, "pair_ack", { handle: right1.handle, ids: [message.id] });
  await tool(agy, "pair_ack", { handle: right1.handle, ids: [message.id] });
  assert.deepEqual((await tool(agy, "pair_inbox", { handle: right1.handle })).messages, []);
  assert.equal((await tool(codex, "pair_status", { handle: left1.handle })).nextRole, "antigravity");

  const [fresh, other] = await pair(first, randomUUID());
  assert.notEqual(fresh.runId, left1.runId);
  assert.equal(fresh.tag, undefined);
  assert.deepEqual((await tool(agy, "pair_inbox", { handle: other.handle })).messages, []);
  assert.match(command(["resume", left1.tag.toLowerCase(), "--dry-run"], { cwd: second }), new RegExp(ids1[0]));
  const dry1 = JSON.parse(command(["resume", left1.tag, "--dry-run"], { cwd: second }));
  const dry2 = JSON.parse(command(["resume", right2.tag, "--dry-run"], { cwd: first }));
  assert.equal(dry1.workspace, realpathSync(first));
  assert.equal(dry2.workspace, realpathSync(second));
  assert.deepEqual(dry1.args.slice(8, 10), ["resume", ids1[0]]);
  assert.deepEqual(dry1.args.slice(-2), ["--conversation", ids1[1]]);
  assert.deepEqual(dry2.args.slice(-2), ["--conversation", ids2[1]]);
  assert.throws(() => command(["resume", "OOOO", "--dry-run"], { stdio: "pipe" }), /Unknown project tag/);

  const ids3 = [randomUUID(), randomUUID()];
  const [updated] = await pair(first, ...ids3);
  assert.equal(updated.tag, left1.tag);
  assert.match(command(["resume", updated.tag, "--dry-run"]), new RegExp(ids3[1]));
  assert.doesNotMatch(readFileSync(join(env.AGENT_PAIR_DATA_DIR, "bookmarks.sqlite"), "utf8"), /Use the agreed API/);

  for (const session of [left1, left2, fresh, updated]) {
    assert.equal((await tool(codex, "pair_disconnect", { handle: session.handle })).closed, true);
  }
  await assert.rejects(tool(agy, "pair_inbox", { handle: right1.handle }), /pairing has ended/);
});

test("setup is previewable and idempotent and preserves existing servers and hooks", (t) => {
  const { env, command, directory } = fixture(t);
  const codex = join(env.AGENT_PAIR_CONFIG_HOME, ".codex");
  const agy = join(env.AGENT_PAIR_CONFIG_HOME, ".gemini", "config");
  mkdirSync(codex, { recursive: true });
  mkdirSync(agy, { recursive: true });
  const toml = '# My settings\nmodel = "example"\n[mcp_servers.keep]\ncommand = "keep"\n';
  writeFileSync(join(codex, "config.toml"), toml);
  writeFileSync(join(codex, "hooks.json"), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: "keep" }] }] },
  }));
  writeFileSync(join(agy, "mcp_config.json"), JSON.stringify({ mcpServers: { keep: { command: "keep" } } }));
  writeFileSync(join(agy, "hooks.json"), JSON.stringify({ keep: { SessionStart: [{ command: "keep" }] } }));
  assert.match(command(["setup", "--dry-run"]), /Preview only/);
  assert.equal(readFileSync(join(codex, "config.toml"), "utf8"), toml);
  command(["setup", "--apply"]);
  assert.match(command(["setup", "--apply"]), /already configured/);
  const injected = readFileSync(join(codex, "config.toml"), "utf8").replace(
    "# <<< Agent Pair managed MCP <<<",
    '\n[hooks.state]\n\n[hooks.state.\'hooks.json:session_start:0:0\']\ntrusted_hash = "sha256:abc"\n# <<< Agent Pair managed MCP <<<',
  );
  writeFileSync(join(codex, "config.toml"), injected);
  command(["setup", "--apply"]);
  const healed = readFileSync(join(codex, "config.toml"), "utf8");
  assert.match(healed, /# <<< Agent Pair managed MCP <<<\n\n\[hooks\.state\]/);
  assert.match(healed, /trusted_hash = "sha256:abc"/);
  assert.match(command(["setup", "--apply"]), /already configured/);
  assert.equal(healed.startsWith(toml), true);
  const codexHooks = JSON.parse(readFileSync(join(codex, "hooks.json"), "utf8"));
  assert.equal(codexHooks.hooks.SessionStart.length, 2);
  assert.equal(codexHooks.hooks.SessionStart[0].hooks[0].command, "keep");
  const agyConfig = JSON.parse(readFileSync(join(agy, "mcp_config.json"), "utf8"));
  assert.equal(agyConfig.mcpServers.keep.command, "keep");
  assert.equal(agyConfig.mcpServers.agent_pair.env.AGENT_PAIR_DATA_DIR, env.AGENT_PAIR_DATA_DIR);
  const agyHooks = JSON.parse(readFileSync(join(agy, "hooks.json"), "utf8"));
  assert.equal(agyHooks.keep.SessionStart[0].command, "keep");
  assert.equal(existsSync(join(agy, "skills", "agent-pair", "SKILL.md")), true);
  writeFileSync(join(agy, "mcp_config.json"), "  \r\n");
  assert.match(command(["setup", "--dry-run"]), /Preview only/);
  assert.equal(readFileSync(join(agy, "mcp_config.json"), "utf8"), "  \r\n");
  assert.match(command(["init"], { cwd: directory }), /Created/);
  assert.match(command(["init"], { cwd: directory }), /already exists/);
});

test("coordinates four sessions across three profiles and reopens the exact bookmarked team", async (t) => {
  const { directory, env, command } = fixture(t);
  const workspace = join(directory, "Team Project");
  mkdirSync(workspace);
  const profiles = ["codex", "antigravity", "claude", "claude"];
  const [lead, agy, claude, secondClaude] = await Promise.all(profiles.map((profile) => openClient(profile, env)));
  t.after(() => Promise.all([lead, agy, claude, secondClaude].map((client) => client.close())));
  const assignments = [
    { id: "api", owner: "orchestrator", profile: "codex", paths: ["src/api/"] },
    { id: "ui", owner: "frontend", profile: "antigravity", paths: ["src/ui/"], dependsOn: ["api"] },
    { id: "ci", owner: "automation", profile: "claude", paths: [".github/workflows/"] },
    { id: "tests", owner: "quality", profile: "claude", paths: ["test/"] },
  ].map((assignment) => ({ ...assignment, title: assignment.id, checks: ["Tests pass"] }));
  const sessionIds = profiles.map(() => randomUUID());
  const start = (work = assignments) => tool(lead, "team_start", { workspace, sessionId: sessionIds[0], workerCount: work.length - 1, allowedProfiles: ["antigravity", "claude"], assignments: work });
  await assert.rejects(start([assignments[0], { ...assignments[1], paths: ["src\\api\\index.js"] }]), /File boundary overlap/);
  await assert.rejects(start([assignments[0], { ...assignments[1], paths: ["../other-project/file"] }]), /workspace-relative/);
  await assert.rejects(start([{ ...assignments[0], dependsOn: ["ui"] }, assignments[1]]), /Circular/);
  await assert.rejects(start([assignments[0], { ...assignments[1], dependsOn: ["missing"] }]), /Unknown task dependency/);

  const run = await start();
  assert.equal(run.waitingFor, 3);
  assert.equal(run.tag, undefined);
  const joinWorker = (client, index, overrides = {}) => {
    return tool(client, "team_join", {
      workspace, sessionId: sessionIds[index + 1], ...overrides,
    });
  };
  await assert.rejects(joinWorker(claude, 1, { workspace: directory }), /No active team/);
  const [frontend, automation] = await Promise.all([joinWorker(agy, 0), joinWorker(claude, 1)]);
  assert.equal(automation.tag, undefined);
  assert.equal((await joinWorker(secondClaude, 2, { sessionId: sessionIds[2] })).handle, automation.handle);
  const waiting = tool(lead, "pair_status", { handle: run.handle, waitMs: 2000 });
  const quality = await joinWorker(secondClaude, 2);
  assert.equal((await waiting).waitingFor, 0);
  await assert.rejects(joinWorker(lead, 0), /not selected/);
  assert.match(quality.tag, /^[A-Z0-9]{4}$/);
  assert.equal((await joinWorker(secondClaude, 2)).handle, quality.handle);
  assert.deepEqual(frontend.tasks.map((task) => task.id), ["ui"]);
  assert.deepEqual(automation.tasks.map((task) => task.id), ["ci"]);
  assert.notEqual(quality.handle, automation.handle);

  const update = (client, session, taskId, transition, extra = {}) =>
    tool(client, "team_update", { handle: session.handle, taskId, transition, ...extra });
  await assert.rejects(update(agy, frontend, "ui", "start"), /Waiting for accepted tasks: api/);
  await assert.rejects(update(claude, automation, "api", "start"), /Only the assigned owner/);
  await Promise.all([
    update(lead, run, "api", "start"),
    update(claude, automation, "ci", "start"),
    update(secondClaude, quality, "tests", "start"),
  ]);
  const status = await tool(lead, "pair_status", { handle: run.handle });
  assert.deepEqual(status.tasks.map((task) => task.state), ["active", "pending", "active", "active"]);
  assert.equal(status.tag, quality.tag);

  const inbox = tool(secondClaude, "pair_inbox", { handle: quality.handle, waitMs: 2000 });
  const envelope = { handle: automation.handle, to: "quality", taskId: "ci", kind: "question", requestId: "1", body: "Check runtime matrix" };
  const directed = await tool(claude, "pair_send", envelope);
  assert.deepEqual((await inbox).messages, [directed]);
  assert.equal(directed.from, "automation");
  assert.deepEqual(await tool(claude, "pair_send", envelope), directed);
  await assert.rejects(tool(claude, "pair_send", { ...envelope, to: "orchestrator" }), /already used/);
  assert.deepEqual((await tool(lead, "pair_inbox", { handle: run.handle })).messages, []);
  await assert.rejects(tool(agy, "pair_ack", { handle: frontend.handle, ids: [directed.id] }), /only messages sent/);
  await assert.rejects(tool(agy, "pair_send", {
    handle: frontend.handle, taskId: "ci", kind: "question", requestId: "unrelated", body: "Unrelated reply", replyTo: directed.id,
  }), /reply must refer/);
  await tool(secondClaude, "pair_ack", { handle: quality.handle, ids: [directed.id] });
  const reply = await tool(secondClaude, "pair_send", {
    handle: quality.handle, taskId: "ci", kind: "update", requestId: "1", body: "Tests run", replyTo: directed.id,
  });
  assert.equal(reply.to, "automation");

  await assert.rejects(update(lead, run, "api", "handoff", { note: "API ready" }), /results of your checks/);
  await update(lead, run, "api", "handoff", { note: "API ready", checks: ["API tests passed"] });
  await assert.rejects(update(claude, automation, "api", "accept"), /Only the orchestrator/);
  await assert.rejects(update(agy, frontend, "ui", "start"), /Waiting for accepted tasks: api/);
  await update(lead, run, "api", "accept");
  await update(agy, frontend, "ui", "start");
  await update(agy, frontend, "ui", "handoff", { note: "UI ready", checks: ["UI tests passed"] });
  await update(lead, run, "ui", "revise", { note: "Check failed response" });
  assert.equal((await update(agy, frontend, "ui", "start")).state, "active");

  assert.equal((await tool(claude, "pair_disconnect", { handle: automation.handle })).disconnected, true);
  await assert.rejects(tool(claude, "pair_status", { handle: automation.handle }), /pairing has ended/);
  await assert.rejects(joinWorker(claude, 1, { sessionId: randomUUID() }), /No unclaimed worker slot/);
  const afterDisconnect = await tool(lead, "pair_status", { handle: run.handle, waitMs: 500 });
  assert.equal(afterDisconnect.waitingFor, 0);
  assert.equal(afterDisconnect.members.find((entry) => entry.member === "automation").connected, false);
  assert.equal(afterDisconnect.members.every((entry) => entry.hasSessionId), true);
  assert.equal(afterDisconnect.missingSessionIds, undefined);
  assert.equal((await tool(secondClaude, "pair_status", { handle: quality.handle })).runId, run.runId);
  const fresh = await tool(lead, "team_start", {
    workspace, workerCount: assignments.length - 1, allowedProfiles: ["antigravity", "claude"], assignments,
  });
  assert.deepEqual(fresh.missingSessionIds, ["orchestrator"]);
  assert.equal(fresh.members.find((entry) => entry.member === "orchestrator").hasSessionId, false);
  assert.notEqual(fresh.runId, run.runId);
  assert.equal(fresh.tasks[0].state, "pending");
  assert.equal(fresh.unread, 0);
  const resumed = JSON.parse(command(["resume", quality.tag, "--dry-run"], { cwd: directory }));
  assert.equal(resumed.workspace, realpathSync(workspace));
  assert.deepEqual(resumed.args.filter((arg) => sessionIds.includes(arg)), sessionIds);
  assert.equal(resumed.args.filter((arg) => arg === "new-tab").length, 4);
  assert.equal(resumed.args.filter((arg) => arg === "--resume").length, 2);
  assert.equal((await tool(lead, "pair_disconnect", { handle: run.handle })).closed, true);
  await assert.rejects(tool(secondClaude, "pair_status", { handle: quality.handle }), /pairing has ended/);
  await tool(lead, "pair_disconnect", { handle: fresh.handle });
});

test("configures Claude Code independently and migrates a pre-team project tag", (t) => {
  const { directory, env, command } = fixture(t);
  const claude = join(env.AGENT_PAIR_CONFIG_HOME, ".claude");
  const registration = join(env.AGENT_PAIR_CONFIG_HOME, ".claude.json");
  mkdirSync(claude, { recursive: true });
  writeFileSync(registration, JSON.stringify({ mcpServers: { keep: { command: "keep" } }, projects: { keep: {} } }));
  writeFileSync(join(claude, "settings.json"), JSON.stringify({
    hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "keep" }] }] },
  }));
  command(["setup", "--apply", "--profiles", "claude"]);
  assert.match(command(["setup", "--apply", "--profiles", "claude"]), /already configured/);
  assert.equal(existsSync(join(env.AGENT_PAIR_CONFIG_HOME, ".codex")), false);
  assert.equal(existsSync(join(claude, "skills", "agent-pair", "SKILL.md")), true);
  const { mcpServers, projects } = JSON.parse(readFileSync(registration, "utf8"));
  assert.equal(mcpServers.keep.command, "keep");
  assert.deepEqual(mcpServers.agent_pair.args, [entry, "serve", "--profile", "claude"]);
  assert.equal(mcpServers.agent_pair.type, "stdio");
  assert.deepEqual(projects, { keep: {} });
  const groups = JSON.parse(readFileSync(join(claude, "settings.json"), "utf8")).hooks.SessionStart;
  assert.equal(groups[0].matcher, "startup");
  const hook = groups[1].hooks[0];
  assert.deepEqual(hook.args, [entry, "capture-session", "--profile", "claude"]);
  const sessionId = randomUUID();
  const payload = { session_id: sessionId, cwd: directory, transcript_path: "private" };
  const context = JSON.parse(execFileSync(hook.command, hook.args, { input: JSON.stringify(payload), encoding: "utf8" }));
  assert.equal(context.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(context.hookSpecificOutput.additionalContext, new RegExp(sessionId));
  assert.doesNotMatch(context.hookSpecificOutput.additionalContext, /private/);

  mkdirSync(env.AGENT_PAIR_DATA_DIR);
  const db = new DatabaseSync(join(env.AGENT_PAIR_DATA_DIR, "bookmarks.sqlite"));
  const ids = [randomUUID(), randomUUID()];
  try {
    db.exec("CREATE TABLE bookmarks (workspace_key TEXT PRIMARY KEY, tag TEXT NOT NULL UNIQUE, workspace TEXT NOT NULL, codex TEXT NOT NULL, antigravity TEXT NOT NULL);");
    db.prepare("INSERT INTO bookmarks VALUES (?, ?, ?, ?, ?)").run(pathKey(directory), "CRYL", directory, ...ids);
  } finally {
    db.close();
  }
  const migrated = JSON.parse(command(["resume", "cryl", "--dry-run"]));
  assert.deepEqual(migrated.args.filter((arg) => ids.includes(arg)), ids);
});

test("native hook capture supplies only the current session metadata", () => {
  const sessionId = randomUUID();
  const codex = captureSession("codex", { session_id: sessionId, cwd: "/project", transcript_path: "private" });
  const agy = captureSession("antigravity", { conversationId: sessionId, workspacePaths: ["/project"], transcriptPath: "private" });
  assert.match(codex.hookSpecificOutput.additionalContext, new RegExp(sessionId));
  assert.match(agy.injectSteps[0].systemMessage.systemMessage, new RegExp(sessionId));
  assert.doesNotMatch(JSON.stringify({ codex, agy }), /private/);
  assert.deepEqual(captureSession("codex", { session_id: "invalid" }), {});
});

test("canceled joins cannot match and expired pairings revoke each handle", async (t) => {
  const { directory } = fixture(t);
  let timestamp = 0;
  const relay = new Relay(directory, () => timestamp);
  const live = new AbortController();
  const cancel = new AbortController();
  const connect = (role, signal) => relay.execute({
    action: "connect", role, workspace: directory, waitMs: 1000,
  }, signal);
  const canceled = connect("codex", cancel.signal);
  cancel.abort();
  await assert.rejects(canceled, /canceled/);
  const [codex, agy] = await Promise.all([connect("codex", live.signal), connect("antigravity", live.signal)]);
  timestamp += 31 * 60 * 1000;
  for (const peer of [codex, agy]) {
    await assert.rejects(relay.execute({
      action: "status", role: peer.role, handle: peer.handle,
    }, live.signal), /pairing has ended/);
  }
  assert.equal(relay.idle, true);
});

test("serves a token-gated local browser dashboard with live SSE team state updates", { timeout: 20_000 }, async (t) => {
  const { directory, env, command } = fixture(t);
  const workspace = join(directory, "Studio Project");
  mkdirSync(workspace);
  const [lead, agy] = await Promise.all([openClient("codex", env), openClient("antigravity", env)]);
  t.after(() => Promise.all([lead.close(), agy.close()]));

  const url = command(["dashboard", "--no-open"]).trim();
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/d\/[a-f0-9]{32}\/$/);
  const origin = new URL(url).origin;
  assert.equal((await fetch(`${origin}/`)).status, 403);
  assert.equal((await fetch(`${origin}/d/${"0".repeat(32)}/api/state`)).status, 403);

  const page = await fetch(url);
  assert.equal(page.status, 200);
  const html = await page.text();
  const nonce = /<script nonce="([^"]+)">/.exec(html)?.[1];
  assert.ok(nonce);
  assert.ok(page.headers.get("content-security-policy").includes(`script-src 'nonce-${nonce}'`));
  assert.match(html, /Agent Pair Studio/);
  assert.match(html, /Cozy Night|Cream Paper/);

  const streamAbort = new AbortController();
  t.after(() => streamAbort.abort());
  const eventsResponse = await fetch(`${url}events`, { signal: streamAbort.signal });
  assert.equal(eventsResponse.status, 200);
  const reader = eventsResponse.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";
  const nextSnapshot = async () => {
    while (true) {
      const idx = sseBuffer.indexOf("\n\n");
      if (idx >= 0) {
        const block = sseBuffer.slice(0, idx);
        sseBuffer = sseBuffer.slice(idx + 2);
        const line = block.split("\n").find((entry) => entry.startsWith("data: "));
        if (line) return JSON.parse(line.slice(6));
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("SSE stream ended unexpectedly.");
      sseBuffer += decoder.decode(value, { stream: true });
    }
  };

  const initial = await nextSnapshot();
  assert.deepEqual(initial.runs, []);

  const assignments = [
    { id: "api", owner: "orchestrator", profile: "codex", title: "Build API", paths: ["src/api/"], checks: ["API tests pass"] },
    { id: "ui", owner: "frontend", profile: "antigravity", title: "Build UI", paths: ["src/ui/"], checks: ["UI renders"] },
  ];
  const run = await tool(lead, "team_start", {
    workspace, sessionId: randomUUID(), workerCount: 1, allowedProfiles: ["antigravity"], assignments,
  });
  assert.equal(run.dashboardUrl, undefined);
  const afterStart = await nextSnapshot();
  assert.equal(afterStart.runs.length, 1);
  assert.equal(afterStart.runs[0].members.find((m) => m.member === "frontend").status, "waiting");

  const worker = await tool(agy, "team_join", { workspace, sessionId: randomUUID() });
  const afterJoin = await nextSnapshot();
  assert.match(afterJoin.runs[0].tag, /^[A-Z0-9]{4}$/);
  assert.equal(afterJoin.runs[0].members.find((m) => m.member === "frontend").status, "idle");

  await tool(agy, "team_update", { handle: worker.handle, taskId: "ui", transition: "start" });
  const afterWorking = await nextSnapshot();
  assert.equal(afterWorking.runs[0].members.find((m) => m.member === "frontend").status, "working");

  await tool(agy, "team_update", { handle: worker.handle, taskId: "ui", transition: "block", note: "Need palette" });
  const afterBlocked = await nextSnapshot();
  assert.equal(afterBlocked.runs[0].members.find((m) => m.member === "frontend").status, "blocked");

  const stateRes = await fetch(`${url}api/state`);
  assert.equal(stateRes.status, 200);
  const state = await stateRes.json();
  assert.equal(state.runs[0].tag, afterJoin.runs[0].tag);
  assert.equal(state.runs[0].tasks.find((task) => task.id === "ui").note, "Need palette");

  await tool(lead, "pair_disconnect", { handle: run.handle });
  const afterClose = await nextSnapshot();
  assert.deepEqual(afterClose.runs, []);
});
