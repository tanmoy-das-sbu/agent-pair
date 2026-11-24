import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { getBookmark } from "./bookmarks.js";
import { dataDirectory, findWindowsExecutable } from "./workspace.js";

const clients = {
  codex: { title: "Codex", command: "codex.exe", resume: "resume" },
  antigravity: { title: "Antigravity", command: "agy.exe", resume: "--conversation" },
  claude: { title: "Claude Code", command: "claude.exe", resume: "--resume" },
};

export function resumePlan(tag: string): { workspace: string; command: string; args: string[] } {
  const bookmark = getBookmark(dataDirectory(), tag);
  if (!statSync(bookmark.workspace, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`The workspace for ${bookmark.tag} is missing: ${bookmark.workspace}`);
  }
  const workspaceArg = bookmark.workspace.replaceAll(";", "\\;");
  const args = ["--window", "-1"];
  for (const [index, slot] of bookmark.sessions.entries()) {
    if (index) args.push(";");
    const client = clients[slot.profile];
    const title = slot.member === slot.profile ? client.title : `${slot.member} (${client.title})`;
    args.push("new-tab", "--startingDirectory", workspaceArg, "--title", title,
      client.command, client.resume, slot.sessionId);
  }
  return {
    workspace: bookmark.workspace,
    command: "wt.exe",
    args,
  };
}

export async function launchResume(plan: ReturnType<typeof resumePlan>): Promise<void> {
  if (process.platform !== "win32") throw new Error("The resume launcher requires Windows Terminal.");
  const command = findWindowsExecutable(plan.command);
  const programs = new Map<string, string>();
  const args = [...plan.args];
  for (let index = 7; index < args.length; index += 9) {
    const executable = args[index];
    if (!programs.has(executable)) programs.set(executable, findWindowsExecutable(executable));
    args[index] = programs.get(executable)!;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: plan.workspace, stdio: "ignore", detached: true,
    });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}
