import { randomBytes, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { saveBookmark, saveSessions } from "./bookmarks.js";
import { leader, Team } from "./team.js";
import { otherRole, roles, type PairRole, type Request, type Role, type TeamSetupInput } from "./types.js";
import { pathKey, workspaceRoot } from "./workspace.js";
import { baseCommit, changedPaths, violations } from "./git/ownership.js";
import { cleanupWorktrees, createWorktrees, mergeWorktree, type WorkerTree } from "./git/worktrees.js";
import { loadRuns, removeRun, saveRun } from "./core/persistence.js";

export type AgentActivityState =
  | "waiting"
  | "working"
  | "blocked"
  | "review"
  | "done"
  | "idle"
  | "disconnected";

export type DashboardMember = {
  member: string;
  profile: Role;
  isOrchestrator: boolean;
  connected: boolean;
  claimed: boolean;
  hasSessionId: boolean;
  status: AgentActivityState;
  currentTaskId?: string;
  currentTaskTitle?: string;
  unread: number;
  lastActivityAt?: number;
};

export type DashboardTask = {
  id: string;
  owner: string;
  profile: Role;
  title: string;
  paths: string[];
  checks: string[];
  dependsOn: string[];
  state: "pending" | "active" | "blocked" | "stalled" | "ready" | "accepted";
  note?: string;
  evidence?: string[];
};

export type DashboardMessage = {
  id: number;
  taskId: string;
  kind: string;
  body: string;
  from: string;
  to: string;
  replyTo?: number;
  checks?: string[];
  createdAt: string;
  acknowledged: boolean;
};

export type RunEvent = { id: number; timestamp: number; runId: string; type: string; member?: string; taskId?: string; data?: Record<string, unknown> };

export type DashboardRun = {
  id: string;
  mode: "team" | "pair";
  workspace: string;
  workspaceName: string;
  tag?: string;
  bookmarkError?: string;
  missingSessionIds: string[];
  waitingFor: number;
  createdAt: number;
  expiresAt: number;
  members: DashboardMember[];
  tasks: DashboardTask[];
  messages: DashboardMessage[];
  events: RunEvent[];
  ownershipEvents?: { type: "ownership.violation"; taskId: string; files: string[]; at: number }[];
};

export type DashboardSnapshot = {
  now: number;
  runs: DashboardRun[];
  pendingPairs: { workspace: string; workspaceName: string; role: PairRole }[];
  setups: TeamSetup[];
};

type TeamSetup = TeamSetupInput & { id: string; expiresAt: number };

type ConnectionRequest = Extract<Request, { action: "connect" }>;
type Send = Extract<Request, { action: "send" }>;
type Message = Omit<Send, "action" | "handle" | "role" | "requestId"> & {
  id: number;
  from: string;
  to: string;
  createdAt: string;
};
type ConnectResult = {
  runId: string;
  handle: string;
  workspace: string;
  role: Role;
  tag?: string;
  bookmarkError?: string;
};
type Waiting = { workspace: string; role: PairRole; sessionId?: string; resolve: (result: ConnectResult) => void };
type Run = {
  id: string;
  workspace: string;
  handles: Map<string, string>;
  claimed: Set<string>;
  lastActivity: Map<string, number>;
  team?: Team;
  tag?: string;
  bookmarkError?: string;
  messages: Message[];
  requests: Map<string, { message: Message; fingerprint: string }>;
  acknowledged: Set<number>;
  listeners: Set<() => void>;
  createdAt: number;
  expires: number;
  enforcement?: "strict" | "warn" | "off";
  taskBases?: Map<string, string>;
  ownershipEvents?: { type: "ownership.violation"; taskId: string; files: string[]; at: number }[];
  events: RunEvent[];
  worktrees?: WorkerTree[];
  persist?: boolean;
  stallTimeoutMs?: number;
};

type SavedRun = Omit<Run, "team" | "handles" | "claimed" | "lastActivity" | "requests" | "acknowledged" | "listeners" | "taskBases"> & {
  handles: [string, string][]; claimed: string[]; lastActivity: [string, number][];
  requests: [string, { message: Message; fingerprint: string }][]; acknowledged: number[]; taskBases: [string, string][];
  team: { tasks: DashboardTask[]; members: [string, { profile: Role; sessionId?: string }][]; workerCount: number; allowedProfiles: Role[] };
};

function waitForChange(listeners: Set<() => void>, milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      listeners.delete(finish);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
    listeners.add(finish);
  });
}

