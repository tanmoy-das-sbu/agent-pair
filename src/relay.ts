import { randomBytes, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { saveBookmark, saveSessions } from "./bookmarks.js";
import { leader, Team } from "./team.js";
import { otherRole, type PairRole, type Request, type Role } from "./types.js";
import { pathKey, workspaceRoot } from "./workspace.js";

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
  state: "pending" | "active" | "blocked" | "ready" | "accepted";
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
};

export type DashboardSnapshot = {
  now: number;
  runs: DashboardRun[];
  pendingPairs: { workspace: string; workspaceName: string; role: PairRole }[];
};

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
  private readonly lifetime = 30 * 60 * 1000;

  constructor(private readonly directory: string, private readonly now: () => number = Date.now) {}

  subscribe(listener: () => void): () => void {
    this.observers.add(listener);
    return () => { this.observers.delete(listener); };
  }

  private notifyObservers(): void {
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
          const blocked = owned.find((task) => task.state === "blocked");
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
      };
    });
    const pendingPairs = [...this.pending.values()].map((entry) => ({
      workspace: entry.workspace,
      workspaceName: basename(entry.workspace) || entry.workspace,
      role: entry.role,
    }));
    return { now: this.now(), runs, pendingPairs };
  }

  sweep(): void {
    for (const run of this.runs.values()) {
      if (run.expires <= this.now()) this.close(run.id);
    }
  }

  get idle(): boolean {
    return this.runs.size === 0 && this.pending.size === 0;
  }

  async execute(request: Request, signal: AbortSignal): Promise<unknown> {
    this.sweep();
    if (request.action === "ping") return { available: true };
    if (request.action === "dashboard") return this.snapshot();
    if (request.action === "close") return this.close(request.runId);
    if (request.action === "connect") return this.connect(request, signal);
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
        const updated = run.team.update(member, request);
        this.notifyObservers();
        return updated;
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
        for (const id of ids) run.acknowledged.add(id);
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
    };
    this.runs.set(run.id, run);
    return run;
  }

  private addMember(run: Run, member: string, role: Role): string {
    const handle = randomBytes(32).toString("hex");
    run.handles.set(member, handle);
    run.claimed.add(member);
    run.lastActivity.set(member, this.now());
    this.handles.set(handle, { role, member, run });
    return handle;
  }

  private startTeam(request: Extract<Request, { action: "teamStart" }>) {
    const workspace = workspaceRoot(request.workspace);
    const team = new Team(request.role, request.sessionId, request.assignments, request.workerCount, request.allowedProfiles);
    const run = this.createRun(workspace, team);
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
        : "No active team is waiting in this workspace.");
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
      waitingFor: [...team.members.keys()].filter((id) => !run.claimed.has(id)).length,
      unread: this.unread(run, member, taskId).length,
      members: [...team.members].map(([id, slot]) => ({
        member: id, profile: slot.profile, connected: run.handles.has(id), hasSessionId: Boolean(slot.sessionId),
      })),
      ...(missingSessionIds.length ? { missingSessionIds } : {}),
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
    run.requests.set(retryKey, { message, fingerprint });
    for (const listener of run.listeners) listener();
    this.notifyObservers();
    return message;
  }

  private unread(run: Run, member: string, taskId?: string): Message[] {
    return run.messages.filter((message) => message.to === member && !run.acknowledged.has(message.id)
      && (!taskId || taskId === message.taskId));
  }

  private close(id: string): { closed: boolean } {
    const run = this.runs.get(id);
    if (!run) return { closed: false };
    this.runs.delete(id);
    for (const handle of run.handles.values()) this.handles.delete(handle);
    for (const listener of run.listeners) listener();
    this.notifyObservers();
    return { closed: true };
  }
}
