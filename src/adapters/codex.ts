import { join } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";
import {
  buildEdits,
  mergeSessionStartHooks,
  platformCommand,
  probeExecutableVersion,
  serverName,
  sessionContextMessage,
  type JsonObject,
} from "./helpers.js";
import type { AdapterRegistration, ClientAdapter } from "./types.js";

const begin = "# >>> Agent Pair managed MCP >>>";
const end = "# <<< Agent Pair managed MCP <<<";

const codexSessionInput = z.object({
  session_id: z.string().uuid(),
  cwd: z.string().max(4000),
});

function extractForeignCodexContent(managedBody: string): string {
  const lines = managedBody.split(/\r?\n/);
  const extraIndex = lines.findIndex((line) => {
    const trimmed = line.trim();
    return /^\[.+\]\s*(?:#.*)?$/.test(trimmed) && !trimmed.startsWith(`[mcp_servers.${serverName}]`);
  });
  return extraIndex < 0 ? "" : lines.slice(extraIndex).join("\n").trim();
}

function codexConfig(source: string | undefined, settings: AdapterRegistration): string {
  const current = source ?? "";
  const original = parse(current.replace(/^\uFEFF/, ""));
  const first = current.indexOf(begin);
  const last = current.indexOf(end);
  const servers = original.mcp_servers as JsonObject | undefined;
  if (first < 0 && servers?.[serverName]) {
    throw new Error("Codex already has an unmanaged agent_pair MCP registration.");
  }
  if ((first < 0) !== (last < 0) || (first >= 0 && last < first)) {
    throw new Error("The Codex Agent Pair MCP block is incomplete.");
  }

  const block = [
    begin,
    `[mcp_servers.${serverName}]`,
    `command = ${JSON.stringify(settings.command)}`,
    `args = ${JSON.stringify(settings.args)}`,
    "tool_timeout_sec = 40",
    `env = { AGENT_PAIR_DATA_DIR = ${JSON.stringify(settings.env.AGENT_PAIR_DATA_DIR)} }`,
    end,
  ].join("\n");
  let result: string;
  if (first >= 0) {
    const extra = extractForeignCodexContent(current.slice(first + begin.length, last));
    const after = current.slice(last + end.length);
    const tail = extra
      ? `\n\n${extra}${after.trim() ? `\n\n${after.trimStart()}` : "\n"}`
      : after;
    result = current.slice(0, first) + block + tail;
  } else {
    result = current.trimEnd() + (current.trim() ? "\n\n" : "") + block + "\n";
  }
  parse(result.replace(/^\uFEFF/, ""));
  return result;
}

export const codexAdapter: ClientAdapter = {
  id: "codex",
  displayName: "Codex",
  experimental: false,
  supportsRelayProfile: true,
  executable: "codex",

  setup(context) {
    const codexDir = (process.env.AGENT_PAIR_CONFIG_HOME ? undefined : process.env.CODEX_HOME)
      ?? join(context.configHome, ".codex");
    const codexSkill = join(context.configHome, ".agents", "skills", "agent-pair", "SKILL.md");
    return buildEdits([
      [join(codexDir, "config.toml"), (old) => codexConfig(old, context.registration)],
      [join(codexDir, "hooks.json"), (old) => mergeSessionStartHooks(old, context.entry, "codex", false)],
      [codexSkill, () => context.skillContent],
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
      args: ["resume", sessionId],
      cwd: workspace,
    };
  },

  discoverSessionId(payload) {
    const result = codexSessionInput.safeParse(payload);
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
