import { join } from "node:path";
import { z } from "zod";
import {
  buildEdits,
  mergeJsonMcpConfig,
  mergeSessionStartHooks,
  platformCommand,
  probeExecutableVersion,
  sessionContextMessage,
} from "./helpers.js";
import type { ClientAdapter } from "./types.js";

const claudeSessionInput = z.object({
  session_id: z.string().uuid(),
  cwd: z.string().max(4000),
});

export const claudeAdapter: ClientAdapter = {
  id: "claude",
  displayName: "Claude Code",
  experimental: false,
  executable: "claude",

  setup(context) {
    const claudeDir = join(context.configHome, ".claude");
    const claudeMcp = join(context.configHome, ".claude.json");
    return buildEdits([
      [claudeMcp, (old) => mergeJsonMcpConfig(old, context.registration, "claude", { type: "stdio" })],
      [join(claudeDir, "settings.json"), (old) => mergeSessionStartHooks(old, context.entry, "claude", true)],
      [join(claudeDir, "skills", "agent-pair", "SKILL.md"), () => context.skillContent],
    ], context.readFile);
  },

  doctor(platform = process.platform) {
    return probeExecutableVersion(this.executable, platform);
  },

  launch(workspace, prompt, platform = process.platform) {
    return {
      command: platformCommand(this.executable, platform),
      args: prompt ? [prompt] : [],
      cwd: workspace,
    };
  },

  resume(sessionId, workspace, platform = process.platform) {
    return {
      command: platformCommand(this.executable, platform),
      args: ["--resume", sessionId],
      cwd: workspace,
    };
  },

  discoverSessionId(payload) {
    const result = claudeSessionInput.safeParse(payload);
    if (!result.success) return {};
    const meta = { role: this.id, sessionId: result.data.session_id, workspacePaths: [result.data.cwd] };
    return {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: sessionContextMessage(meta),
      },
    };
  },
};
