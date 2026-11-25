import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { captureSession } from "../dist/capture.js";
import { Relay } from "../dist/relay.js";
import { baseCommit, changedPaths, violations } from "../dist/git/ownership.js";
import { transport } from "../dist/transport/index.js";
import { saveSessions } from "../dist/bookmarks.js";
import { resumePlan } from "../dist/resume.js";
import { createWorktrees, mergeWorktree, cleanupWorktrees } from "../dist/git/worktrees.js";
import { pathKey } from "../dist/workspace.js";

const entry = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const toolNames = ["pair_connect", "team_setup", "team_start", "team_join", "team_update", "team_merge", "team_heartbeat", "team_reassign", "pair_send", "pair_inbox", "pair_ack", "pair_status", "pair_disconnect"];

test("worktrees merge independent changes and clean up safely", (t) => {
  const { directory } = fixture(t);
  const workspace = join(directory, "repo");
  mkdirSync(workspace);
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "ignore" });
  git(workspace, "init");
  git(workspace, "config", "user.email", "test@example.invalid");
  git(workspace, "config", "user.name", "Test");
  writeFileSync(join(workspace, "base"), "base");
  git(workspace, "add", "."); git(workspace, "commit", "-m", "base");
  const trees = createWorktrees(workspace, join(directory, "data"), randomUUID(), ["a", "b"]);
  for (const tree of trees) {
    writeFileSync(join(tree.path, tree.member), tree.member);
    git(tree.path, "add", "."); git(tree.path, "commit", "-m", tree.member);
  }
  assert.throws(() => cleanupWorktrees(workspace, trees), /Git merge-base failed/);
  for (const tree of trees) mergeWorktree(workspace, tree);
  assert.equal(readFileSync(join(workspace, "a"), "utf8"), "a");
  assert.equal(readFileSync(join(workspace, "b"), "utf8"), "b");
  cleanupWorktrees(workspace, trees);
  assert.equal(existsSync(trees[0].path), false);
  assert.equal(execFileSync("git", ["branch", "--list", "agent-pair/*"], { cwd: workspace, encoding: "utf8" }).trim(), "");
});

test("worktree merge reports conflicts and preserves the branch", (t) => {
  const { directory } = fixture(t);
  const workspace = join(directory, "repo"); mkdirSync(workspace);
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "ignore" });
  git(workspace, "init"); git(workspace, "config", "user.email", "test@example.invalid"); git(workspace, "config", "user.name", "Test");
  writeFileSync(join(workspace, "file"), "base\n"); git(workspace, "add", "."); git(workspace, "commit", "-m", "base");
  const [tree] = createWorktrees(workspace, join(directory, "data"), randomUUID(), ["a"]);
  writeFileSync(join(tree.path, "file"), "worker\n"); git(tree.path, "add", "."); git(tree.path, "commit", "-m", "worker");
  writeFileSync(join(workspace, "file"), "lead\n"); git(workspace, "add", "."); git(workspace, "commit", "-m", "lead");
  assert.throws(() => mergeWorktree(workspace, tree), /Git merge failed/);
  assert.equal(existsSync(tree.path), true);
  git(workspace, "merge", "--abort");
});

