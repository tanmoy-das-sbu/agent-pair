import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentActivityState,
  DashboardMember,
  DashboardMessage,
  DashboardRun,
  DashboardSnapshot,
  DashboardTask,
  Relay,
  RunEvent,
} from "../relay.js";
import type { Role } from "../types.js";
import { dataDirectory } from "../workspace.js";
import { aggregateRunMetrics } from "./aggregator.js";
import type { MetricsTracker } from "./store.js";
import type { RunMetrics, UsageReport } from "./types.js";

const safeRunIdPattern = /^[a-zA-Z0-9._-]{1,120}$/;

function assertSafeRunId(runId: string): string {
  if (!safeRunIdPattern.test(runId) || runId === "." || runId === "..") {
    throw new Error(`Invalid run ID for timeline persistence: ${runId}`);
  }
  return runId;
}

export type TimelineTaskSeed = {
  id: string;
  owner: string;
  profile: Role;
  title: string;
  paths: string[];
  checks: string[];
  dependsOn: string[];
};

export type TimelineMemberSeed = {
  member: string;
  profile: Role;
  isOrchestrator: boolean;
};

export type RunTimeline = {
  schemaVersion: 1;
  runId: string;
  mode: "team" | "pair";
  workspace: string;
  workspaceName: string;
  tag?: string;
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
  members: TimelineMemberSeed[];
  tasks: TimelineTaskSeed[];
  events: RunEvent[];
  messages: DashboardMessage[];
  metrics: RunMetrics;
};

export type ReplayFrame = {
  stepIndex: number;
  totalSteps: number;
  currentEvent: RunEvent | null;
  timestamp: number;
  activeMembers: string[];
  run: DashboardRun & { metrics: RunMetrics };
};

export function sortTimelineEvents(events: readonly RunEvent[]): RunEvent[] {
  return [...events].sort((left, right) => (left.id - right.id) || (left.timestamp - right.timestamp));
}

export function buildRunTimeline(
  run: DashboardRun,
  options: { now?: number; closedAt?: number; usageReports?: readonly UsageReport[] } = {},
): RunTimeline {
  const events = sortTimelineEvents(run.events ?? []);
  const now = options.now ?? (events.length ? events[events.length - 1].timestamp : run.createdAt);
  const metrics = aggregateRunMetrics({
    runId: run.id,
    events,
    usageReports: options.usageReports,
    tasks: run.tasks,
    members: run.members,
    workspace: run.workspace,
    mode: run.mode,
    tag: run.tag,
    createdAt: run.createdAt,
    now,
  });
  const finalMetrics: RunMetrics = options.closedAt !== undefined ? { ...metrics, closedAt: options.closedAt } : metrics;
  return {
    schemaVersion: 1,
    runId: run.id,
    mode: run.mode,
    workspace: run.workspace,
    workspaceName: run.workspaceName,
    ...(run.tag !== undefined ? { tag: run.tag } : {}),
    createdAt: run.createdAt,
    updatedAt: now,
    ...(options.closedAt !== undefined ? { closedAt: options.closedAt } : {}),
    members: run.members.map((m) => ({
      member: m.member,
      profile: m.profile,
      isOrchestrator: m.isOrchestrator,
    })),
    tasks: run.tasks.map((t) => ({
      id: t.id,
      owner: t.owner,
      profile: t.profile,
      title: t.title,
      paths: [...t.paths],
      checks: [...t.checks],
      dependsOn: [...t.dependsOn],
    })),
    events,
    messages: run.messages.map((msg) => ({ ...msg })),
    metrics: finalMetrics,
  };
}

