import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";

export function pathKey(path: string): string {
  const normalized = normalize(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function findWindowsExecutable(name: string): string {
  const where = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe");
  try {
    const output = execFileSync(where, [`$PATH:${name}`], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 3000,
    });
    const executable = output.split(/\r?\n/).map((line) => line.trim()).find(isAbsolute);
    if (executable) return executable;
  } catch {
    // A missing executable and a failed lookup are both actionable as a PATH check.
  }
  throw new Error(`Could not find ${name} on PATH.`);
}

export function workspaceRoot(directory: string): string {
  if (!isAbsolute(directory)) throw new Error("Use the absolute path of the current workspace.");
  const workspace = realpathSync(directory);
  if (!statSync(workspace).isDirectory()) throw new Error("The workspace path must be a directory.");

  // Git returns the current worktree root, so separate worktrees pair independently.
  const options = { cwd: workspace, encoding: "utf8" as const, timeout: 3000, windowsHide: true };
  let root: string;
  try {
    const git = process.platform === "win32" ? findWindowsExecutable("git.exe") : "git";
    root = execFileSync(git, ["rev-parse", "--show-toplevel"], {
      ...options,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return workspace;
  }
  return realpathSync(root);
}

export function dataDirectory(): string {
  const override = process.env.AGENT_PAIR_DATA_DIR;
  if (override) {
    if (!isAbsolute(override)) throw new Error("AGENT_PAIR_DATA_DIR must be an absolute path.");
    return normalize(override);
  }
  return process.platform === "win32"
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "AgentPair")
    : join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "agent-pair");
}
