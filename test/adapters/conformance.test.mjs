import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  antigravityAdapter,
  claudeAdapter,
  codexAdapter,
  geminiAdapter,
  getAdapter,
  listAdapters,
  registerAdapter,
  registrationFor,
} from "../../dist/adapters/index.js";
import { saveSessions } from "../../dist/bookmarks.js";
import { captureSession } from "../../dist/capture.js";
import { resumePlan } from "../../dist/resume.js";
import { applySetup, setupPlan } from "../../dist/setup.js";

const cliEntry = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

function tempDir(t) {
  const parent = realpathSync(tmpdir());
  const dir = mkdtempSync(join(parent, "agent-pair-adapter-"));
  t.after(() => {
    if (dirname(resolve(dir)) === parent) rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function readOptional(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

const conformanceCases = [
  {
    adapter: codexAdapter,
    validPayload: (id, cwd) => ({ session_id: id, cwd, transcript_path: "secret-transcript" }),
    seedForeign: (configHome) => {
      const dir = join(configHome, ".codex");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "config.toml"), 'model = "keep"\n[mcp_servers.keep]\ncommand = "keep"\n');
      writeFileSync(join(dir, "hooks.json"), JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "keep" }] }] },
      }));
    },
    seedUnmanagedConflict: (configHome) => {
      const dir = join(configHome, ".codex");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "config.toml"), '[mcp_servers.agent_pair]\ncommand = "other"\n');
    },
    assertForeignPreserved: (configHome) => {
      const toml = readFileSync(join(configHome, ".codex", "config.toml"), "utf8");
      assert.match(toml, /\[mcp_servers\.keep\]/);
      const hooks = JSON.parse(readFileSync(join(configHome, ".codex", "hooks.json"), "utf8"));
      assert.equal(hooks.hooks.SessionStart[0].hooks[0].command, "keep");
    },
  },
  {
    adapter: antigravityAdapter,
    validPayload: (id, cwd) => ({ conversationId: id, workspacePaths: [cwd], transcriptPath: "secret-transcript" }),
    seedForeign: (configHome) => {
      const dir = join(configHome, ".gemini", "config");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "mcp_config.json"), JSON.stringify({ mcpServers: { keep: { command: "keep" } } }));
      writeFileSync(join(dir, "hooks.json"), JSON.stringify({ keep: { SessionStart: [{ command: "keep" }] } }));
    },
    seedUnmanagedConflict: (configHome) => {
      const dir = join(configHome, ".gemini", "config");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "mcp_config.json"), JSON.stringify({ mcpServers: { agent_pair: { command: "other", args: ["wrong"] } } }));
    },
    assertForeignPreserved: (configHome) => {
      const mcp = JSON.parse(readFileSync(join(configHome, ".gemini", "config", "mcp_config.json"), "utf8"));
      assert.equal(mcp.mcpServers.keep.command, "keep");
      const hooks = JSON.parse(readFileSync(join(configHome, ".gemini", "config", "hooks.json"), "utf8"));
      assert.equal(hooks.keep.SessionStart[0].command, "keep");
    },
  },
  {
    adapter: claudeAdapter,
    validPayload: (id, cwd) => ({ session_id: id, cwd, transcript_path: "secret-transcript" }),
    seedForeign: (configHome) => {
      const dir = join(configHome, ".claude");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(configHome, ".claude.json"), JSON.stringify({ mcpServers: { keep: { command: "keep" } } }));
      writeFileSync(join(dir, "settings.json"), JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "keep" }] }] },
      }));
    },
    seedUnmanagedConflict: (configHome) => {
      writeFileSync(join(configHome, ".claude.json"), JSON.stringify({ mcpServers: { agent_pair: { command: "other", args: ["wrong"] } } }));
    },
    assertForeignPreserved: (configHome) => {
      const mcp = JSON.parse(readFileSync(join(configHome, ".claude.json"), "utf8"));
      assert.equal(mcp.mcpServers.keep.command, "keep");
      const settings = JSON.parse(readFileSync(join(configHome, ".claude", "settings.json"), "utf8"));
      assert.equal(settings.hooks.SessionStart[0].hooks[0].command, "keep");
    },
  },
  {
    adapter: geminiAdapter,
    validPayload: (id, cwd) => ({ session_id: id, cwd, transcript_path: "secret-transcript" }),
    seedForeign: (configHome) => {
      const dir = join(configHome, ".gemini");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "settings.json"), JSON.stringify({
        theme: "dark",
        mcpServers: { keep: { command: "keep" } },
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "keep" }] }] },
      }));
    },
    seedUnmanagedConflict: (configHome) => {
      const dir = join(configHome, ".gemini");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "settings.json"), JSON.stringify({
        mcpServers: { agent_pair: { command: "other", args: ["wrong"] } },
      }));
    },
    assertForeignPreserved: (configHome) => {
      const settings = JSON.parse(readFileSync(join(configHome, ".gemini", "settings.json"), "utf8"));
      assert.equal(settings.theme, "dark");
      assert.equal(settings.mcpServers.keep.command, "keep");
      assert.equal(settings.hooks.SessionStart[0].hooks[0].command, "keep");
    },
  },
];

