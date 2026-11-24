import { posix } from "node:path";
import { type Assignment, type Request, type Role } from "./types.js";

export const leader = "orchestrator";
type Update = Extract<Request, { action: "teamUpdate" }>;
type TaskState = "pending" | "active" | "blocked" | "ready" | "accepted";
type Task = Assignment & {
  dependsOn: string[];
  state: TaskState;
  note?: string;
  evidence?: string[];
};
type Member = { profile: Role; sessionId?: string };

function ownedPath(value: string): string {
  const forward = value.replaceAll("\\", "/");
  if (forward.startsWith("/") || /[<>:"*?|\x00-\x1f]/.test(forward)
    || forward.split("/").some((part) => part === ".." || (part !== "." && /[ .]$/.test(part)))) {
    throw new Error(`Use a workspace-relative file or directory path: ${value}`);
  }
  return posix.normalize(forward).replace(/\/$/, "");
}

function includesPath(parent: string, child: string): boolean {
  return parent === "." || parent === child || child.startsWith(parent + "/");
}

export class Team {
  readonly members = new Map<string, Member>();
  readonly tasks = new Map<string, Task>();

  readonly workerCount: number;
  readonly allowedProfiles: Role[];

  constructor(role: Role, sessionId: string | undefined, assignments: Assignment[], workerCount: number, allowedProfiles: Role[]) {
    this.workerCount = workerCount;
    this.allowedProfiles = [...new Set(allowedProfiles)];
    this.members.set(leader, { profile: role, sessionId });
    const owned: { owner: string; path: string }[] = [];
    for (const assignment of assignments) {
      const { id, owner, profile } = assignment;
      if (this.tasks.has(id)) throw new Error(`Duplicate task ID: ${id}`);
      const member = this.members.get(owner);
      if (member && member.profile !== profile) throw new Error(`Conflicting profiles for ${owner}.`);
      if (!member) this.members.set(owner, { profile });
      const paths = [...new Set(assignment.paths.map(ownedPath))];
      for (const path of paths) {
        const key = process.platform === "win32" ? path.toLowerCase() : path;
        const collision = owned.find((previous) => previous.owner !== owner
          && (includesPath(previous.path, key) || includesPath(key, previous.path)));
        if (collision) throw new Error(`File boundary overlap: ${owner} owns ${path} and ${collision.owner} owns ${collision.path}.`);
        owned.push({ owner, path: key });
      }
      this.tasks.set(id, { ...assignment, paths, dependsOn: [...new Set(assignment.dependsOn)], state: "pending" });
    }
    if (this.members.size < 2 || !assignments.some((task) => task.owner === leader)) {
      throw new Error("Assign work to the orchestrator and at least one worker.");
    }
    if (this.members.size - 1 !== workerCount) throw new Error("Create exactly one worker owner for each expected worker session.");
    if ([...this.members].some(([id, slot]) => id !== leader && !this.allowedProfiles.includes(slot.profile))) {
      throw new Error("Every assignment must use a client profile selected for this run.");
    }
    const settled = new Set<string>();
    const visit = (id: string, ancestors: Set<string>) => {
      if (settled.has(id)) return;
      if (ancestors.has(id)) throw new Error(`Circular task dependency involving ${id}.`);
      const task = this.tasks.get(id);
      if (!task) throw new Error(`Unknown task dependency: ${id}`);
      const lineage = new Set([...ancestors, id]);
      for (const dependency of task.dependsOn) visit(dependency, lineage);
      settled.add(id);
    };
    for (const id of this.tasks.keys()) visit(id, new Set());
  }

  update(member: string, { taskId, transition, note, checks }: Update): Task {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    const review = transition === "accept" || transition === "revise";
    if (member !== (review ? leader : task.owner)) {
      throw new Error(review ? "Only the orchestrator can review task handoffs." : "Only the assigned owner can update this task.");
    }
    if ((transition === "block" || transition === "revise") && !note) {
      throw new Error("Include a note explaining the blocker or requested revision.");
    }
    if (transition === "handoff" && (!note || !checks?.length)) {
      throw new Error("Include a handoff summary and the results of your checks.");
    }
    const states: Record<Update["transition"], { from: TaskState[]; to: TaskState }> = {
      start: { from: ["pending", "blocked"], to: "active" },
      block: { from: ["active"], to: "blocked" },
      handoff: { from: ["active"], to: "ready" },
      accept: { from: ["ready"], to: "accepted" },
      revise: { from: ["ready"], to: "pending" },
    };
    const { from, to } = states[transition];
    if (task.state === to && (note === undefined || task.note === note)
      && (checks === undefined || JSON.stringify(task.evidence) === JSON.stringify(checks))) return task;
    if (!from.includes(task.state)) throw new Error(`Cannot ${transition} a task in state ${task.state}.`);
    if (transition === "start") {
      const pending = task.dependsOn.filter((id) => this.tasks.get(id)?.state !== "accepted");
      if (pending.length) throw new Error(`Waiting for accepted tasks: ${pending.join(", ")}.`);
    }
    task.state = to;
    if (note !== undefined || to !== "accepted") task.note = note;
    if (to !== "accepted") task.evidence = transition === "handoff" ? checks : undefined;
    return task;
  }
}
