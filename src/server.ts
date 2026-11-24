import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { relayCall } from "./ipc.js";
import {
  ackFields, connectFields, disconnectFields, inboxFields, sendFields, statusFields,
  teamJoinFields, teamStartFields, teamUpdateFields,
  type Request, type Role,
} from "./types.js";

export async function serve(entry: string, role: Role): Promise<void> {
  const server = new McpServer({ name: "agent-pair", version: "0.2.1" });
  const invoke = async (request: Request, signal: AbortSignal) => {
    try {
      const result = await relayCall(entry, request, signal);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Agent Pair failed." }],
      };
    }
  };
  server.registerTool("pair_connect", {
    description: "Start a fresh pair with the other agent in the current workspace.",
    inputSchema: connectFields,
  }, (input, extra) => invoke({ action: "connect", role, ...input }, extra.signal));
  const suppressDashboard = process.env.AGENT_PAIR_NO_DASHBOARD === "1" || process.env.AGENT_PAIR_DASHBOARD === "0";
  server.registerTool("team_start", {
    description: `Your current client profile is ${role}. Start a fresh team after asking the user how many additional worker sessions they want under you (total sessions = workerCount + 1) and which client profiles those workers should use. Include your sessionId from Agent Pair session-start metadata when available so a 4-character resume tag is saved once all workers join. Assign each worker slot an allowed profile and owned tasks. Workers join from the same workspace without individual invitations.`,
    inputSchema: teamStartFields,
  }, (input, extra) => invoke({
    action: "teamStart",
    role,
    ...(suppressDashboard ? { noDashboard: true } : {}),
    ...input,
  }, extra.signal));
  server.registerTool("team_join", {
    description: "Join the waiting team in the current workspace using this session's client profile. Include your sessionId from Agent Pair session-start metadata when available so the 4-character resume tag can be saved once all members join. Include runId only if multiple teams are active. Returns this worker's tasks and owned paths.",
    inputSchema: teamJoinFields,
  }, (input, extra) => invoke({ action: "teamJoin", role, ...input }, extra.signal));
  server.registerTool("team_update", {
    description: "Start, block, or hand off an owned task. The orchestrator can accept a handoff or request revision. Dependencies must be accepted before starting. Handoffs include a note and check results.",
    inputSchema: teamUpdateFields,
  }, (input, extra) => invoke({ action: "teamUpdate", role, ...input }, extra.signal));
  server.registerTool("pair_send", {
    description: "Send a message to another member of this run. Supply to with the recipient's member ID to address a specific teammate.",
    inputSchema: sendFields,
  }, (input, extra) => invoke({ action: "send", role, ...input }, extra.signal));
  server.registerTool("pair_inbox", {
    description: "Read unacknowledged messages for this session.",
    inputSchema: inboxFields,
  }, (input, extra) => invoke({ action: "inbox", role, ...input }, extra.signal));
  server.registerTool("pair_ack", {
    description: "Mark messages addressed to this session as read.",
    inputSchema: ackFields,
  }, (input, extra) => invoke({ action: "ack", role, ...input }, extra.signal));
  server.registerTool("pair_status", {
    description: "Get team roster, task states, and unread count, or the current handoff in a two-agent pair. As orchestrator, set waitMs to wait for workers to join.",
    inputSchema: statusFields,
  }, (input, extra) => invoke({ action: "status", role, ...input }, extra.signal));
  server.registerTool("pair_disconnect", {
    description: "Disconnect your worker slot, or close the whole run as the orchestrator or a member of a two-agent pair.",
    inputSchema: disconnectFields,
  }, (input, extra) => invoke({ action: "disconnect", role, ...input }, extra.signal));
  await server.connect(new StdioServerTransport());
}
