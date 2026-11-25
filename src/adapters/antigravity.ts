import { join } from "node:path";
import { z } from "zod";
import {
  asJsonObject,
  buildEdits,
  hookHandler,
  isManagedHook,
  mergeJsonMcpConfig,
  parseJsonConfig,
  platformCommand,
  probeExecutableVersion,
  serializeJson,
  sessionContextMessage,
} from "./helpers.js";
import type { ClientAdapter } from "./types.js";

const agySessionInput = z.object({
  conversationId: z.string().uuid(),
  workspacePaths: z.array(z.string().max(4000)).max(20),
});

function agyHooks(source: string | undefined, entry: string): string {
  const doc = parseJsonConfig(source, "Antigravity hooks.json");
  const existing = doc["agent-pair"];
  if (existing !== undefined) {
    const group = asJsonObject(existing, "Antigravity Agent Pair hook");
    if (!Array.isArray(group.SessionStart) || !group.SessionStart.some((handler) => isManagedHook(handler, "antigravity"))) {
      throw new Error("Antigravity already has an unmanaged agent-pair hook.");
    }
  }
  return serializeJson({ ...doc, "agent-pair": { SessionStart: [hookHandler(entry, "antigravity", false)] } });
}

export const antigravityAdapter: ClientAdapter = {
  id: "antigravity",
  displayName: "Antigravity",
  experimental: false,
  supportsRelayProfile: true,
  executable: "agy",

  setup(context) {
    const dir = join(context.configHome, ".gemini", "config");
    return buildEdits([
      [join(dir, "mcp_config.json"), (old) => mergeJsonMcpConfig(old, context.registration, "antigravity", { timeoutSeconds: 40 })],
      [join(dir, "hooks.json"), (old) => agyHooks(old, context.entry)],
      [join(dir, "skills", "agent-pair", "SKILL.md"), () => context.skillContent],
    ], context.readFile);
  },

  doctor(platform = process.platform) {
    return probeExecutableVersion(this.executable, platform);
  },

  launch(workspace, prompt, platform = process.platform) {
    return {
      command: platformCommand(this.executable, platform),
      args: prompt ? ["--prompt", prompt] : [],
      cwd: workspace,
    };
  },

  resume(sessionId, workspace, platform = process.platform) {
    return {
      command: platformCommand(this.executable, platform),
      args: ["--conversation", sessionId],
      cwd: workspace,
    };
  },

  discoverSessionId(payload) {
    const result = agySessionInput.safeParse(payload);
    if (!result.success) return {};
    const meta = { role: this.id, sessionId: result.data.conversationId, workspacePaths: result.data.workspacePaths };
    return { injectSteps: [{ systemMessage: { systemMessage: sessionContextMessage(meta) } }] };
  },
};