export function replayRunAt(timeline: RunTimeline, requestedStep: number): ReplayFrame {
  const events = sortTimelineEvents(timeline.events);
  const totalSteps = events.length;
  const stepIndex = totalSteps === 0
    ? -1
    : Math.max(-1, Math.min(Math.floor(requestedStep), totalSteps - 1));
  const slice = stepIndex >= 0 ? events.slice(0, stepIndex + 1) : [];
  const currentEvent = stepIndex >= 0 ? events[stepIndex] : null;
  const timestamp = currentEvent ? currentEvent.timestamp : timeline.createdAt;

  const taskState = new Map<string, DashboardTask>();
  for (const seed of timeline.tasks) {
    taskState.set(seed.id, {
      id: seed.id,
      owner: seed.owner,
      profile: seed.profile,
      title: seed.title,
      paths: [...seed.paths],
      checks: [...seed.checks],
      dependsOn: [...seed.dependsOn],
      state: "pending",
    });
  }

  const memberSeeds = new Map<string, TimelineMemberSeed>();
  for (const seed of timeline.members) {
    memberSeeds.set(seed.member, seed);
  }

  const connected = new Set<string>();
  const claimed = new Set<string>();
  const lastActivity = new Map<string, number>();
  const messages: DashboardMessage[] = [];
  const messageById = new Map<number, DashboardMessage>();
  const ownershipEvents: { type: "ownership.violation"; taskId: string; files: string[]; at: number }[] = [];

  for (const ev of slice) {
    if (ev.member) lastActivity.set(ev.member, ev.timestamp);
    if (ev.type === "member.joined" && ev.member) {
      connected.add(ev.member);
      claimed.add(ev.member);
      if (!memberSeeds.has(ev.member)) {
        const profile = (typeof ev.data?.profile === "string" ? ev.data.profile : "codex") as Role;
        memberSeeds.set(ev.member, { member: ev.member, profile, isOrchestrator: ev.member === "orchestrator" });
      }
      continue;
    }
    if (ev.type === "member.disconnected" && ev.member) {
      connected.delete(ev.member);
      continue;
    }
    if (ev.taskId && taskState.has(ev.taskId)) {
      const task = taskState.get(ev.taskId)!;
      const dataState = typeof ev.data?.state === "string" ? ev.data.state : undefined;
      const note = typeof ev.data?.note === "string" ? ev.data.note : undefined;
      const checks = Array.isArray(ev.data?.checks) ? ev.data.checks.map(String) : undefined;
      if (ev.type === "task.started") {
        task.state = (dataState as DashboardTask["state"]) ?? "active";
        if (note !== undefined) task.note = note;
        task.evidence = undefined;
      } else if (ev.type === "task.blocked") {
        task.state = (dataState as DashboardTask["state"]) ?? "blocked";
        if (note !== undefined) task.note = note;
        task.evidence = undefined;
      } else if (ev.type === "task.handoff") {
        task.state = (dataState as DashboardTask["state"]) ?? "ready";
        if (note !== undefined) task.note = note;
        if (checks !== undefined) task.evidence = checks;
      } else if (ev.type === "task.revised") {
        task.state = (dataState as DashboardTask["state"]) ?? "pending";
        if (note !== undefined) task.note = note;
        task.evidence = undefined;
      } else if (ev.type === "task.accepted") {
        task.state = (dataState as DashboardTask["state"]) ?? "accepted";
        if (note !== undefined) task.note = note;
      } else if (ev.type === "task.stalled") {
        task.state = "blocked";
        if (note !== undefined) task.note = note;
      } else if (ev.type === "ownership.violation") {
        const files = Array.isArray(ev.data?.files) ? ev.data.files.map(String) : [];
        ownershipEvents.push({ type: "ownership.violation", taskId: ev.taskId, files, at: ev.timestamp });
      }
    }
    if (ev.type === "message.sent") {
      const raw = ev.data?.message as Record<string, unknown> | undefined;
      if (raw && typeof raw.id === "number") {
        const msg: DashboardMessage = {
          id: raw.id,
          taskId: typeof raw.taskId === "string" ? raw.taskId : (ev.taskId ?? ""),
          kind: typeof raw.kind === "string" ? raw.kind : "update",
          body: typeof raw.body === "string" ? raw.body : "",
          from: typeof raw.from === "string" ? raw.from : (ev.member ?? ""),
          to: typeof raw.to === "string" ? raw.to : "",
          ...(typeof raw.replyTo === "number" ? { replyTo: raw.replyTo } : {}),
          ...(Array.isArray(raw.checks) ? { checks: raw.checks.map(String) } : {}),
          createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date(ev.timestamp).toISOString(),
          acknowledged: false,
        };
        messages.push(msg);
        messageById.set(msg.id, msg);
      }
      continue;
    }
    if (ev.type === "message.acked") {
      const messageId = typeof ev.data?.messageId === "number" ? ev.data.messageId : undefined;
      if (messageId !== undefined && messageById.has(messageId)) {
        messageById.get(messageId)!.acknowledged = true;
      }
    }
  }

  const tasks = [...taskState.values()];
  const members: DashboardMember[] = [...memberSeeds.values()].map((seed) => {
    const isConnected = connected.has(seed.member);
    const isClaimed = claimed.has(seed.member);
    const owned = tasks.filter((t) => t.owner === seed.member);
    const active = owned.find((t) => t.state === "active");
    const blocked = owned.find((t) => t.state === "blocked");
    const ready = owned.find((t) => t.state === "ready");
    const allAccepted = owned.length > 0 && owned.every((t) => t.state === "accepted");
    let status: AgentActivityState;
    if (timeline.mode === "pair") {
      status = isConnected ? "working" : "disconnected";
    } else if (!isClaimed) {
      status = "waiting";
    } else if (allAccepted) {
      status = "done";
    } else if (!isConnected) {
      status = "disconnected";
    } else if (active) {
      status = "working";
    } else if (blocked) {
      status = "blocked";
    } else if (ready) {
      status = "review";
    } else {
      status = "idle";
    }
    const focus = active ?? blocked ?? ready ?? owned.find((t) => t.state === "pending");
    const unread = messages.filter((m) => m.to === seed.member && !m.acknowledged).length;
    return {
      member: seed.member,
      profile: seed.profile,
      isOrchestrator: seed.isOrchestrator,
      connected: isConnected,
      claimed: isClaimed,
      hasSessionId: Boolean(timeline.tag),
      status,
      ...(focus ? { currentTaskId: focus.id, currentTaskTitle: focus.title } : {}),
      unread,
      ...(lastActivity.has(seed.member) ? { lastActivityAt: lastActivity.get(seed.member) } : {}),
    };
  });

  const usageReports = timeline.metrics.usageReports.filter(
    (report) => report.reportedAt === undefined || report.reportedAt <= timestamp,
  );
  const metrics = aggregateRunMetrics({
    runId: timeline.runId,
    events: slice,
    usageReports,
    tasks,
    members,
    workspace: timeline.workspace,
    mode: timeline.mode,
    tag: timeline.tag,
    createdAt: timeline.createdAt,
    now: timestamp,
  });

  const activeMembers = new Set<string>();
  if (currentEvent?.member) activeMembers.add(currentEvent.member);
  if (currentEvent?.type === "message.sent") {
    const raw = currentEvent.data?.message as Record<string, unknown> | undefined;
    if (typeof raw?.to === "string") activeMembers.add(raw.to);
  }

  return {
    stepIndex,
    totalSteps,
    currentEvent,
    timestamp,
    activeMembers: [...activeMembers],
    run: {
      id: timeline.runId,
      mode: timeline.mode,
      workspace: timeline.workspace,
      workspaceName: timeline.workspaceName,
      ...(timeline.tag !== undefined ? { tag: timeline.tag } : {}),
      missingSessionIds: [],
      waitingFor: members.filter((m) => !m.claimed).length,
      createdAt: timeline.createdAt,
      expiresAt: timeline.closedAt ?? timeline.updatedAt,
      members,
      tasks,
      messages,
      events: slice,
      ownershipEvents,
      metrics,
    },
  };
}

