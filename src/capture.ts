import { z } from "zod";
import { type Role } from "./types.js";

const id = z.string().uuid();
const sessionInput = z.object({ session_id: id, cwd: z.string().max(4000) });
const agyInput = z.object({ conversationId: id, workspacePaths: z.array(z.string().max(4000)).max(20) });

export function captureSession(role: Role, payload: unknown): Record<string, unknown> {
  if (role !== "antigravity") {
    const result = sessionInput.safeParse(payload);
    if (!result.success) return {};
    const meta = { role, sessionId: result.data.session_id, workspacePaths: [result.data.cwd] };
    return {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: context(meta),
      },
    };
  }

  const result = agyInput.safeParse(payload);
  if (!result.success) return {};
  const meta = { role, sessionId: result.data.conversationId, workspacePaths: result.data.workspacePaths };
  return { injectSteps: [{ systemMessage: { systemMessage: context(meta) } }] };
}

function context(meta: { role: Role; sessionId: string; workspacePaths: string[] }): string {
  return "Agent Pair metadata for this conversation only. Use it if the user invokes Agent Pair. "
    + JSON.stringify(meta);
}