export class Relay {
  private readonly runs = new Map<string, Run>();
  private readonly handles = new Map<string, { role: Role; member: string; run: Run }>();
  private readonly pending = new Map<string, Waiting>();
  private readonly observers = new Set<() => void>();
  private readonly setups = new Map<string, TeamSetup>();
  private readonly lifetime = 30 * 60 * 1000;

  constructor(private readonly directory: string, private readonly now: () => number = Date.now) {
    for (const raw of loadRuns(directory)) {
      const saved = raw as SavedRun;
      const lead = saved.team.members.find(([member]) => member === leader)?.[1];
      if (!lead) throw new Error("Persisted team is missing its orchestrator.");
      const assignments = [...saved.team.tasks];
      const temporaryIds: string[] = [];
      for (const [id, slot] of saved.team.members) {
        if (assignments.some((task) => task.owner === id)) continue;
        let temporary = `restore-${id}`;
        while (assignments.some((task) => task.id === temporary)) temporary += "x";
        temporaryIds.push(temporary);
        assignments.push({ id: temporary, owner: id, profile: slot.profile, title: "restore", paths: [], checks: ["restore"], dependsOn: [], state: "pending" });
      }
      const team = new Team(lead.profile, lead.sessionId, assignments, saved.team.workerCount, saved.team.allowedProfiles);
      for (const id of temporaryIds) team.tasks.delete(id);
      for (const [id, member] of saved.team.members) team.members.set(id, member);
      for (const task of saved.team.tasks) Object.assign(team.tasks.get(task.id)!, task);
      const run: Run = { ...saved, team, handles: new Map(saved.handles), claimed: new Set(saved.claimed), lastActivity: new Map(saved.lastActivity), requests: new Map(saved.requests), acknowledged: new Set(saved.acknowledged), listeners: new Set(), taskBases: new Map(saved.taskBases) };
      this.runs.set(run.id, run);
      for (const [member, handle] of run.handles) this.handles.set(handle, { member, role: team.members.get(member)!.profile, run });
    }
  }

  subscribe(listener: () => void): () => void {
    this.observers.add(listener);
    return () => { this.observers.delete(listener); };
  }

  private notifyObservers(): void {
    for (const run of this.runs.values()) if (run.persist && run.team) {
      saveRun(this.directory, run.id, { ...run, team: { tasks: [...run.team.tasks.values()], members: [...run.team.members], workerCount: run.team.workerCount, allowedProfiles: run.team.allowedProfiles }, handles: [...run.handles], claimed: [...run.claimed], lastActivity: [...run.lastActivity], requests: [...run.requests], acknowledged: [...run.acknowledged], listeners: undefined, taskBases: [...(run.taskBases ?? [])] });
    }
    for (const observer of this.observers) observer();
  }