test("isolated team hands off and merges the worker branch", async (t) => {
  const { directory } = fixture(t);
  const workspace = join(directory, "repo"); mkdirSync(workspace);
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "ignore" });
  git(workspace, "init"); git(workspace, "config", "user.email", "test@example.invalid"); git(workspace, "config", "user.name", "Test");
  writeFileSync(join(workspace, "base"), "base"); git(workspace, "add", "."); git(workspace, "commit", "-m", "base");
  const relay = new Relay(join(directory, "data"));
  const call = (request) => relay.execute(request, new AbortController().signal);
  const assignments = [
    { id: "lead", owner: "orchestrator", profile: "codex", title: "lead", paths: ["lead"], checks: ["test"], dependsOn: [] },
    { id: "worker", owner: "worker", profile: "claude", title: "worker", paths: ["owned"], checks: ["test"], dependsOn: [] },
  ];
  const lead = await call({ action: "teamStart", role: "codex", workspace, workerCount: 1, allowedProfiles: ["claude"], assignments, enforce: "strict", isolation: "worktree" });
  const worker = await call({ action: "teamJoin", role: "claude", workspace });
  const update = (role, handle, transition, extra = {}) => call({ action: "teamUpdate", role, handle, taskId: "worker", transition, ...extra });
  await update("claude", worker.handle, "start");
  mkdirSync(join(worker.worktree, "owned")); writeFileSync(join(worker.worktree, "owned", "new"), "worker");
  await update("claude", worker.handle, "handoff", { note: "done", checks: ["passed"] });
  await update("codex", lead.handle, "accept");
  await assert.rejects(call({ action: "teamMerge", role: "codex", handle: lead.handle, member: "worker" }), /Commit or remove/);
  git(worker.worktree, "add", "."); git(worker.worktree, "commit", "-m", "worker");
  await call({ action: "teamMerge", role: "codex", handle: lead.handle, member: "worker" });
  assert.equal(readFileSync(join(workspace, "owned", "new"), "utf8"), "worker");
  await call({ action: "disconnect", role: "codex", handle: lead.handle });
  assert.equal(existsSync(worker.worktree), false);
});

