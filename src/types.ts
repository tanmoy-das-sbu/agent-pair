import { z } from "zod";

export const pairRoles = ["codex", "antigravity"] as const;
export const roles = [...pairRoles, "claude"] as const;
export const kinds = ["assignment", "question", "update", "blocker", "handoff"] as const;
export const roleSchema = z.enum(roles);
export type Role = z.infer<typeof roleSchema>;
export type PairRole = typeof pairRoles[number];
const member = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const workspace = z.string().min(1).max(4000);
const sessionId = z.string().uuid();
export const connectFields = {
  workspace,
  sessionId: sessionId.optional(),
  waitMs: z.number().int().min(100).max(25_000).default(25_000),
};
const handle = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().trim().min(1).max(120);
const messageId = z.number().int().positive();
const checks = z.array(z.string().trim().min(1).max(400)).max(10);
export const assignmentSchema = z.object({
  id: member,
  owner: member,
  profile: roleSchema,
  title: z.string().trim().min(1).max(300),
  paths: z.array(z.string().trim().min(1).max(240)).max(24),
  checks: checks.min(1),
  dependsOn: z.array(member).max(24).optional(),
});
export type Assignment = z.infer<typeof assignmentSchema>;
const workerCount = z.number().int().min(0).max(63);
export const teamSetupSchema = z.object({
  workspace,
  leadProfile: roleSchema,
  workers: z.object({ codex: workerCount, antigravity: workerCount, claude: workerCount }),
}).refine(({ workers }) => {
  const total = Object.values(workers).reduce((sum, count) => sum + count, 0);
  return total >= 1 && total <= 63;
}, "Choose between 1 and 63 workers in total.");
export type TeamSetupInput = z.infer<typeof teamSetupSchema>;
export const teamSetupFields = { workspace };
export const teamStartFields = {
  workspace,
  setupId: z.string().uuid().optional(),
  sessionId: sessionId.optional(),
  workerCount: z.number().int().min(1).max(63),
  allowedProfiles: z.array(roleSchema).min(1).max(3),
  assignments: z.array(assignmentSchema).min(2).max(64),
};
export const teamJoinFields = {
  workspace,
  runId: z.string().uuid().optional(),
  sessionId: sessionId.optional(),
};
export const teamUpdateFields = {
  handle,
  taskId: member,
  transition: z.enum(["start", "block", "handoff", "accept", "revise"]),
  note: z.string().trim().min(1).max(1000).optional(),
  checks: checks.optional(),
};
export const sendFields = {
  handle,
  taskId: identifier,
  kind: z.enum(kinds),
  body: z.string().trim().min(1).max(8000),
  requestId: identifier,
  replyTo: messageId.optional(),
  to: member.optional(),
  nextRole: member.optional(),
  checks: checks.optional(),
};
export const inboxFields = {
  handle,
  taskId: identifier.optional(),
  limit: z.number().int().min(1).max(40).default(20),
  waitMs: z.number().int().min(0).max(25_000).default(0),
};
export const ackFields = { handle, ids: z.array(messageId).min(1).max(40) };
export const statusFields = { handle, taskId: identifier.optional(), waitMs: inboxFields.waitMs };
export const disconnectFields = { handle };
export const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("connect"), role: roleSchema, ...connectFields }),
  z.object({ action: z.literal("teamSetup"), role: roleSchema, ...teamSetupFields }),
  z.object({ action: z.literal("teamStart"), role: roleSchema, noDashboard: z.boolean().optional(), ...teamStartFields }),
  z.object({ action: z.literal("teamJoin"), role: roleSchema, ...teamJoinFields }),
  z.object({ action: z.literal("teamUpdate"), role: roleSchema, ...teamUpdateFields }),
  z.object({ action: z.literal("send"), role: roleSchema, ...sendFields }),
  z.object({ action: z.literal("inbox"), role: roleSchema, ...inboxFields }),
  z.object({ action: z.literal("ack"), role: roleSchema, ...ackFields }),
  z.object({ action: z.literal("status"), role: roleSchema, ...statusFields }),
  z.object({ action: z.literal("disconnect"), role: roleSchema, ...disconnectFields }),
  z.object({ action: z.literal("close"), runId: z.string().uuid() }),
  z.object({ action: z.literal("dashboard") }),
  z.object({ action: z.literal("ping") }),
]);
export type Request = z.infer<typeof requestSchema>;

export function otherRole(role: PairRole): PairRole {
  return role === "codex" ? "antigravity" : "codex";
}