  snapshot(): DashboardSnapshot {
    this.sweep();
    const runs: DashboardRun[] = [...this.runs.values()].map((run) => {
      const workspaceName = basename(run.workspace) || run.workspace;
      const messages: DashboardMessage[] = run.messages.map((message) => ({
        id: message.id,
        taskId: message.taskId,
        kind: message.kind,
        body: message.body,
        from: message.from,
        to: message.to,
        replyTo: message.replyTo,
        checks: message.checks,
        createdAt: message.createdAt,
        acknowledged: run.acknowledged.has(message.id),
      }));
      if (run.team) {
        const tasks: DashboardTask[] = [...run.team.tasks.values()].map((task) => ({
          id: task.id,
          owner: task.owner,
          profile: task.profile,
          title: task.title,
          paths: task.paths,
          checks: task.checks,
          dependsOn: task.dependsOn,
          state: task.state,
          note: task.note,
          evidence: task.evidence,
        }));
        const missingSessionIds = [...run.team.members]
          .filter(([id, slot]) => run.claimed.has(id) && !slot.sessionId)
          .map(([id]) => id);
        const members: DashboardMember[] = [...run.team.members].map(([id, slot]) => {
          const connected = run.handles.has(id);
          const claimed = run.claimed.has(id);
          const owned = tasks.filter((task) => task.owner === id);
          const active = owned.find((task) => task.state === "active");
          const blocked = owned.find((task) => task.state === "blocked" || task.state === "stalled");
          const ready = owned.find((task) => task.state === "ready");
          const allAccepted = owned.length > 0 && owned.every((task) => task.state === "accepted");
          let status: AgentActivityState;
          if (!claimed) status = "waiting";
          else if (allAccepted) status = "done";
          else if (!connected) status = "disconnected";
          else if (active) status = "working";
          else if (blocked) status = "blocked";
          else if (ready) status = "review";
          else status = "idle";
          const focus = active ?? blocked ?? ready ?? owned.find((task) => task.state === "pending");
          return {
            member: id,
            profile: slot.profile,
            isOrchestrator: id === leader,
            connected,
            claimed,
            hasSessionId: Boolean(slot.sessionId),
            status,
            currentTaskId: focus?.id,
            currentTaskTitle: focus?.title,
            unread: this.unread(run, id).length,
            lastActivityAt: run.lastActivity.get(id),
          };
        });
        return {
          id: run.id,
          mode: "team",
          workspace: run.workspace,
          workspaceName,
          tag: run.tag,
          bookmarkError: run.bookmarkError,
          missingSessionIds,
          waitingFor: [...run.team.members.keys()].filter((id) => !run.claimed.has(id)).length,
          createdAt: run.createdAt,
          expiresAt: run.expires,
          members,
          tasks,
          messages,
          events: run.events,
          ownershipEvents: run.ownershipEvents,
        };
      }
      const members: DashboardMember[] = (["codex", "antigravity"] as const).map((role) => {
        const connected = run.handles.has(role);
        return {
          member: role,
          profile: role,
          isOrchestrator: role === "codex",
          connected,
          claimed: run.claimed.has(role),
          hasSessionId: Boolean(run.tag),
          status: connected ? "working" : "disconnected",
          unread: this.unread(run, role).length,
          lastActivityAt: run.lastActivity.get(role),
        };
      });
      return {
        id: run.id,
        mode: "pair",
        workspace: run.workspace,
        workspaceName,
        tag: run.tag,
        bookmarkError: run.bookmarkError,
        missingSessionIds: [],
        waitingFor: 0,
        createdAt: run.createdAt,
        expiresAt: run.expires,
        members,
        tasks: [],
        messages,
        events: run.events,
      };
    });
    const pendingPairs = [...this.pending.values()].map((entry) => ({
      workspace: entry.workspace,
      workspaceName: basename(entry.workspace) || entry.workspace,
      role: entry.role,
    }));
    return { now: this.now(), runs, pendingPairs, setups: [...this.setups.values()] };
  }

  sweep(): void {
    let setupExpired = false;
    for (const [key, setup] of this.setups) {
      if (setup.expiresAt > this.now()) continue;
      this.setups.delete(key);
      setupExpired = true;
    }
    if (setupExpired) this.notifyObservers();
    for (const run of this.runs.values()) {
      if (run.team && run.stallTimeoutMs) {
        let changed = false;
        for (const task of run.team.tasks.values()) {
          if (task.state === "active" && this.now() - (run.lastActivity.get(task.owner) ?? run.createdAt) >= run.stallTimeoutMs) {
            task.state = "stalled";
            this.event(run, "task.stalled", task.owner, task.id, { state: "stalled" });
            changed = true;
          }
        }
        if (changed) this.notifyObservers();
      }
      if (run.expires <= this.now()) {
        try { this.close(run.id); }
        catch {
          // Preserve dirty or unmerged worktrees and keep the relay usable for recovery.
          run.expires = this.now() + this.lifetime;
        }
      }
    }
  }

