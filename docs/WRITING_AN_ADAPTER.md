# Writing a Client Adapter

Agent Pair isolates client-specific configuration, CLI probing, session launch/resume commands, and `SessionStart` hook parsing behind the `ClientAdapter` interface in `src/adapters/`.

Built-in stable adapters:

- `codex` (`src/adapters/codex.ts`)
- `antigravity` (`src/adapters/antigravity.ts`)
- `claude` (`src/adapters/claude.ts`)

Built-in experimental adapter:

- `gemini` (`src/adapters/gemini.ts`) — gated behind `--experimental-adapters` or `AGENT_PAIR_EXPERIMENTAL_ADAPTERS=1`.

## The `ClientAdapter` Contract

```ts
export type ClientAdapter = {
  readonly id: string;
  readonly displayName: string;
  readonly experimental: boolean;
  readonly executable: string;

  setup(context: AdapterSetupContext): AdapterSetupEdit[];
  doctor(platform?: NodeJS.Platform): string;
  launch(workspace: string, prompt?: string, platform?: NodeJS.Platform): AdapterCommandSpec;
  resume(sessionId: string, workspace: string, platform?: NodeJS.Platform): AdapterCommandSpec;
  discoverSessionId(payload: unknown): Record<string, unknown>;
};
```

### Required Invariants

1. **Idempotent `setup(context)`:** Running `setup()` a second time against its own output must produce zero diffs (`edit.content === edit.original`).
2. **Preserve foreign entries:** Never wipe unrelated MCP servers, hooks, or user settings in the client's config files.
3. **Fail closed on unmanaged collisions:** If a user already registered an unmanaged `agent_pair` MCP server or hook, throw a clear error instead of overwriting it.
4. **Cross-platform `launch` & `resume`:** Return `{ command, args, cwd }` using `platformCommand(executable, platform)` so Windows uses `.exe` and macOS/Linux use the bare binary name.
5. **Minimal `discoverSessionId(payload)`:** Validate the hook payload with Zod, extract only the session UUID and workspace path(s), never leak private fields such as `transcript_path`, and return `{}` on invalid payloads.

## Experimental Adapters

Adapters marked `experimental: true` are hidden from `listAdapters()` and rejected by `getAdapter(id)` unless explicitly enabled via:

- CLI flag: `--experimental-adapters` (when wired in `src/cli.ts`)
- Environment variable: `AGENT_PAIR_EXPERIMENTAL_ADAPTERS=1`
- Programmatic option: `{ includeExperimental: true }`

## Worked Example: Adding an Experimental Adapter (`myclient`)

Create `src/adapters/myclient.ts`:

```ts
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

const sessionPayload = z.object({
  session_id: z.string().uuid(),
  cwd: z.string().max(4000),
});

export const myClientAdapter: ClientAdapter = {
  id: "myclient",
  displayName: "MyClient CLI (Experimental)",
  experimental: true,
  executable: "myclient",

  setup(context) {
    const dir = join(context.configHome, ".myclient");
    return buildEdits([
      [
        join(dir, "settings.json"),
        (old) => {
          const withMcp = mergeJsonMcpConfig(old, context.registration, "myclient", { type: "stdio" });
          return mergeSessionStartHooks(withMcp, context.entry, "myclient", false);
        },
      ],
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
      args: ["--resume", sessionId],
      cwd: workspace,
    };
  },

  discoverSessionId(payload) {
    const parsed = sessionPayload.safeParse(payload);
    if (!parsed.success) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: sessionContextMessage({
          role: this.id,
          sessionId: parsed.data.session_id,
          workspacePaths: [parsed.data.cwd],
        }),
      },
    };
  },
};
```

### Registering and Testing Your Adapter

1. Register it in `src/adapters/registry.ts` (or dynamically with `registerAdapter(myClientAdapter)` in tests/plugins).
2. Add it to the adapter conformance suite in `test/adapters/conformance.test.mjs` with a sample hook payload and an unmanaged-conflict seed.
3. Run the conformance suite:

```powershell
npm run build
node --test test/adapters/conformance.test.mjs
```

### Note on Core Relay Profiles

The core MCP relay role enum (`src/types.ts`) restricts stable team roles to `codex`, `antigravity`, and `claude` by default. Experimental adapters can be previewed, configured (`setupPlan`), tested for hook capture (`captureSession`), and verified through the adapter registry and conformance suite without changing stable client behavior.
