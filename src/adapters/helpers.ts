import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { dataDirectory, findWindowsExecutable } from "../workspace.js";
import type { AdapterRegistration, AdapterSetupEdit } from "./types.js";

export const serverName = "agent_pair";
export type JsonObject = Record<string, unknown>;

export function registrationFor(entry: string, profile: string, dataDir = dataDirectory()): AdapterRegistration {
  return {
    command: process.execPath,
    args: [entry, "serve", "--profile", profile],
    env: { AGENT_PAIR_DATA_DIR: dataDir },
  };
}

export function resolveConfigHome(): string {
  const home = process.env.AGENT_PAIR_CONFIG_HOME ?? homedir();
  if (!isAbsolute(home)) throw new Error("The configuration home must be an absolute path.");
  return home;
}

export function asJsonObject(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a configuration object.`);
  }
  return value as JsonObject;
}

export function parseJsonConfig(source: string | undefined, label: string): JsonObject {
  const text = source?.replace(/^\uFEFF/, "").trim();
  if (!text) return {};
  try {
    return asJsonObject(JSON.parse(text), label);
  } catch (error) {
    throw new Error(`Could not read ${label} as a JSON object.`, { cause: error });
  }
}

export function serializeJson(value: JsonObject): string {
  return JSON.stringify(value, null, 2) + "\n";
}

export function shellArgument(value: string): string {
  if (process.platform !== "win32") return "'" + value.replaceAll("'", "'\\''") + "'";
  if (/["%!\r\n]/.test(value)) throw new Error("Move the package to a path compatible with Windows hook commands.");
  return '"' + value + '"';
}

export function hookHandler(entry: string, profile: string, useArgsArray = false): JsonObject {
  if (useArgsArray) {
    return { type: "command", command: process.execPath, args: [entry, "capture-session", "--profile", profile], timeout: 5 };
  }
  const command = `node ${shellArgument(entry)} capture-session --profile ${profile}`;
  return { type: "command", command, timeout: 5 };
}

export function isManagedHook(handler: unknown, profile: string): boolean {
  const hook = handler as JsonObject | null;
  return typeof hook?.command === "string" && (hook.command.endsWith(` capture-session --profile ${profile}`)
    || (Array.isArray(hook.args) && hook.args.slice(1).join(" ") === `capture-session --profile ${profile}`));
}

export function mergeSessionStartHooks(
  source: string | undefined,
  entry: string,
  profile: string,
  useArgsArray = false,
): string {
  const doc = parseJsonConfig(source, `${profile} hook configuration`);
  const hooks = asJsonObject(doc.hooks ?? {}, `${profile} hooks`);
  const current = hooks.SessionStart ?? [];
  if (!Array.isArray(current)) throw new Error(`${profile} SessionStart hooks must be an array.`);
  const retained = current.flatMap((item) => {
    const group = asJsonObject(item, `${profile} hook group`);
    if (!Array.isArray(group.hooks) || !group.hooks.some((handler) => isManagedHook(handler, profile))) {
      return [group];
    }
    const handlers = group.hooks.filter((handler) => !isManagedHook(handler, profile));
    return handlers.length ? [{ ...group, hooks: handlers }] : [];
  });
  retained.push({ hooks: [hookHandler(entry, profile, useArgsArray)] });
  return serializeJson({ ...doc, hooks: { ...hooks, SessionStart: retained } });
}

export function mergeJsonMcpConfig(
  source: string | undefined,
  settings: AdapterRegistration,
  profile: string,
  extraOptions: JsonObject,
): string {
  const doc = parseJsonConfig(source, `${profile} MCP configuration`);
  const servers = asJsonObject(doc.mcpServers ?? {}, `${profile} MCP servers`);
  if (servers[serverName] !== undefined) {
    const existing = asJsonObject(servers[serverName], `${profile} Agent Pair MCP server`);
    const args = existing.args;
    if (!Array.isArray(args) || args.slice(1, 4).join(" ") !== `serve --profile ${profile}`) {
      throw new Error(`${profile} already has an unmanaged agent_pair MCP registration.`);
    }
  }
  return serializeJson({
    ...doc,
    mcpServers: { ...servers, [serverName]: { ...extraOptions, ...settings } },
  });
}

export function buildEdits(
  entries: ReadonlyArray<[string, (original: string | undefined) => string]>,
  readFile: (path: string) => string | undefined,
): AdapterSetupEdit[] {
  return entries.map(([path, prepare]) => {
    const original = readFile(path);
    return { path, original, content: prepare(original) };
  });
}

export function platformCommand(executable: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `${executable}.exe` : executable;
}

export function probeExecutableVersion(executable: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = platform === "win32" ? findWindowsExecutable(`${executable}.exe`) : executable;
  return execFileSync(resolved, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
    windowsHide: true,
  }).trim();
}

export function sessionContextMessage(meta: { role: string; sessionId: string; workspacePaths: string[] }): string {
  return "Agent Pair metadata for this conversation only. Use it if the user invokes Agent Pair. "
    + JSON.stringify(meta);
}
