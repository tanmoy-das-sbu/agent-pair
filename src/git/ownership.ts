import { execFileSync } from "node:child_process";

function git(workspace: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: workspace, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    throw new Error("Ownership enforcement requires a Git workspace with a base commit.");
  }
}

export function baseCommit(workspace: string): string {
  return git(workspace, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
}

/** Include both sides of renames, staged and unstaged changes, and untracked files. */
export function changedPaths(workspace: string, base: string): string[] {
  const tracked = git(workspace, ["diff", "--no-renames", "--name-only", "-z", base, "--"]);
  // The index and working tree can cancel each other in the combined diff.
  const staged = git(workspace, ["diff", "--cached", "--no-renames", "--name-only", "-z", base, "--"]);
  const unstaged = git(workspace, ["diff", "--no-renames", "--name-only", "-z", "--"]);
  const untracked = git(workspace, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return [...new Set((tracked + staged + unstaged + untracked).split("\0").filter(Boolean))].sort();
}

export function violations(files: string[], owned: string[]): string[] {
  const normalize = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
  return files.filter((file) => !owned.some((path) => {
    const parent = normalize(path);
    const child = normalize(file);
    return parent === "." || parent === child || child.startsWith(parent + "/");
  }));
}
