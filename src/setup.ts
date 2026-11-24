import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { parse } from "smol-toml";
import { pairRoles, type Role } from "./types.js";
import { dataDirectory } from "./workspace.js";

const begin = "# >>> Agent Pair managed MCP >>>";
const end = "# <<< Agent Pair managed MCP <<<";
const serverName = "agent_pair";
type Json = Record<string, unknown>;
type Edit = { path: string; original?: string; content: string };

export type Registration = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

export function registration(entry: string, role: Role): Registration {
  return {
    command: process.execPath,
    args: [entry, "serve", "--profile", role],
    env: { AGENT_PAIR_DATA_DIR: dataDirectory() },
  };
}

function read(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

function object(value: unknown, label: string): Json {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a configuration object.`);
  }
  return value as Json;
}

function json(source: string | undefined, label: string): Json {
  const text = source?.replace(/^\uFEFF/, "").trim();
  if (!text) return {};
  try {
    return object(JSON.parse(text), label);
  } catch (error) {
    throw new Error(`Could not read ${label} as a JSON object.`, { cause: error });
  }
}

function serialized(value: Json): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function configHome() {
  const home = process.env.AGENT_PAIR_CONFIG_HOME ?? homedir();
  if (!isAbsolute(home)) throw new Error("The configuration home must be an absolute path.");
  return {
    codex: (process.env.AGENT_PAIR_CONFIG_HOME ? undefined : process.env.CODEX_HOME) ?? join(home, ".codex"),
    codexSkill: join(home, ".agents", "skills", "agent-pair", "SKILL.md"),
    antigravity: join(home, ".gemini", "config"),
    claude: join(home, ".claude"),
    claudeMcp: join(home, ".claude.json"),
  };
}

function extractForeignCodexContent(managedBody: string): string {
  const lines = managedBody.split(/\r?\n/);
  const extraIndex = lines.findIndex((line) => {
    const trimmed = line.trim();
    return /^\[.+\]\s*(?:#.*)?$/.test(trimmed) && !trimmed.startsWith(`[mcp_servers.${serverName}]`);
  });
  return extraIndex < 0 ? "" : lines.slice(extraIndex).join("\n").trim();
}

function codexConfig(source: string | undefined, settings: Registration): string {
  const current = source ?? "";
  const original = parse(current.replace(/^\uFEFF/, ""));
  const first = current.indexOf(begin);
  const last = current.indexOf(end);
  const servers = original.mcp_servers as Json | undefined;
  if (first < 0 && servers?.[serverName]) {
    throw new Error("Codex already has an unmanaged agent_pair MCP registration.");
  }
  if ((first < 0) !== (last < 0) || (first >= 0 && last < first)) {
    throw new Error("The Codex Agent Pair MCP block is incomplete.");
  }

  const block = [
    begin,
    `[mcp_servers.${serverName}]`,
    `command = ${JSON.stringify(settings.command)}`,
    `args = ${JSON.stringify(settings.args)}`,
    "tool_timeout_sec = 40",
    `env = { AGENT_PAIR_DATA_DIR = ${JSON.stringify(settings.env.AGENT_PAIR_DATA_DIR)} }`,
    end,
  ].join("\n");
  let result: string;
  if (first >= 0) {
    const extra = extractForeignCodexContent(current.slice(first + begin.length, last));
    const after = current.slice(last + end.length);
    const tail = extra
      ? `\n\n${extra}${after.trim() ? `\n\n${after.trimStart()}` : "\n"}`
      : after;
    result = current.slice(0, first) + block + tail;
  } else {
    result = current.trimEnd() + (current.trim() ? "\n\n" : "") + block + "\n";
  }
  parse(result.replace(/^\uFEFF/, ""));
  return result;
}

function shellArgument(value: string): string {
  if (process.platform !== "win32") return "'" + value.replaceAll("'", "'\\''") + "'";
  if (/["%!\r\n]/.test(value)) throw new Error("Move the package to a path compatible with Windows hook commands.");
  return '"' + value + '"';
}

function hookHandler(entry: string, role: Role): Json {
  if (role === "claude") {
    return { type: "command", command: process.execPath, args: [entry, "capture-session", "--profile", role], timeout: 5 };
  }
  const command = `node ${shellArgument(entry)} capture-session --profile ${role}`;
  return { type: "command", command, timeout: 5 };
}

function managedHook(handler: unknown, role: Role): boolean {
  const hook = handler as Json | null;
  return typeof hook?.command === "string" && (hook.command.endsWith(` capture-session --profile ${role}`)
    || (role === "claude" && Array.isArray(hook.args) && hook.args.slice(1).join(" ") === "capture-session --profile claude"));
}

function sessionHooks(source: string | undefined, entry: string, role: "codex" | "claude"): string {
  const doc = json(source, `${role} hook configuration`);
  const hooks = object(doc.hooks ?? {}, `${role} hooks`);
  const current = hooks.SessionStart ?? [];
  if (!Array.isArray(current)) throw new Error(`${role} SessionStart hooks must be an array.`);
  const retained = current.flatMap((item) => {
    const group = object(item, `${role} hook group`);
    if (!Array.isArray(group.hooks) || !group.hooks.some((handler) => managedHook(handler, role))) {
      return [group];
    }
    const handlers = group.hooks.filter((handler) => !managedHook(handler, role));
    return handlers.length ? [{ ...group, hooks: handlers }] : [];
  });
  retained.push({ hooks: [hookHandler(entry, role)] });
  return serialized({ ...doc, hooks: { ...hooks, SessionStart: retained } });
}

function jsonMcpConfig(source: string | undefined, settings: Registration, role: "antigravity" | "claude"): string {
  const doc = json(source, `${role} MCP configuration`);
  const servers = object(doc.mcpServers ?? {}, `${role} MCP servers`);
  if (servers[serverName] !== undefined) {
    const existing = object(servers[serverName], `${role} Agent Pair MCP server`);
    const args = existing.args;
    if (!Array.isArray(args) || args.slice(1, 4).join(" ") !== `serve --profile ${role}`) {
      throw new Error(`${role} already has an unmanaged agent_pair MCP registration.`);
    }
  }
  const options = role === "claude" ? { type: "stdio" } : { timeoutSeconds: 40 };
  return serialized({
    ...doc,
    mcpServers: { ...servers, [serverName]: { ...options, ...settings } },
  });
}

function agyHooks(source: string | undefined, entry: string): string {
  const doc = json(source, "Antigravity hooks.json");
  const existing = doc["agent-pair"];
  if (existing !== undefined) {
    const group = object(existing, "Antigravity Agent Pair hook");
    if (!Array.isArray(group.SessionStart) || !group.SessionStart.some((handler) => managedHook(handler, "antigravity"))) {
      throw new Error("Antigravity already has an unmanaged agent-pair hook.");
    }
  }
  return serialized({ ...doc, "agent-pair": { SessionStart: [hookHandler(entry, "antigravity")] } });
}

export function setupPlan(entry: string, profiles: readonly Role[] = pairRoles): Edit[] {
  const locations = configHome();
  const skill = readFileSync(join(dirname(entry), "..", "skills", "agent-pair", "SKILL.md"), "utf8");
  const files: Record<Role, [string, (old: string | undefined) => string][]> = {
    codex: [
      [join(locations.codex, "config.toml"), (old) => codexConfig(old, registration(entry, "codex"))],
      [join(locations.codex, "hooks.json"), (old) => sessionHooks(old, entry, "codex")],
      [locations.codexSkill, () => skill],
    ],
    antigravity: [
      [join(locations.antigravity, "mcp_config.json"), (old) => jsonMcpConfig(old, registration(entry, "antigravity"), "antigravity")],
      [join(locations.antigravity, "hooks.json"), (old) => agyHooks(old, entry)],
      [join(locations.antigravity, "skills", "agent-pair", "SKILL.md"), () => skill],
    ],
    claude: [
      [locations.claudeMcp, (old) => jsonMcpConfig(old, registration(entry, "claude"), "claude")],
      [join(locations.claude, "settings.json"), (old) => sessionHooks(old, entry, "claude")],
      [join(locations.claude, "skills", "agent-pair", "SKILL.md"), () => skill],
    ],
  };
  return profiles.flatMap((profile) => files[profile]).map(([path, prepare]) => {
    const original = read(path);
    return { path, original, content: prepare(original) };
  });
}

function replaceFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.agent-pair-${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function applySetup(plan: Edit[]): void {
  const changed = plan.filter((edit) => edit.content !== edit.original);
  const applied: Edit[] = [];
  try {
    for (const edit of changed) {
      if (read(edit.path) !== edit.original) throw new Error(`Config changed while setup was running: ${edit.path}`);
      if (edit.original !== undefined) {
        writeFileSync(`${edit.path}.agent-pair-${randomUUID()}.bak`, edit.original, { flag: "wx", mode: 0o600 });
      }
      replaceFile(edit.path, edit.content);
      applied.push(edit);
    }
  } catch (error) {
    const rollbackFailures = [];
    for (const edit of applied.reverse()) {
      try {
        if (read(edit.path) !== edit.content) throw new Error("Changed during setup");
        if (edit.original === undefined) rmSync(edit.path, { force: true });
        else replaceFile(edit.path, edit.original);
      } catch {
        rollbackFailures.push(edit.path);
      }
    }
    if (rollbackFailures.length) {
      throw new Error(`Setup stopped. Review the backups for: ${rollbackFailures.join(", ")}`, { cause: error });
    }
    throw error;
  }
}
