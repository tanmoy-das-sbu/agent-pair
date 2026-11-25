import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export type WorkerTree = { member: string; path: string; branch: string };

function git(workspace: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: workspace, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const detail = (error as { stderr?: Buffer }).stderr?.toString().trim();
    throw new Error(`Git ${args[0]} failed${detail ? `: ${detail}` : "."}`);
  }
}

export function createWorktrees(workspace: string, directory: string, runId: string, members: string[]): WorkerTree[] {
  const root = join(directory, "worktrees", runId);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const trees: WorkerTree[] = [];
  try {
    for (const member of members) {
      const tree = { member, path: join(root, member), branch: `agent-pair/${runId}/${member}` };
      git(workspace, ["worktree", "add", "-b", tree.branch, tree.path, "HEAD"]);
      trees.push(tree);
    }
    return trees;
  } catch (error) {
    for (const tree of trees.reverse()) {
      try { git(workspace, ["worktree", "remove", tree.path]); git(workspace, ["branch", "-d", tree.branch]); } catch { /* Preserve anything that cannot safely be removed. */ }
    }
    throw error;
  }
}

export function mergeWorktree(workspace: string, tree: WorkerTree): void {
  if (git(tree.path, ["status", "--porcelain", "--untracked-files=all"]).trim()) {
    throw new Error(`Commit or remove changes in ${tree.path} before merging.`);
  }
  git(workspace, ["merge", "--no-edit", tree.branch]);
}

export function cleanupWorktrees(workspace: string, trees: WorkerTree[]): void {
  for (const tree of trees) {
    git(workspace, ["merge-base", "--is-ancestor", tree.branch, "HEAD"]);
    if (git(tree.path, ["status", "--porcelain", "--untracked-files=all"]).trim()) throw new Error(`Worktree has uncommitted changes: ${tree.path}`);
  }
  for (const tree of trees) {
    // Git refuses dirty worktrees and unmerged branches; never force removal.
    git(workspace, ["worktree", "remove", tree.path]);
    git(workspace, ["branch", "-d", tree.branch]);
  }
}
