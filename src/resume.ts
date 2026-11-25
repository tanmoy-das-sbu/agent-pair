import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { getBookmark } from "./bookmarks.js";
import { dataDirectory, findWindowsExecutable } from "./workspace.js";
import { getAdapter } from "./adapters/index.js";

export type ResumePlan = { workspace: string; command: string; args: string[]; executableIndices?: number[]; commands?: { member: string; command: string; args: string[] }[] };

export function resumePlan(tag: string, platform: NodeJS.Platform = process.platform): ResumePlan {
  const bookmark = getBookmark(dataDirectory(), tag);
  if (!statSync(bookmark.workspace, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`The workspace for ${bookmark.tag} is missing: ${bookmark.workspace}`);
  }
  if (platform !== "win32") {
    return {
      workspace: bookmark.workspace,
      command: "",
      args: [],
      commands: bookmark.sessions.map((slot) => {
        const spec = getAdapter(slot.profile).resume(slot.sessionId, bookmark.workspace, platform);
        return { member: slot.member, command: spec.command, args: spec.args };
      }),
    };
  }
  const workspaceArg = bookmark.workspace.replaceAll(";", "\\;");
  const args = ["--window", "-1"];
  const executableIndices: number[] = [];
  for (const [index, slot] of bookmark.sessions.entries()) {
    if (index) args.push(";");
    const adapter = getAdapter(slot.profile);
    const spec = adapter.resume(slot.sessionId, bookmark.workspace, platform);
    const title = slot.member === slot.profile ? adapter.displayName : `${slot.member} (${adapter.displayName})`;
    args.push("new-tab", "--startingDirectory", workspaceArg, "--title", title);
    executableIndices.push(args.length);
    args.push(spec.command, ...spec.args);
  }
  return {
    workspace: bookmark.workspace,
    command: "wt.exe",
    args,
    executableIndices,
  };
}

export async function launchResume(plan: ReturnType<typeof resumePlan>, options: { tmux?: boolean } = {}): Promise<void> {
  if (plan.commands) {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    if (options.tmux) {
      const name = `agent-pair-${randomBytes(5).toString("hex")}`;
      const command = (slot: NonNullable<ResumePlan["commands"]>[number]) =>
        `cd ${quote(plan.workspace)} && ${[slot.command, ...slot.args].map(quote).join(" ")}`;
      const run = (args: string[]) => {
        const result = spawnSync("tmux", args, { encoding: "utf8" });
        if (result.error || result.status !== 0) throw new Error(`Could not launch tmux: ${result.error?.message ?? result.stderr.trim()}`);
      };
      let created = false;
      try {
        for (const [index, slot] of plan.commands.entries()) {
          run(index === 0 ? ["new-session", "-d", "-s", name, command(slot)] : ["split-window", "-t", name, command(slot)]);
          created = true;
        }
        run(["select-layout", "-t", name, "tiled"]);
      } catch (error) {
        if (created) spawnSync("tmux", ["kill-session", "-t", name], { stdio: "ignore" });
        throw error;
      }
      process.stdout.write(`Attach with: tmux attach-session -t ${name}\n`);
      return;
    }
    for (const slot of plan.commands) {
      process.stdout.write(`${slot.member}: cd ${quote(plan.workspace)} && ${[slot.command, ...slot.args].map(quote).join(" ")}\n`);
    }
    return;
  }
  const command = findWindowsExecutable(plan.command);
  const programs = new Map<string, string>();
  const args = [...plan.args];
  for (const index of plan.executableIndices ?? []) {
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
