import type { DashboardMember, DashboardTask, RunEvent } from "../relay.js";
import {
  usageReportSchema,
  type AgentMetrics,
  type RunMetrics,
  type TaskMetrics,
  type TokenCostSummary,
  type UsageReport,
} from "./types.js";

export type AggregateMetricsInput = {
  runId: string;
  events: readonly RunEvent[];
  usageReports?: readonly UsageReport[];
  tasks?: readonly DashboardTask[];
  members?: readonly DashboardMember[];
  workspace?: string;
  mode?: "team" | "pair";
  tag?: string;
  createdAt?: number;
  now?: number;
};

type UsageAccumulator = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  reportCount: number;
  models: Set<string>;
};

function createUsageAcc(): UsageAccumulator {
  return {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    costUsd: null,
    reportCount: 0,
    models: new Set<string>(),
  };
}

function addUsage(acc: UsageAccumulator, report: UsageReport): void {
  acc.reportCount += 1;
  if (report.inputTokens !== undefined) {
    acc.inputTokens = (acc.inputTokens ?? 0) + report.inputTokens;
  }
  if (report.outputTokens !== undefined) {
    acc.outputTokens = (acc.outputTokens ?? 0) + report.outputTokens;
  }
  const derivedTotal = report.totalTokens
    ?? (report.inputTokens !== undefined || report.outputTokens !== undefined
      ? (report.inputTokens ?? 0) + (report.outputTokens ?? 0)
      : undefined);
  if (derivedTotal !== undefined) {
    acc.totalTokens = (acc.totalTokens ?? 0) + derivedTotal;
  }
  if (report.costUsd !== undefined) {
    acc.costUsd = Number(((acc.costUsd ?? 0) + report.costUsd).toFixed(6));
  }
  if (report.model) acc.models.add(report.model);
}

function finalizeUsage(acc: UsageAccumulator): TokenCostSummary {
  return {
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    totalTokens: acc.totalTokens,
    costUsd: acc.costUsd,
    reportCount: acc.reportCount,
    models: [...acc.models].sort(),
  };
}

function extractUsageEvent(event: RunEvent): UsageReport | null {
  if (event.type !== "usage.reported" || !event.data || !event.member) return null;
  const parsed = usageReportSchema.safeParse({
    runId: event.runId,
    member: event.member,
    taskId: event.taskId ?? (typeof event.data.taskId === "string" ? event.data.taskId : undefined),
    inputTokens: event.data.inputTokens,
    outputTokens: event.data.outputTokens,
    totalTokens: event.data.totalTokens,
    costUsd: event.data.costUsd,
    model: event.data.model,
    reportedAt: event.timestamp,
  });
  return parsed.success ? parsed.data : null;
}

