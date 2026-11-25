import { z } from "zod";

export const usageReportSchema = z.object({
  runId: z.string().trim().min(1).max(120),
  member: z.string().trim().min(1).max(60),
  taskId: z.string().trim().min(1).max(120).optional(),
  inputTokens: z.number().int().min(0).optional(),
  outputTokens: z.number().int().min(0).optional(),
  totalTokens: z.number().int().min(0).optional(),
  costUsd: z.number().min(0).optional(),
  model: z.string().trim().min(1).max(120).optional(),
  reportedAt: z.number().int().min(0).optional(),
}).refine(
  (data) => data.inputTokens !== undefined
    || data.outputTokens !== undefined
    || data.totalTokens !== undefined
    || data.costUsd !== undefined,
  "Provide at least one token count or costUsd field.",
);

export type UsageReport = z.infer<typeof usageReportSchema>;

export type TokenCostSummary = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  reportCount: number;
  models: string[];
};

export type TaskMetrics = {
  taskId: string;
  owner?: string;
  title?: string;
  state?: string;
  startedAt: number | null;
  completedAt: number | null;
  wallTimeMs: number | null;
  activeTimeMs: number;
  handoffCount: number;
  revisionCount: number;
  ownershipViolationCount: number;
  ownershipRejectionCount: number;
  blockCount: number;
  messageCount: number;
  usage: TokenCostSummary;
};

export type AgentMetrics = {
  member: string;
  profile?: string;
  tasksOwned: number;
  tasksAccepted: number;
  totalTaskWallTimeMs: number;
  totalActiveTimeMs: number;
  messagesSent: number;
  messagesReceived: number;
  messagesAcked: number;
  handoffsSubmitted: number;
  revisionsReceived: number;
  ownershipViolations: number;
  ownershipRejections: number;
  usage: TokenCostSummary;
};

export type RunMetrics = {
  runId: string;
  workspace?: string;
  mode?: "team" | "pair";
  tag?: string;
  startedAt: number | null;
  updatedAt: number;
  durationMs: number | null;
  eventCount: number;
  totals: {
    tasks: number;
    acceptedTasks: number;
    handoffs: number;
    revisions: number;
    ownershipViolations: number;
    ownershipRejections: number;
    messagesSent: number;
    messagesAcked: number;
    usage: TokenCostSummary;
  };
  tasks: Record<string, TaskMetrics>;
  agents: Record<string, AgentMetrics>;
  usageReports: UsageReport[];
};