  get idle(): boolean {
    return this.runs.size === 0 && this.pending.size === 0 && this.setups.size === 0;
  }

  saveTeamSetup(input: TeamSetupInput): TeamSetup {
    const workspace = workspaceRoot(input.workspace);
    const key = pathKey(workspace);
    this.sweep();
    if ([...this.runs.values()].some((run) => run.team && pathKey(run.workspace) === key)) {
      throw new Error("Close the active team in this workspace before setting up another.");
    }
    const setup = { ...input, workspace, id: randomUUID(), expiresAt: this.now() + this.lifetime };
    this.setups.set(key, setup);
    this.notifyObservers();
    return setup;
  }

  cancelTeamSetup(id: string): boolean {
    for (const [key, setup] of this.setups) {
      if (setup.id !== id) continue;
      this.setups.delete(key);
      this.notifyObservers();
      return true;
    }
    return false;
  }

  async execute(request: Request, signal: AbortSignal): Promise<unknown> {
    this.sweep();
    if (request.action === "ping") return { available: true };
    if (request.action === "dashboard") return this.snapshot();
    if (request.action === "close") return this.close(request.runId);
    if (request.action === "connect") return this.connect(request, signal);
    if (request.action === "teamSetup") {
      const workspace = workspaceRoot(request.workspace);
      return { currentProfile: request.role, setup: this.setups.get(pathKey(workspace)) ?? null };
    }
    if (request.action === "teamStart") return this.startTeam(request);
    if (request.action === "teamJoin") return this.joinTeam(request);

    const session = this.handles.get(request.handle);
    if (session?.role !== request.role) throw new Error("This pairing has ended or the handle belongs to another session.");
    const { run, member } = session;
    run.expires = this.now() + this.lifetime;
    run.lastActivity.set(member, this.now());

    switch (request.action) {
      case "send":
        return this.send(run, member, request);
      case "teamUpdate": {
        if (!run.team) throw new Error("Task transitions are available in team runs.");
        const task = run.team.tasks.get(request.taskId);
        const taskWorkspace = run.worktrees?.find((tree) => tree.member === task?.owner)?.path ?? run.workspace;
        if (request.transition === "start" && task?.owner === member && ["pending", "blocked", "stalled"].includes(task.state)
          && task.dependsOn.every((id) => run.team!.tasks.get(id)?.state === "accepted")
          && !run.taskBases!.has(task.id) && run.enforcement !== "off") {
          try { run.taskBases!.set(task.id, baseCommit(taskWorkspace)); }
          catch (error) { if (run.enforcement === "strict") throw error; }
        }
        if (request.transition === "handoff" && task?.owner === member && task.state === "active"
          && request.note && request.checks?.length && run.enforcement !== "off") {
          let files: string[];
          try {
            const base = run.taskBases!.get(task.id);
            if (!base) throw new Error("Ownership enforcement requires a Git workspace with a base commit.");
            files = violations(changedPaths(taskWorkspace, base), task.paths);
          } catch (error) {
            if (run.enforcement === "strict") throw error;
            files = ["<unable to inspect Git changes>"];
          }
          if (files.length) {
            run.ownershipEvents!.push({ type: "ownership.violation", taskId: task.id, files, at: this.now() });
            this.event(run, "ownership.violation", member, task.id, { files, mode: run.enforcement, rejected: run.enforcement === "strict" });
            this.notifyObservers();
            if (run.enforcement === "strict") throw new Error(`Ownership violation; changed paths outside task boundary: ${files.join(", ")}`);
          }
        }
        const previousState = task?.state;
        const updated = run.team.update(member, request);
        if (previousState !== updated.state) {
          const types = { start: "task.started", block: "task.blocked", handoff: "task.handoff", accept: "task.accepted", revise: "task.revised" };
          this.event(run, types[request.transition], member, updated.id, { state: updated.state, note: updated.note, checks: updated.evidence });
        }
        this.notifyObservers();
        return updated;
      }
      case "heartbeat":
        this.notifyObservers();
        return { at: run.lastActivity.get(member) };
      case "teamReassign": {
        if (member !== leader || !run.team) throw new Error("Only the orchestrator can reassign tasks.");
        if (run.worktrees) throw new Error("Reassignment of isolated worktrees requires manual recovery.");
        const task = run.team.tasks.get(request.taskId);
        const target = run.team.members.get(request.member);
        if (!task || task.state !== "stalled" || !target || !run.handles.has(request.member)) throw new Error("Select a stalled task and connected team member.");
        const overlaps = (a: string, b: string) => a === "." || b === "." || a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
        if ([...run.team.tasks.values()].some((other) => other !== task && other.owner !== request.member
          && task.paths.some((a) => other.paths.some((b) => overlaps(process.platform === "win32" ? a.toLowerCase() : a, process.platform === "win32" ? b.toLowerCase() : b))))) {
          throw new Error("Reassignment would overlap another owner's paths.");
        }
        task.owner = request.member;
        task.profile = target.profile;
        task.state = "pending";
        this.event(run, "task.reassigned", member, task.id, { owner: request.member, state: task.state });
        this.notifyObservers();
        return task;
      }
      case "teamMerge": {
        if (member !== leader || !run.team) throw new Error("Only the orchestrator can merge worker worktrees.");
        const tree = run.worktrees?.find((entry) => entry.member === request.member);
        if (!tree) throw new Error("No worktree for this member.");
        if ([...run.team.tasks.values()].some((task) => task.owner === request.member && task.state !== "accepted")) {
          throw new Error("All worker tasks must be accepted before merge.");
        }
        mergeWorktree(run.workspace, tree);
        this.event(run, "worktree.merged", member, undefined, { worker: request.member, branch: tree.branch });
        this.notifyObservers();
        return { merged: request.member, branch: tree.branch };
      }
      case "inbox": {
        const deadline = Date.now() + request.waitMs;
        let unread = this.unread(run, member, request.taskId);
        while (!unread.length && Date.now() < deadline && !signal.aborted) {
          await waitForChange(run.listeners, deadline - Date.now(), signal);
          if (!this.handles.has(request.handle)) throw new Error("This pairing has ended or this member disconnected.");
          unread = this.unread(run, member, request.taskId);
        }
        return { messages: unread.slice(0, request.limit) };
      }
      case "ack": {
        const ids = [...new Set(request.ids)];
        if (ids.some((id) => run.messages[id - 1]?.to !== member)) {
          throw new Error("You can acknowledge only messages sent to this session.");
        }
        for (const id of ids) {
          if (!run.acknowledged.has(id)) this.event(run, "message.acked", member, run.messages[id - 1]?.taskId, { messageId: id });
          run.acknowledged.add(id);
        }
        this.notifyObservers();
        return { acknowledged: ids };
      }
      case "status": {
        if (run.team) {
          const deadline = Date.now() + request.waitMs;
          while (member === leader && run.claimed.size < run.team.members.size && Date.now() < deadline && !signal.aborted) {
            await waitForChange(run.listeners, deadline - Date.now(), signal);
            if (!this.runs.has(run.id)) throw new Error("This team has ended.");
          }
          return this.teamStatus(run, member, request.taskId);
        }
        const messages = request.taskId ? run.messages.filter((message) => message.taskId === request.taskId) : run.messages;
        const assignment = messages.findLast((message) => message.kind === "assignment");
        const handoff = messages.findLast((message) => message.kind === "handoff" || message.kind === "blocker");
        const next = messages.findLast((message) => message.nextRole);
        return {
          runId: run.id,
          unread: this.unread(run, member, request.taskId).length,
          assignment, handoff,
          handoffAcknowledged: handoff ? run.acknowledged.has(handoff.id) : null,
          nextRole: next?.nextRole ?? "codex",
        };
      }
      case "disconnect":
        if (run.team && member !== leader) {
          this.event(run, "member.disconnected", member);
          this.handles.delete(request.handle);
          run.handles.delete(member);
          for (const listener of run.listeners) listener();
          this.notifyObservers();
          return { disconnected: true };
        }
        return this.close(run.id);
    }
  }