export function aggregateRunMetrics(input: AggregateMetricsInput): RunMetrics {
  const sorted = [...input.events].sort((left, right) => (left.id - right.id) || (left.timestamp - right.timestamp));
  const lastEventTs = sorted.length ? sorted[sorted.length - 1].timestamp : undefined;
  const now = input.now ?? lastEventTs ?? input.createdAt ?? Date.now();

  const taskMap = new Map<string, TaskMetrics & { _activeStart: number | null; _usage: UsageAccumulator }>();
  const agentMap = new Map<string, AgentMetrics & { _usage: UsageAccumulator }>();
  const totalUsage = createUsageAcc();

  const ensureAgent = (member: string, profile?: string) => {
    let entry = agentMap.get(member);
    if (!entry) {
      entry = {
        member,
        profile,
        tasksOwned: 0,
        tasksAccepted: 0,
        totalTaskWallTimeMs: 0,
        totalActiveTimeMs: 0,
        messagesSent: 0,
        messagesReceived: 0,
        messagesAcked: 0,
        handoffsSubmitted: 0,
        revisionsReceived: 0,
        ownershipViolations: 0,
        ownershipRejections: 0,
        usage: finalizeUsage(createUsageAcc()),
        _usage: createUsageAcc(),
      };
      agentMap.set(member, entry);
    } else if (profile && !entry.profile) {
      entry.profile = profile;
    }
    return entry;
  };

  const ensureTask = (taskId: string, meta?: Partial<DashboardTask>) => {
    let entry = taskMap.get(taskId);
    if (!entry) {
      entry = {
        taskId,
        owner: meta?.owner,
        title: meta?.title,
        state: meta?.state,
        startedAt: null,
        completedAt: null,
        wallTimeMs: null,
        activeTimeMs: 0,
        handoffCount: 0,
        revisionCount: 0,
        ownershipViolationCount: 0,
        ownershipRejectionCount: 0,
        blockCount: 0,
        messageCount: 0,
        usage: finalizeUsage(createUsageAcc()),
        _activeStart: null,
        _usage: createUsageAcc(),
      };
      taskMap.set(taskId, entry);
    } else if (meta) {
      if (meta.owner && !entry.owner) entry.owner = meta.owner;
      if (meta.title && !entry.title) entry.title = meta.title;
      if (meta.state) entry.state = meta.state;
    }
    return entry;
  };

  for (const member of input.members ?? []) {
    ensureAgent(member.member, member.profile);
  }
  for (const task of input.tasks ?? []) {
    ensureTask(task.id, task);
    ensureAgent(task.owner, task.profile);
  }

  let startedAt: number | null = input.createdAt ?? null;
  let totalHandoffs = 0;
  let totalRevisions = 0;
  let totalOwnershipViolations = 0;
  let totalOwnershipRejections = 0;
  let totalMessagesSent = 0;
  let totalMessagesAcked = 0;
  const collectedUsage: UsageReport[] = [];

  for (const event of sorted) {
    if (event.type === "run.started") {
      if (startedAt === null || event.timestamp < startedAt) startedAt = event.timestamp;
      continue;
    }
    if (startedAt === null) startedAt = event.timestamp;

    if (event.type === "member.joined" && event.member) {
      const profile = typeof event.data?.profile === "string" ? event.data.profile : undefined;
      ensureAgent(event.member, profile);
      continue;
    }

    if (event.type === "member.disconnected" && event.member) {
      ensureAgent(event.member);
      continue;
    }

    if (event.type === "task.started" && event.taskId) {
      const task = ensureTask(event.taskId, event.member ? { owner: event.member } : undefined);
      if (event.member) ensureAgent(event.member);
      if (task.startedAt === null) task.startedAt = event.timestamp;
      if (task._activeStart === null) task._activeStart = event.timestamp;
      task.state = typeof event.data?.state === "string" ? event.data.state : "active";
      continue;
    }

    if (event.type === "task.blocked" && event.taskId) {
      const task = ensureTask(event.taskId, event.member ? { owner: event.member } : undefined);
      task.blockCount += 1;
      if (task._activeStart !== null) {
        task.activeTimeMs += Math.max(0, event.timestamp - task._activeStart);
        task._activeStart = null;
      }
      task.state = typeof event.data?.state === "string" ? event.data.state : "blocked";
      continue;
    }

    if (event.type === "task.handoff" && event.taskId) {
      const task = ensureTask(event.taskId, event.member ? { owner: event.member } : undefined);
      task.handoffCount += 1;
      totalHandoffs += 1;
      if (task._activeStart !== null) {
        task.activeTimeMs += Math.max(0, event.timestamp - task._activeStart);
        task._activeStart = null;
      }
      task.state = typeof event.data?.state === "string" ? event.data.state : "ready";
      const submitter = event.member ?? task.owner;
      if (submitter) ensureAgent(submitter).handoffsSubmitted += 1;
      continue;
    }

    if (event.type === "task.revised" && event.taskId) {
      const task = ensureTask(event.taskId);
      task.revisionCount += 1;
      totalRevisions += 1;
      if (task._activeStart !== null) {
        task.activeTimeMs += Math.max(0, event.timestamp - task._activeStart);
        task._activeStart = null;
      }
      task.state = typeof event.data?.state === "string" ? event.data.state : "pending";
      const owner = task.owner ?? event.member;
      if (owner) ensureAgent(owner).revisionsReceived += 1;
      continue;
    }

    if (event.type === "task.accepted" && event.taskId) {
      const task = ensureTask(event.taskId);
      task.completedAt = event.timestamp;
      if (task._activeStart !== null) {
        task.activeTimeMs += Math.max(0, event.timestamp - task._activeStart);
        task._activeStart = null;
      }
      task.state = typeof event.data?.state === "string" ? event.data.state : "accepted";
      continue;
    }

    if (event.type === "ownership.violation") {
      const rejected = event.data?.rejected === true || event.data?.mode === "strict";
      totalOwnershipViolations += 1;
      if (rejected) totalOwnershipRejections += 1;
      let owner = event.member;
      if (event.taskId) {
        const task = ensureTask(event.taskId, event.member ? { owner: event.member } : undefined);
        task.ownershipViolationCount += 1;
        if (rejected) task.ownershipRejectionCount += 1;
        owner = task.owner ?? owner;
      }
      if (owner) {
        const agent = ensureAgent(owner);
        agent.ownershipViolations += 1;
        if (rejected) agent.ownershipRejections += 1;
      }
      continue;
    }

    if (event.type === "message.sent") {
      totalMessagesSent += 1;
      const msg = (event.data?.message && typeof event.data.message === "object")
        ? event.data.message as Record<string, unknown>
        : undefined;
      const from = event.member ?? (typeof msg?.from === "string" ? msg.from : undefined);
      const to = typeof msg?.to === "string" ? msg.to : undefined;
      if (from) ensureAgent(from).messagesSent += 1;
      if (to) ensureAgent(to).messagesReceived += 1;
      if (event.taskId && taskMap.has(event.taskId)) {
        taskMap.get(event.taskId)!.messageCount += 1;
      }
      continue;
    }

    if (event.type === "message.acked") {
      totalMessagesAcked += 1;
      if (event.member) ensureAgent(event.member).messagesAcked += 1;
      continue;
    }

    const usageFromEvent = extractUsageEvent(event);
    if (usageFromEvent) {
      collectedUsage.push(usageFromEvent);
    }
  }

  for (const report of input.usageReports ?? []) {
    if (report.runId !== input.runId) continue;
    collectedUsage.push(report);
  }

  for (const report of collectedUsage) {
    addUsage(totalUsage, report);
    addUsage(ensureAgent(report.member)._usage, report);
    if (report.taskId) {
      addUsage(ensureTask(report.taskId, { owner: report.member })._usage, report);
    }
  }

  const tasksOut: Record<string, TaskMetrics> = {};
  let acceptedTasks = 0;

  for (const [taskId, entry] of taskMap) {
    if (entry._activeStart !== null && entry.state === "active") {
      entry.activeTimeMs += Math.max(0, now - entry._activeStart);
    }
    if (entry.startedAt !== null) {
      const end = entry.completedAt ?? now;
      entry.wallTimeMs = Math.max(0, end - entry.startedAt);
    }
    if (entry.state === "accepted") acceptedTasks += 1;
    if (entry.owner) {
      const agent = ensureAgent(entry.owner);
      agent.tasksOwned += 1;
      if (entry.state === "accepted") agent.tasksAccepted += 1;
      if (entry.wallTimeMs !== null) agent.totalTaskWallTimeMs += entry.wallTimeMs;
      agent.totalActiveTimeMs += entry.activeTimeMs;
    }
    tasksOut[taskId] = {
      taskId: entry.taskId,
      ...(entry.owner !== undefined ? { owner: entry.owner } : {}),
      ...(entry.title !== undefined ? { title: entry.title } : {}),
      ...(entry.state !== undefined ? { state: entry.state } : {}),
      startedAt: entry.startedAt,
      completedAt: entry.completedAt,
      wallTimeMs: entry.wallTimeMs,
      activeTimeMs: entry.activeTimeMs,
      handoffCount: entry.handoffCount,
      revisionCount: entry.revisionCount,
      ownershipViolationCount: entry.ownershipViolationCount,
      ownershipRejectionCount: entry.ownershipRejectionCount,
      blockCount: entry.blockCount,
      messageCount: entry.messageCount,
      usage: finalizeUsage(entry._usage),
    };
  }

  const agentsOut: Record<string, AgentMetrics> = {};
  for (const [member, entry] of agentMap) {
    agentsOut[member] = {
      member: entry.member,
      ...(entry.profile !== undefined ? { profile: entry.profile } : {}),
      tasksOwned: entry.tasksOwned,
      tasksAccepted: entry.tasksAccepted,
      totalTaskWallTimeMs: entry.totalTaskWallTimeMs,
      totalActiveTimeMs: entry.totalActiveTimeMs,
      messagesSent: entry.messagesSent,
      messagesReceived: entry.messagesReceived,
      messagesAcked: entry.messagesAcked,
      handoffsSubmitted: entry.handoffsSubmitted,
      revisionsReceived: entry.revisionsReceived,
      ownershipViolations: entry.ownershipViolations,
      ownershipRejections: entry.ownershipRejections,
      usage: finalizeUsage(entry._usage),
    };
  }

  const durationMs = startedAt !== null ? Math.max(0, now - startedAt) : null;

  return {
    runId: input.runId,
    ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
    ...(input.mode !== undefined ? { mode: input.mode } : {}),
    ...(input.tag !== undefined ? { tag: input.tag } : {}),
    startedAt,
    updatedAt: now,
    durationMs,
    eventCount: sorted.length,
    totals: {
      tasks: taskMap.size,
      acceptedTasks,
      handoffs: totalHandoffs,
      revisions: totalRevisions,
      ownershipViolations: totalOwnershipViolations,
      ownershipRejections: totalOwnershipRejections,
      messagesSent: totalMessagesSent,
      messagesAcked: totalMessagesAcked,
      usage: finalizeUsage(totalUsage),
    },
    tasks: tasksOut,
    agents: agentsOut,
    usageReports: collectedUsage,
  };
}