for (const spec of conformanceCases) {
  test(`adapter conformance: ${spec.adapter.id}`, async (t) => {
    const dir = tempDir(t);
    const configHome = join(dir, "config");
    const dataDir = join(dir, "data");
    const workspace = join(dir, "repo");
    mkdirSync(configHome, { recursive: true });
    mkdirSync(workspace, { recursive: true });

    const { adapter } = spec;
    assert.match(adapter.id, /^[a-z][a-z0-9-]{0,39}$/);
    assert.ok(adapter.displayName.length > 0);
    assert.ok(adapter.executable.length > 0);
    assert.equal(typeof adapter.experimental, "boolean");
    assert.equal(typeof adapter.supportsRelayProfile, "boolean");

    // 1. Setup preserves foreign entries and is idempotent (or fails closed when relay profile is unsupported)
    spec.seedForeign(configHome);
    const reg = registrationFor(cliEntry, adapter.id, dataDir);
    const context = {
      entry: cliEntry,
      configHome,
      skillContent: "# Skill\n",
      dataDir,
      readFile: readOptional,
      registration: reg,
    };

    const planFn = adapter.supportsRelayProfile
      ? (ctx) => adapter.setup(ctx)
      : (ctx) => {
        assert.throws(() => adapter.setup(ctx), /unusable|roleSchema/i);
        assert.equal(typeof adapter.previewSetup, "function");
        return adapter.previewSetup(ctx);
      };

    const firstPlan = planFn(context);
    assert.ok(firstPlan.length >= 2);
    applySetup(firstPlan);
    spec.assertForeignPreserved(configHome);

    const secondPlan = planFn(context);
    const secondChanges = secondPlan.filter((edit) => edit.content !== edit.original);
    assert.deepEqual(secondChanges, []);

    // 2. Unmanaged conflict fails closed
    const conflictHome = join(dir, "conflict");
    mkdirSync(conflictHome, { recursive: true });
    spec.seedUnmanagedConflict(conflictHome);
    assert.throws(
      () => planFn({ ...context, configHome: conflictHome }),
      /unmanaged/i,
    );

    // 3. Actual serve --profile registration verification
    if (adapter.supportsRelayProfile) {
      const client = new Client({ name: `conformance-${adapter.id}`, version: "1.0.0" });
      const transport = new StdioClientTransport({
        command: reg.command,
        args: reg.args,
        env: { ...process.env, ...reg.env, AGENT_PAIR_NO_DASHBOARD: "1" },
        stderr: "ignore",
      });
      t.after(() => client.close());
      await client.connect(transport);
      const { tools } = await client.listTools();
      assert.ok(tools.some((tool) => tool.name === "team_start"));
      assert.ok(tools.some((tool) => tool.name === "team_join"));
    } else {
      assert.throws(
        () => execFileSync(reg.command, reg.args, {
          env: { ...process.env, ...reg.env, AGENT_PAIR_NO_DASHBOARD: "1" },
          encoding: "utf8",
          stdio: "pipe",
          timeout: 5000,
          windowsHide: true,
        }),
        /Invalid enum value/i,
      );
    }

    // 4. Launch and resume specs across platforms
    const sessionId = randomUUID();
    const winLaunch = adapter.launch(workspace, "Hello", "win32");
    assert.equal(winLaunch.command, `${adapter.executable}.exe`);
    assert.equal(winLaunch.cwd, workspace);
    assert.ok(winLaunch.args.includes("Hello"));

    const unixLaunch = adapter.launch(workspace, undefined, "linux");
    assert.equal(unixLaunch.command, adapter.executable);
    assert.deepEqual(unixLaunch.args, []);

    const winResume = adapter.resume(sessionId, workspace, "win32");
    assert.equal(winResume.command, `${adapter.executable}.exe`);
    assert.ok(winResume.args.includes(sessionId));

    const unixResume = adapter.resume(sessionId, workspace, "darwin");
    assert.equal(unixResume.command, adapter.executable);
    assert.ok(unixResume.args.includes(sessionId));

    // 5. Session ID discovery extracts metadata without leaking private fields
    const discovered = adapter.discoverSessionId(spec.validPayload(sessionId, workspace));
    const serialized = JSON.stringify(discovered);
    assert.match(serialized, new RegExp(sessionId));
    assert.doesNotMatch(serialized, /secret-transcript/);
    assert.deepEqual(adapter.discoverSessionId({ session_id: "not-a-uuid" }), {});
  });
}