export function timelinesDirectory(baseDir?: string): string {
  return join(baseDir ?? dataDirectory(), "timelines");
}

export function timelineFilePath(runId: string, baseDir?: string): string {
  return join(timelinesDirectory(baseDir), `${assertSafeRunId(runId)}.json`);
}

export function saveRunTimeline(timeline: RunTimeline, baseDir?: string): string {
  const dir = timelinesDirectory(baseDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = timelineFilePath(timeline.runId, baseDir);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(timeline, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temporary, target);
    return target;
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function loadRunTimeline(runId: string, baseDir?: string): RunTimeline | null {
  try {
    const raw = readFileSync(timelineFilePath(runId, baseDir), "utf8");
    return JSON.parse(raw) as RunTimeline;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function listSavedTimelines(baseDir?: string): string[] {
  try {
    return readdirSync(timelinesDirectory(baseDir))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -5))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export class TimelineRecorder {
  private readonly latestRunMeta = new Map<string, DashboardRun>();
  private readonly activeRunIds = new Set<string>();
  private readonly timelines = new Map<string, RunTimeline>();
  private readonly persistedKeys = new Map<string, string>();
  private detachRelay?: () => void;

  constructor(
    private readonly baseDir?: string,
    private readonly metricsTracker?: MetricsTracker,
    private readonly persist = true,
  ) {}

  attach(relay: Relay): () => void {
    this.detach();
    this.syncSnapshot(relay.snapshot());
    const unsubscribe = relay.subscribe(() => {
      this.syncSnapshot(relay.snapshot());
    });
    this.detachRelay = () => {
      unsubscribe();
      this.detachRelay = undefined;
    };
    return this.detachRelay;
  }

  detach(): void {
    this.detachRelay?.();
  }

  syncSnapshot(snapshot: DashboardSnapshot): Record<string, RunTimeline> {
    const result: Record<string, RunTimeline> = {};
    const seen = new Set<string>();
    for (const run of snapshot.runs) {
      seen.add(run.id);
      this.activeRunIds.add(run.id);
      this.latestRunMeta.set(run.id, run);
      result[run.id] = this.recordAndPersist(run, snapshot.now);
    }
    for (const runId of [...this.activeRunIds]) {
      if (seen.has(runId)) continue;
      this.activeRunIds.delete(runId);
      const lastRun = this.latestRunMeta.get(runId);
      if (lastRun) {
        this.recordAndPersist(lastRun, snapshot.now, snapshot.now);
      }
    }
    return result;
  }

  getTimeline(runId: string): RunTimeline | null {
    const live = this.timelines.get(runId);
    if (live) return live;
    if (!this.persist) return null;
    return loadRunTimeline(runId, this.baseDir);
  }

  listTimelines(): RunTimeline[] {
    const byId = new Map<string, RunTimeline>();
    if (this.persist) {
      for (const runId of listSavedTimelines(this.baseDir)) {
        const loaded = loadRunTimeline(runId, this.baseDir);
        if (loaded) byId.set(runId, loaded);
      }
    }
    for (const [runId, timeline] of this.timelines) {
      byId.set(runId, timeline);
    }
    return [...byId.values()].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  private recordAndPersist(run: DashboardRun, now?: number, closedAt?: number): RunTimeline {
    const usageReports = this.metricsTracker?.getUsageReports(run.id) ?? [];
    const timeline = buildRunTimeline(run, { now, closedAt, usageReports });
    this.timelines.set(run.id, timeline);
    if (this.persist) {
      const key = `${timeline.events.length}:${timeline.messages.length}:${usageReports.length}:${run.tag ?? ""}:${closedAt ?? ""}`;
      if (this.persistedKeys.get(run.id) !== key) {
        try {
          saveRunTimeline(timeline, this.baseDir);
          this.persistedKeys.set(run.id, key);
        } catch {
          // Best-effort persistence must never interrupt relay/dashboard execution.
        }
      }
    }
    return timeline;
  }
}