test("persisted relay restores a killed process and its message log", async (t) => {
  const { directory } = fixture(t);
  const relayModule = new URL("../dist/relay.js", import.meta.url).href;
  const script = `import {Relay} from ${JSON.stringify(relayModule)}; const r=new Relay(process.argv[1]); const signal=new AbortController().signal; const call=(v)=>r.execute(v,signal); const workspace=process.argv[1]; const assignments=[{id:'lead',owner:'orchestrator',profile:'codex',title:'lead',paths:['lead'],checks:['ok'],dependsOn:[]},{id:'worker',owner:'worker',profile:'claude',title:'worker',paths:['worker'],checks:['ok'],dependsOn:[]}]; const lead=await call({action:'teamStart',role:'codex',workspace,workerCount:1,allowedProfiles:['claude'],assignments,enforce:'off',persist:true}); const worker=await call({action:'teamJoin',role:'claude',workspace}); await call({action:'teamUpdate',role:'claude',handle:worker.handle,taskId:'worker',transition:'start'}); await call({action:'send',role:'claude',handle:worker.handle,taskId:'worker',kind:'update',requestId:'one',body:'saved',to:'orchestrator'}); console.log(JSON.stringify({lead,worker})); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, directory], { stdio: ["ignore", "pipe", "pipe"] });
  const line = await new Promise((resolve, reject) => { child.stdout.once("data", (chunk) => resolve(chunk.toString())); child.once("error", reject); child.once("exit", () => reject(new Error("relay exited before ready"))); });
  const { lead } = JSON.parse(line);
  child.kill(); await new Promise((resolve) => child.once("exit", resolve));
  const relay = new Relay(directory);
  const signal = new AbortController().signal;
  const status = await relay.execute({ action: "status", role: "codex", handle: lead.handle, waitMs: 0 }, signal);
  assert.equal(status.tasks.find((task) => task.id === "worker").state, "active");
  const inbox = await relay.execute({ action: "inbox", role: "codex", handle: lead.handle, waitMs: 0, limit: 20 }, signal);
  assert.equal(inbox.messages[0].body, "saved");
  await relay.execute({ action: "disconnect", role: "codex", handle: lead.handle }, signal);
});

test("broker restart restores persisted teams", async (t) => {
  const { directory, env } = fixture(t);
  let broker;
  t.after(() => { if (broker && broker.exitCode === null) broker.kill(); });
  const channel = transport(env.AGENT_PAIR_DATA_DIR);
  const launch = () => { broker = spawn(process.execPath, [entry, "broker"], { env, stdio: "ignore" }); };
  const request = async (payload) => {
    let lastError;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const secret = readFileSync(join(env.AGENT_PAIR_DATA_DIR, "relay.key"), "utf8");
        return await new Promise((resolve, reject) => {
          const socket = channel.connect(); let text = "";
          socket.once("connect", () => socket.write(JSON.stringify({ secret, request: payload }) + "\n"));
          socket.once("error", reject);
          socket.on("data", (data) => { text += data; if (text.includes("\n")) { const result = JSON.parse(text); socket.destroy(); if (result.error) reject(new Error(result.error)); else resolve(result.data); } });
        });
      } catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 50)); }
    }
    throw lastError;
  };
  const assignments = [
    { id: "lead", owner: "orchestrator", profile: "codex", title: "lead", paths: ["lead"], checks: ["ok"] },
    { id: "worker", owner: "worker", profile: "claude", title: "worker", paths: ["worker"], checks: ["ok"] },
  ];
  launch();
  const lead = await request({ action: "teamStart", role: "codex", workspace: directory, workerCount: 1, allowedProfiles: ["claude"], assignments, enforce: "off", persist: true, noDashboard: true });
  const worker = await request({ action: "teamJoin", role: "claude", workspace: directory });
  await request({ action: "teamUpdate", role: "claude", handle: worker.handle, taskId: "worker", transition: "start" });
  broker.kill(); await new Promise((resolve) => broker.once("exit", resolve));
  launch();
  const status = await request({ action: "status", role: "codex", handle: lead.handle, waitMs: 0 });
  assert.equal(status.tasks.find((task) => task.id === "worker").state, "active");
  await request({ action: "disconnect", role: "codex", handle: lead.handle });
});

test("silent workers are stalled and can be reassigned", async (t) => {
  const { directory } = fixture(t);
  let now = 1000;
  const relay = new Relay(directory, () => now);
  const call = (request) => relay.execute(request, new AbortController().signal);
  const assignments = [
    { id: "lead", owner: "orchestrator", profile: "codex", title: "lead", paths: ["lead"], checks: ["ok"], dependsOn: [] },
    { id: "worker", owner: "worker", profile: "claude", title: "worker", paths: ["worker"], checks: ["ok"], dependsOn: [] },
  ];
  const lead = await call({ action: "teamStart", role: "codex", workspace: directory, workerCount: 1, allowedProfiles: ["claude"], assignments, enforce: "off", persist: true, stallTimeoutMs: 1000 });
  const worker = await call({ action: "teamJoin", role: "claude", workspace: directory });
  await call({ action: "teamUpdate", role: "claude", handle: worker.handle, taskId: "worker", transition: "start" });
  now += 1001;
  const status = await call({ action: "status", role: "codex", handle: lead.handle, waitMs: 0 });
  assert.equal(status.tasks.find((task) => task.id === "worker").state, "stalled");
  const task = await call({ action: "teamReassign", role: "codex", handle: lead.handle, taskId: "worker", member: "orchestrator" });
  assert.equal(task.owner, "orchestrator"); assert.equal(task.state, "pending");
  const restored = new Relay(directory, () => now);
  const restoredStatus = await restored.execute({ action: "status", role: "codex", handle: lead.handle, waitMs: 0 }, new AbortController().signal);
  assert.equal(restoredStatus.tasks.find((item) => item.id === "worker").owner, "orchestrator");
});

test("Unix resume plan contains the native command for each saved session", (t) => {
  const { directory } = fixture(t);
  const previous = process.env.AGENT_PAIR_DATA_DIR;
  process.env.AGENT_PAIR_DATA_DIR = join(directory, "data");
  t.after(() => { if (previous === undefined) delete process.env.AGENT_PAIR_DATA_DIR; else process.env.AGENT_PAIR_DATA_DIR = previous; });
  const sessionId = randomUUID();
  const workerId = randomUUID();
  const tag = saveSessions(process.env.AGENT_PAIR_DATA_DIR, directory, [{ member: "orchestrator", profile: "codex", sessionId }, { member: "worker", profile: "claude", sessionId: workerId }]);
  const plan = resumePlan(tag, "linux");
  assert.deepEqual(plan.commands, [{ member: "orchestrator", command: "codex", args: ["resume", sessionId] }, { member: "worker", command: "claude", args: ["--resume", workerId] }]);
});

for (const kind of ["win32", "unix"]) {
  test(`transport conformance: ${kind}`, { skip: (process.platform === "win32") !== (kind === "win32") ? "non-native transport" : false }, async (t) => {
    const { directory } = fixture(t);
    const channel = transport(directory);
    const server = createServer((socket) => socket.end("ok"));
    await channel.listen(server);
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const result = await new Promise((resolve, reject) => {
      const socket = channel.connect();
      socket.once("error", reject);
      socket.once("data", (data) => resolve(data.toString()));
    });
    assert.equal(result, "ok");
  });
}

test("Unix transport recovers a crashed socket and preserves a live listener", { skip: process.platform === "win32" ? "requires native Unix sockets" : false }, async (t) => {
  const { directory } = fixture(t);
  const channel = transport(directory);
  const modulePath = new URL("../dist/transport/index.js", import.meta.url).href;
  const script = `import {createServer} from 'node:net'; import {transport} from ${JSON.stringify(modulePath)}; const server=createServer(); await transport(process.argv[1]).listen(server); console.log('ready');`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, directory], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => { child.stdout.once("data", resolve); child.once("error", reject); child.once("exit", () => reject(new Error("relay exited early"))); });
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  const server = createServer((socket) => socket.end("ok"));
  await channel.listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const rival = createServer();
  await assert.rejects(channel.listen(rival), (error) => error.code === "EADDRINUSE");
  const response = await new Promise((resolve, reject) => {
    const socket = channel.connect(); socket.once("error", reject); socket.once("data", (data) => resolve(data.toString()));
  });
  assert.equal(response, "ok");
});

test("ownership gate checks tracked, untracked, deleted and renamed paths", (t) => {
  const { directory } = fixture(t);
  const git = (...args) => execFileSync("git", args, { cwd: directory, stdio: "ignore" });
  git("init");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  mkdirSync(join(directory, "owned"));
  writeFileSync(join(directory, "owned", "old"), "old");
  writeFileSync(join(directory, "outside"), "outside");
  git("add", ".");
  git("commit", "-m", "base");
  const base = baseCommit(directory);
  git("mv", "owned/old", "moved");
  rmSync(join(directory, "outside"));
  writeFileSync(join(directory, "owned", "new"), "new");
  const paths = changedPaths(directory, base);
  assert.deepEqual(paths, ["moved", "outside", "owned/new", "owned/old"]);
  assert.deepEqual(violations(paths, ["owned"]), ["moved", "outside"]);
  assert.deepEqual(violations(["ownedness/file"], ["owned"]), ["ownedness/file"]);
});

test("strict handoff rejects out-of-bound changes and exposes the violation", async (t) => {
  const { directory } = fixture(t);
  const git = (...args) => execFileSync("git", args, { cwd: directory, stdio: "ignore" });
  git("init");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  writeFileSync(join(directory, "base"), "base");
  git("add", ".");
  git("commit", "-m", "base");
  const relay = new Relay(directory);
  const signal = new AbortController().signal;
  const call = (request) => relay.execute(request, signal);
  const assignments = [
    { id: "lead", owner: "orchestrator", profile: "codex", title: "lead", paths: ["lead"], checks: ["test"], dependsOn: [] },
    { id: "worker", owner: "worker", profile: "claude", title: "worker", paths: ["owned"], checks: ["test"], dependsOn: [] },
  ];
  const lead = await call({ action: "teamStart", role: "codex", workspace: directory, workerCount: 1, allowedProfiles: ["claude"], assignments, enforce: "strict" });
  const worker = await call({ action: "teamJoin", role: "claude", workspace: directory });
  const update = (transition, extra = {}) => call({ action: "teamUpdate", role: "claude", handle: worker.handle, taskId: "worker", transition, ...extra });
  await update("start");
  writeFileSync(join(directory, "outside"), "unowned");
  await assert.rejects(update("handoff", { note: "done", checks: ["passed"] }), /outside/);
  const status = await call({ action: "status", role: "codex", handle: lead.handle, waitMs: 0 });
  assert.equal(status.tasks.find((task) => task.id === "worker").state, "active");
  assert.deepEqual(status.ownershipEvents[0].files, ["outside"]);
  rmSync(join(directory, "outside"));
  mkdirSync(join(directory, "owned"));
  writeFileSync(join(directory, "owned", "new"), "owned");
  assert.equal((await update("handoff", { note: "done", checks: ["passed"] })).state, "ready");
});

test("non-Git workspaces require an explicit warn or off mode", async (t) => {
  const { directory } = fixture(t);
  const assignments = [
    { id: "lead", owner: "orchestrator", profile: "codex", title: "lead", paths: ["lead"], checks: ["test"], dependsOn: [] },
    { id: "worker", owner: "worker", profile: "claude", title: "worker", paths: ["owned"], checks: ["test"], dependsOn: [] },
  ];
  for (const mode of ["strict", "warn", "off"]) {
    const relay = new Relay(directory);
    const call = (request) => relay.execute(request, new AbortController().signal);
    const lead = await call({ action: "teamStart", role: "codex", workspace: directory, workerCount: 1, allowedProfiles: ["claude"], assignments, enforce: mode });
    const worker = await call({ action: "teamJoin", role: "claude", workspace: directory });
    const update = (transition, extra = {}) => call({ action: "teamUpdate", role: "claude", handle: worker.handle, taskId: "worker", transition, ...extra });
    if (mode === "strict") {
      await assert.rejects(update("start"), /requires a Git workspace/);
    } else {
      await update("start");
      await update("handoff", { note: "done", checks: ["passed"] });
      const status = await call({ action: "status", role: "codex", handle: lead.handle, waitMs: 0 });
      assert.equal(status.ownershipEvents.length, mode === "warn" ? 1 : 0);
    }
  }
});

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
  if (name === "team_start") args = { enforce: "off", ...args };
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
  assert.deepEqual(initial.setups, []);
  assert.deepEqual(await tool(lead, "team_setup", { workspace }), {
    currentProfile: "codex", setup: null, dashboardUrl: url,
  });

  const setupInput = { workspace, leadProfile: "codex", workers: { codex: 0, antigravity: 1, claude: 0 } };
  const postSetup = (input, requestOrigin = origin) => fetch(`${url}api/setup`, {
    method: "POST", headers: { origin: requestOrigin, "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  assert.equal((await postSetup(setupInput, "http://example.test")).status, 403);
  assert.equal((await postSetup({ ...setupInput, workers: { codex: 63, antigravity: 1, claude: 0 } })).status, 400);
  const saved = await postSetup(setupInput);
  assert.equal(saved.status, 201);
  const setup = await saved.json();
  assert.equal((await nextSnapshot()).setups[0].id, setup.id);
  assert.deepEqual(await tool(lead, "team_setup", { workspace }), { currentProfile: "codex", setup });

  const assignments = [
    { id: "api", owner: "orchestrator", profile: "codex", title: "Build API", paths: ["src/api/"], checks: ["API tests pass"] },
    { id: "ui", owner: "frontend", profile: "antigravity", title: "Build UI", paths: ["src/ui/"], checks: ["UI renders"] },
  ];
  const startArgs = { workspace, setupId: setup.id, sessionId: randomUUID(), workerCount: 1, allowedProfiles: ["antigravity"], assignments };
  await assert.rejects(tool(agy, "team_start", startArgs), /requires a codex orchestrator/);
  await assert.rejects(tool(lead, "team_start", {
    ...startArgs, allowedProfiles: ["claude"], assignments: [assignments[0], { ...assignments[1], profile: "claude" }],
  }), /must match the dashboard setup/);
  const run = await tool(lead, "team_start", startArgs);
  assert.equal(run.dashboardUrl, undefined);
  const afterStart = await nextSnapshot();
  assert.equal(afterStart.runs.length, 1);
  assert.deepEqual(afterStart.setups, []);
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