test("experimental adapters fail closed on setupPlan without writing unusable files", (t) => {
  const prev = process.env.AGENT_PAIR_EXPERIMENTAL_ADAPTERS;
  delete process.env.AGENT_PAIR_EXPERIMENTAL_ADAPTERS;
  t.after(() => {
    if (prev === undefined) delete process.env.AGENT_PAIR_EXPERIMENTAL_ADAPTERS;
    else process.env.AGENT_PAIR_EXPERIMENTAL_ADAPTERS = prev;
  });

  assert.deepEqual(listAdapters().map((a) => a.id), ["codex", "antigravity", "claude"]);
  assert.throws(() => getAdapter("gemini"), /experimental/i);

  assert.deepEqual(listAdapters({ includeExperimental: true }).map((a) => a.id), ["codex", "antigravity", "claude", "gemini"]);
  assert.equal(getAdapter("gemini", { includeExperimental: true }).id, "gemini");

  const sessionId = randomUUID();
  assert.throws(() => captureSession("gemini", { session_id: sessionId, cwd: "/repo" }), /experimental/i);
  const captured = captureSession("gemini", { session_id: sessionId, cwd: "/repo" }, { includeExperimental: true });
  assert.match(JSON.stringify(captured), new RegExp(sessionId));

  process.env.AGENT_PAIR_EXPERIMENTAL_ADAPTERS = "1";
  assert.equal(getAdapter("gemini").id, "gemini");

  const dir = tempDir(t);
  const prevHome = process.env.AGENT_PAIR_CONFIG_HOME;
  const prevData = process.env.AGENT_PAIR_DATA_DIR;
  process.env.AGENT_PAIR_CONFIG_HOME = join(dir, "home");
  process.env.AGENT_PAIR_DATA_DIR = join(dir, "data");
  t.after(() => {
    if (prevHome === undefined) delete process.env.AGENT_PAIR_CONFIG_HOME;
    else process.env.AGENT_PAIR_CONFIG_HOME = prevHome;
    if (prevData === undefined) delete process.env.AGENT_PAIR_DATA_DIR;
    else process.env.AGENT_PAIR_DATA_DIR = prevData;
  });
  assert.throws(() => setupPlan(cliEntry, ["gemini"]), /Refusing to write unusable MCP configuration/i);
  assert.equal(existsSync(join(dir, "home", ".gemini", "settings.json")), false);
});

test("resumePlan delegates through ClientAdapter for Windows and Unix", (t) => {
  const dir = tempDir(t);
  const workspace = join(dir, "proj");
  const dataDir = join(dir, "data");
  mkdirSync(workspace, { recursive: true });
  const prevData = process.env.AGENT_PAIR_DATA_DIR;
  process.env.AGENT_PAIR_DATA_DIR = dataDir;
  t.after(() => {
    if (prevData === undefined) delete process.env.AGENT_PAIR_DATA_DIR;
    else process.env.AGENT_PAIR_DATA_DIR = prevData;
  });

  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const tag = saveSessions(dataDir, workspace, [
    { member: "orchestrator", profile: "codex", sessionId: ids[0] },
    { member: "worker-a", profile: "antigravity", sessionId: ids[1] },
    { member: "worker-b", profile: "claude", sessionId: ids[2] },
  ]);

  const unixPlan = resumePlan(tag, "linux");
  assert.deepEqual(unixPlan.commands, [
    { member: "orchestrator", ...codexAdapter.resume(ids[0], workspace, "linux"), cwd: undefined },
    { member: "worker-a", ...antigravityAdapter.resume(ids[1], workspace, "linux"), cwd: undefined },
    { member: "worker-b", ...claudeAdapter.resume(ids[2], workspace, "linux"), cwd: undefined },
  ].map(({ member, command, args }) => ({ member, command, args })));

  const winPlan = resumePlan(tag, "win32");
  assert.equal(winPlan.command, "wt.exe");
  assert.equal(winPlan.executableIndices?.length, 3);
  assert.deepEqual(
    winPlan.executableIndices.map((idx) => winPlan.args[idx]),
    ["codex.exe", "agy.exe", "claude.exe"],
  );
});

test("registerAdapter supports custom adapters with cleanup", () => {
  const unregister = registerAdapter({
    id: "custom-test",
    displayName: "Custom Test",
    experimental: false,
    supportsRelayProfile: false,
    executable: "custom",
    setup: () => [],
    doctor: () => "custom 1.0.0",
    launch: (workspace) => ({ command: "custom", args: [], cwd: workspace }),
    resume: (sessionId, workspace) => ({ command: "custom", args: ["--resume", sessionId], cwd: workspace }),
    discoverSessionId: () => ({}),
  });
  try {
    assert.equal(getAdapter("custom-test").displayName, "Custom Test");
  } finally {
    unregister();
  }
  assert.throws(() => getAdapter("custom-test"), /Unknown client adapter/);
});
