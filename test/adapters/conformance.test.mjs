import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
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
import { captureSession } from "../../dist/capture.js";
import { applySetup, setupPlan } from "../../dist/setup.js";

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
  test(`adapter conformance: ${spec.adapter.id}`, (t) => {
    const dir = tempDir(t);
    const configHome = join(dir, "config");
    const dataDir = join(dir, "data");
    const workspace = join(dir, "repo");
    const entry = join(dir, "dist", "cli.js");
    mkdirSync(configHome, { recursive: true });
    mkdirSync(workspace, { recursive: true });

    const { adapter } = spec;
    assert.match(adapter.id, /^[a-z][a-z0-9-]{0,39}$/);
    assert.ok(adapter.displayName.length > 0);
    assert.ok(adapter.executable.length > 0);
    assert.equal(typeof adapter.experimental, "boolean");

    // 1. Setup preserves foreign entries and is idempotent
    spec.seedForeign(configHome);
    const context = {
      entry,
      configHome,
      skillContent: "# Skill\n",
      dataDir,
      readFile: readOptional,
      registration: registrationFor(entry, adapter.id, dataDir),
    };
    const firstPlan = adapter.setup(context);
    assert.ok(firstPlan.length >= 2);
    applySetup(firstPlan);
    spec.assertForeignPreserved(configHome);

    const secondPlan = adapter.setup(context);
    const secondChanges = secondPlan.filter((edit) => edit.content !== edit.original);
    assert.deepEqual(secondChanges, []);

    // 2. Unmanaged conflict fails closed
    const conflictHome = join(dir, "conflict");
    mkdirSync(conflictHome, { recursive: true });
    spec.seedUnmanagedConflict(conflictHome);
    assert.throws(
      () => adapter.setup({ ...context, configHome: conflictHome }),
      /unmanaged/i,
    );

    // 3. Launch and resume specs across platforms
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

    // 4. Session ID discovery extracts metadata without leaking private fields
    const discovered = adapter.discoverSessionId(spec.validPayload(sessionId, workspace));
    const serialized = JSON.stringify(discovered);
    assert.match(serialized, new RegExp(sessionId));
    assert.doesNotMatch(serialized, /secret-transcript/);
    assert.deepEqual(adapter.discoverSessionId({ session_id: "not-a-uuid" }), {});
  });
}

test("experimental adapters are gated by default and enabled via option or env var", (t) => {
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
  const entry = join(process.cwd(), "dist", "cli.js");
  const plan = setupPlan(entry, ["gemini"]);
  assert.equal(plan.length, 2);
});

test("registerAdapter supports custom adapters with cleanup", () => {
  const unregister = registerAdapter({
    id: "custom-test",
    displayName: "Custom Test",
    experimental: false,
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
