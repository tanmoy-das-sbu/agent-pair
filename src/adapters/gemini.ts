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
import type { AdapterSetupContext, AdapterSetupEdit, ClientAdapter } from "./types.js";

const geminiSessionInput = z.object({
  session_id: z.string().uuid(),
  cwd: z.string().max(4000),
});

function buildGeminiEdits(context: AdapterSetupContext): AdapterSetupEdit[] {
  const geminiDir = join(context.configHome, ".gemini");
  return buildEdits([
    [
      join(geminiDir, "settings.json"),
      (old) => {
        const withMcp = mergeJsonMcpConfig(old, context.registration, "gemini", { trust: false });
        return mergeSessionStartHooks(withMcp, context.entry, "gemini", false);
      },
    ],
    [join(geminiDir, "skills", "agent-pair", "SKILL.md"), () => context.skillContent],
  ], context.readFile);
}

/**
 * Experimental adapter for Gemini CLI.
 * Gated behind `--experimental-adapters` or `AGENT_PAIR_EXPERIMENTAL_ADAPTERS=1`.
 *
 * Fails closed on `setup()` because core relay `roleSchema` does not yet support
 * `--profile gemini` (installing an MCP registration that cannot start would break
 * the client). Use `previewSetup()` to inspect or test the planned config layout.
 */
export const geminiAdapter: ClientAdapter = {
  id: "gemini",
  displayName: "Gemini CLI (Experimental)",
  experimental: true,
  supportsRelayProfile: false,
  executable: "gemini",

  setup() {
    throw new Error(
      'Experimental adapter "gemini" cannot install an MCP registration yet because core relay roleSchema does not support "--profile gemini". ' +
      "Refusing to write unusable configuration. Use geminiAdapter.previewSetup() to inspect the reference layout.",
    );
  },

  previewSetup(context) {
    return buildGeminiEdits(context);
  },

  doctor(platform = process.platform) {
    return probeExecutableVersion(this.executable, platform);
  },

  launch(workspace, prompt, platform = process.platform) {
    return {
      command: platformCommand(this.executable, platform),
      args: prompt ? ["-p", prompt] : [],
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
    const result = geminiSessionInput.safeParse(payload);
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
