import { mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getAdapter, type AdapterLookupOptions } from "./adapters/index.js";
import { registration, setupPlan } from "./setup.js";
import { pairRoles, type Role } from "./types.js";

export async function doctor(
  entry: string,
  profiles: readonly Role[] = pairRoles,
  options?: AdapterLookupOptions,
): Promise<string[]> {
  const changes = setupPlan(entry, profiles, options).filter((edit) => edit.content !== edit.original);
  if (changes.length) {
    throw new Error(`Setup is incomplete for: ${changes.map((edit) => edit.path).join(", ")}. Run agent-pair setup --dry-run.`);
  }

  const versions = profiles.map((profile) => getAdapter(profile, options).doctor());

  const workspace = mkdtempSync(join(tmpdir(), "agent-pair-doctor-"));
  const workerProfiles = profiles.length === 1 ? profiles : profiles.slice(1);
  const clients = [profiles[0], ...workerProfiles].map((role) => {
    const reg = registration(entry, role);
    return {
      client: new Client({ name: `agent-pair-doctor-${role}`, version: "0.3.1" }),
      transport: new StdioClientTransport({
        ...reg,
        env: { ...reg.env, AGENT_PAIR_NO_DASHBOARD: "1" },
        stderr: "ignore",
      }),
    };
  });
  const invoke = async (index: number, name: string, args: Record<string, unknown>) => {
    const output = await clients[index].client.callTool({ name, arguments: args });
    const content = output.content;
    const first = Array.isArray(content) ? content[0] : undefined;
    if (typeof first?.text !== "string") throw new Error(`No result from ${name}.`);
    if (output.isError) throw new Error(first.text);
    return JSON.parse(first.text);
  };
  try {
    await Promise.all(clients.map(({ client, transport }) => client.connect(transport)));
    const assignments = [profiles[0], ...workerProfiles].map((profile, index) => ({
      id: `task-${index}`, owner: index === 0 ? "orchestrator" : `worker-${index}`, profile,
      title: "Relay check", paths: [], checks: ["Message acknowledged"],
    }));
    const run = await invoke(0, "team_start", { workspace, assignments, workerCount: workerProfiles.length, allowedProfiles: workerProfiles });
    try {
      await Promise.all(assignments.slice(1).map(async ({ id }, index) => {
        const worker = await invoke(index + 1, "team_join", { workspace });
        const message = await invoke(0, "pair_send", {
          handle: run.handle, taskId: id, requestId: id, kind: "update", body: "Agent Pair connectivity check",
        });
        const inbox = await invoke(index + 1, "pair_inbox", { handle: worker.handle });
        if (inbox.messages?.[0]?.id !== message.id) throw new Error("The MCP test message was not delivered.");
        await invoke(index + 1, "pair_ack", { handle: worker.handle, ids: [message.id] });
      }));
    } finally {
      await invoke(0, "pair_disconnect", { handle: run.handle });
    }
  } finally {
    await Promise.allSettled(clients.map(({ transport }) => transport.close()));
    rmdirSync(workspace);
  }
  return [...versions, "The selected MCP profiles completed send, receive, and acknowledgment."];
}