  private async connect(request: ConnectionRequest, signal: AbortSignal): Promise<ConnectResult> {
    if (signal.aborted) throw new Error("The join request was canceled.");
    const { role } = request;
    if (role === "claude") throw new Error("Use team_start or team_join to connect Claude Code.");
    const workspace = workspaceRoot(request.workspace);
    const key = pathKey(workspace);
    const peer = this.pending.get(key);
    if (peer?.role === request.role) throw new Error("Another session with your role is already waiting in this workspace.");

    if (peer) {
      const run = this.createRun(workspace);
      const handle = this.addMember(run, role, role);
      const peerHandle = this.addMember(run, peer.role, peer.role);
      this.pending.delete(key);

      const result: Omit<ConnectResult, "handle" | "role"> = { runId: run.id, workspace };
      if (request.sessionId && peer.sessionId) {
        const codex = request.role === "codex" ? request.sessionId : peer.sessionId;
        const antigravity = request.role === "antigravity" ? request.sessionId : peer.sessionId;
        try {
          result.tag = saveBookmark(this.directory, workspace, codex, antigravity);
          run.tag = result.tag;
        } catch {
          result.bookmarkError = "The pair connected, but its local bookmark could not be saved.";
          run.bookmarkError = result.bookmarkError;
        }
      }
      this.notifyObservers();
      peer.resolve({ ...result, handle: peerHandle, role: peer.role });
      return { ...result, handle, role };
    }

    return new Promise((resolve, reject) => {
      const release = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        if (this.pending.get(key) === entry) {
          this.pending.delete(key);
          this.notifyObservers();
        }
      };
      const cancel = () => {
        release();
        reject(new Error("The join request was canceled."));
      };
      const timer = setTimeout(() => {
        release();
        reject(new Error(`Still waiting for ${otherRole(role)} in this workspace. Try again while both sessions are open.`));
      }, request.waitMs);
      const entry: Waiting = {
        workspace,
        role,
        sessionId: request.sessionId,
        resolve: (value) => { release(); resolve(value); },
      };
      signal.addEventListener("abort", cancel, { once: true });
      this.pending.set(key, entry);
      this.notifyObservers();
    });
  }

  private createRun(workspace: string, team?: Team): Run {
    const timestamp = this.now();
    const run: Run = {
      id: randomUUID(), workspace, team, handles: new Map(), claimed: new Set(), lastActivity: new Map(),
      messages: [], requests: new Map(),
      acknowledged: new Set(), listeners: new Set(), createdAt: timestamp, expires: timestamp + this.lifetime,
      events: [],
    };
    this.runs.set(run.id, run);
    this.event(run, "run.started");
    return run;
  }

  private addMember(run: Run, member: string, role: Role): string {
    const handle = randomBytes(32).toString("hex");
    run.handles.set(member, handle);
    run.claimed.add(member);
    run.lastActivity.set(member, this.now());
    this.handles.set(handle, { role, member, run });
    this.event(run, "member.joined", member, undefined, { profile: role });
    return handle;
  }

  private startTeam(request: Extract<Request, { action: "teamStart" }>) {
    const workspace = workspaceRoot(request.workspace);
    const key = pathKey(workspace);
    const setup = this.setups.get(key);
    if (setup?.id !== request.setupId) throw new Error("The dashboard setup changed. Call team_setup for the current selection.");
    if (setup && setup.leadProfile !== request.role) throw new Error(`This setup requires a ${setup.leadProfile} orchestrator.`);
    const team = new Team(request.role, request.sessionId, request.assignments, request.workerCount, request.allowedProfiles);
    if (setup) {
      const workerProfiles = [...team.members].flatMap(([id, slot]) => id === leader ? [] : [slot.profile]);
      if (roles.some((role) => workerProfiles.filter((profile) => profile === role).length !== setup.workers[role]
        || team.allowedProfiles.includes(role) !== (setup.workers[role] > 0))) {
        throw new Error("Worker slots and allowed profiles must match the dashboard setup.");
      }
      this.setups.delete(key);
    }
    const run = this.createRun(workspace, team);
    run.enforcement = request.enforce ?? "strict";
    run.taskBases = new Map();
    run.ownershipEvents = [];
    run.persist = request.persist ?? false;
    run.stallTimeoutMs = request.stallTimeoutMs;
    if (request.isolation === "worktree") {
      try { run.worktrees = createWorktrees(workspace, this.directory, run.id, [...team.members.keys()].filter((member) => member !== leader)); }
      catch (error) { this.runs.delete(run.id); throw error; }
    }
    const handle = this.addMember(run, leader, request.role);
    this.notifyObservers();
    return { ...this.teamStatus(run, leader), handle };
  }

  private joinTeam({ runId, workspace, role, sessionId }: Extract<Request, { action: "teamJoin" }>) {
    const root = workspaceRoot(workspace);
    const candidates = [...this.runs.values()].filter((candidate) =>
      candidate.team && pathKey(candidate.workspace) === pathKey(root) && (!runId || candidate.id === runId));
    if (candidates.length !== 1) {
      throw new Error(candidates.length ? "More than one team is active in this workspace. Include the run ID."
        : "No active team is waiting in this workspace on this relay. Make sure every client uses the same Agent Pair installation and AGENT_PAIR_DATA_DIR, then restart the clients after an update. Start the dashboard from a normal terminal before opening the team if sandboxed sessions cannot share the relay.");
    }
    const run = candidates[0];
    const team = run?.team;
    if (!run || !team) throw new Error("This team run is unavailable in the current workspace.");
    if (!team.allowedProfiles.includes(role)) throw new Error("This worker client was not selected for the team.");
    const matching = [...team.members].filter(([, slot]) => slot.profile === role);
    const previous = sessionId ? matching.find(([, slot]) => slot.sessionId?.toLowerCase() === sessionId.toLowerCase()) : undefined;
    if (previous?.[0] === leader) throw new Error("The orchestrator session cannot join as a worker.");
    const member = previous?.[0] ?? matching.find(([id]) => id !== leader && !run.claimed.has(id))?.[0];
    if (!member) throw new Error("No unclaimed worker slot matches this client profile.");
    const slot = team.members.get(member)!;
    const existing = run.handles.get(member);
    if (existing) {
      if (sessionId && slot.sessionId?.toLowerCase() === sessionId.toLowerCase()) return this.joinResult(run, member, existing);
      throw new Error("This team member slot is already connected.");
    }
    const handle = this.addMember(run, member, role);
    slot.sessionId = sessionId;
    for (const listener of run.listeners) listener();
    run.expires = this.now() + this.lifetime;
    const members = [...team.members];
    if (members.every(([, slot]) => slot.sessionId)) {
      try {
        run.tag = saveSessions(this.directory, run.workspace,
          members.map(([id, slot]) => ({ member: id, profile: slot.profile, sessionId: slot.sessionId! })));
        run.bookmarkError = undefined;
      } catch {
        run.bookmarkError = "The team connected, but its local bookmark could not be saved.";
      }
    }
    this.notifyObservers();
    return this.joinResult(run, member, handle);
  }

  private joinResult(run: Run, member: string, handle: string) {
    const { tasks, ...status } = this.teamStatus(run, member);
    return { ...status, tasks: tasks.filter((task) => task.owner === member), handle };
  }

  private teamStatus(run: Run, member: string, taskId?: string) {
    const team = run.team!;
    const missingSessionIds = [...team.members]
      .filter(([id, slot]) => run.claimed.has(id) && !slot.sessionId)
      .map(([id]) => id);
    return {
      runId: run.id, workspace: run.workspace, member, tag: run.tag, bookmarkError: run.bookmarkError,
      worktree: run.worktrees?.find((tree) => tree.member === member)?.path,
      waitingFor: [...team.members.keys()].filter((id) => !run.claimed.has(id)).length,
      unread: this.unread(run, member, taskId).length,
      members: [...team.members].map(([id, slot]) => ({
        member: id, profile: slot.profile, connected: run.handles.has(id), hasSessionId: Boolean(slot.sessionId),
      })),
      ...(missingSessionIds.length ? { missingSessionIds } : {}),
      ownershipEvents: run.ownershipEvents,
      events: run.events,
      tasks: [...team.tasks.values()].filter((task) => !taskId || task.id === taskId),
    };
  }

  private send(run: Run, member: string, request: Send): Message {
    const { taskId, kind, body, replyTo, checks, role } = request;
    const original = replyTo ? run.messages[replyTo - 1] : undefined;
    const replyPeer = original?.to === member ? original.from : original?.from === member ? original.to : undefined;
    const task = run.team?.tasks.get(taskId);
    if (run.team && !task) throw new Error(`Unknown task: ${taskId}`);
    const peer = !run.team && role !== "claude" ? otherRole(role) : undefined;
    const to = request.to ?? replyPeer ?? peer ?? (member === leader ? task?.owner : leader);
    if (!to || to === member || (run.team ? !run.team.members.has(to) : to !== peer)) {
      throw new Error("Select another member of this run as the recipient.");
    }
    const nextRole = request.nextRole ?? (kind === "handoff" || kind === "assignment" ? to : undefined);
    if (nextRole && (run.team ? !run.team.members.has(nextRole) : nextRole !== member && nextRole !== peer)) {
      throw new Error("The next role must be a member of this run.");
    }
    const retryKey = `${member}:${request.requestId}`;
    const fingerprint = JSON.stringify([taskId, kind, body, replyTo, checks, nextRole, to]);
    const existing = run.requests.get(retryKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("This request ID was already used with different content.");
      return existing.message;
    }
    if (replyTo && (original?.taskId !== taskId || replyPeer !== to)) {
      throw new Error("The reply must refer to a message in this pairing and task.");
    }
    if (run.messages.length === 1000) throw new Error("This pairing has reached its message limit.");
    const message: Message = {
      id: run.messages.length + 1, taskId, kind, body, replyTo, checks, nextRole,
      from: member, to, createdAt: new Date().toISOString(),
    };
    run.messages.push(message);
    this.event(run, "message.sent", member, taskId, { message });
    run.requests.set(retryKey, { message, fingerprint });
    for (const listener of run.listeners) listener();
    this.notifyObservers();
    return message;
  }

  private unread(run: Run, member: string, taskId?: string): Message[] {
    return run.messages.filter((message) => message.to === member && !run.acknowledged.has(message.id)
      && (!taskId || taskId === message.taskId));
  }

  private event(run: Run, type: string, member?: string, taskId?: string, data?: Record<string, unknown>): void {
    run.events.push({ id: run.events.length + 1, timestamp: this.now(), runId: run.id, type, member, taskId, data });
  }

  private close(id: string): { closed: boolean } {
    const run = this.runs.get(id);
    if (!run) return { closed: false };
    if (run.worktrees) cleanupWorktrees(run.workspace, run.worktrees);
    this.runs.delete(id);
    if (run.persist) removeRun(this.directory, id);
    for (const handle of run.handles.values()) this.handles.delete(handle);
    for (const listener of run.listeners) listener();
    this.notifyObservers();
    return { closed: true };
  }
}
