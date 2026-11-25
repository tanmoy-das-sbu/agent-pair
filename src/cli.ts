#!/usr/bin/env node
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { captureSession } from "./capture.js";
import { openDashboardUrl } from "./dashboard.js";
import { relayCall, runBroker } from "./ipc.js";
import { launchResume, resumePlan } from "./resume.js";
import { applySetup, setupPlan } from "./setup.js";
import { pairRoles, requestSchema, roleSchema } from "./types.js";
import { workspaceRoot } from "./workspace.js";

const entry = fileURLToPath(import.meta.url);
const help = `Agent Pair connects fresh Codex, Antigravity, and Claude Code sessions in one workspace.

  agent-pair setup --dry-run   Preview skill, MCP, and hook configuration
  agent-pair setup --apply     Install into Codex and Antigravity by default
  agent-pair doctor           Check setup and the MCP message round trip
  agent-pair init             Create plan.md from the project template
  agent-pair dashboard        Open the live browser dashboard for active teams
  agent-pair resume <tag>     Open the bookmarked native sessions
  agent-pair close <run-id>   Close a live run
  agent-pair team-start --input <file> --profile <client>  Start a team from JSON
  agent-pair replay <run-id>  Open a recorded run in the dashboard
  agent-pair export <run-id>  Export a recorded run (--format json|html, --output <file>)
  agent-pair bench            Run the benchmark harness
  agent-pair adapters         List available client adapters

  Use --profiles codex,antigravity,claude with setup or doctor to select clients.
  Team start options: --enforce strict|warn|off, --isolation shared|worktree,
  --persist, --stall-timeout-ms <milliseconds>. Resume accepts --tmux.
  Use --experimental-adapters to enable experimental adapter discovery.
`;

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  if (command === "bench") {
    const [script, forwarded] = args[0] === "summarize" ? ["summarize.mjs", args.slice(1)] : ["runner.mjs", args];
    const result = spawnSync(process.execPath, [join(dirname(entry), "..", "bench", script as string), ...(forwarded as string[])], { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = result.status ?? 1;
    return;
  }
  const { values, positionals } = parseArgs({
    args, allowPositionals: true,
    options: {
      "dry-run": { type: "boolean" },
      apply: { type: "boolean" },
      "no-open": { type: "boolean" },
      profile: { type: "string" },
      profiles: { type: "string" },
      input: { type: "string" },
      enforce: { type: "string" },
      isolation: { type: "string" },
      persist: { type: "boolean" },
      "stall-timeout-ms": { type: "string" },
      "experimental-adapters": { type: "boolean" },
      tmux: { type: "boolean" },
      format: { type: "string" },
      output: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (command === "help" || command === "--help" || values.help) {
    console.log(help);
    return;
  }
  if (command === "--version") {
    const pkg = JSON.parse(readFileSync(join(dirname(entry), "..", "package.json"), "utf8"));
    console.log(pkg.version);
    return;
  }

  switch (command) {
    case "setup": {
      if (values.apply && values["dry-run"]) throw new Error("Select setup --dry-run or setup --apply.");
      const profiles = values.profiles === undefined ? pairRoles : [...new Set(values.profiles.split(",").map((value) => value.trim()))];
      const plan = setupPlan(entry, profiles, { includeExperimental: values["experimental-adapters"] });
      const changes = plan.filter((edit) => edit.original !== edit.content);
      for (const edit of changes) console.log(`${edit.original === undefined ? "Create" : "Update"} ${edit.path}`);
      if (values.apply) applySetup(plan);
      console.log(changes.length === 0 ? "Agent Pair is already configured."
        : values.apply ? "Setup applied. Open fresh sessions in the configured clients."
          : "Preview only. Run agent-pair setup --apply to write these files.");
      return;
    }
    case "doctor": {
      const { doctor } = await import("./doctor.js");
      for (const line of await doctor(entry, selectedProfiles(values.profiles), { includeExperimental: values["experimental-adapters"] })) console.log(line);
      return;
    }
    case "serve": {
      const { serve } = await import("./server.js");
      await serve(entry, roleSchema.parse(values.profile));
      return;
    }
    case "broker":
      await runBroker();
      return;
    case "adapters": {
      const { listAdapters } = await import("./adapters/index.js");
      for (const adapter of listAdapters({ includeExperimental: values["experimental-adapters"] })) {
        console.log(`${adapter.id}${adapter.experimental ? " (experimental)" : ""}${adapter.supportsRelayProfile ? "" : " (relay setup unavailable)"}`);
      }
      return;
    }
    case "capture-session":
      console.log(JSON.stringify(captureSession(roleSchema.parse(values.profile), JSON.parse(readFileSync(0, "utf8")))));
      return;
    case "close": {
      const request = requestSchema.parse({ action: "close", runId: positionals[0] });
      console.log(JSON.stringify(await relayCall(entry, request)));
      return;
    }
    case "team-start": {
      if (!values.input) throw new Error("Usage: agent-pair team-start --input <json-file> --profile <client>");
      const input = JSON.parse(readFileSync(values.input, "utf8"));
      const request = requestSchema.parse({ ...input, action: "teamStart", role: roleSchema.parse(values.profile),
        ...(values.enforce !== undefined ? { enforce: values.enforce } : {}),
        ...(values.isolation !== undefined ? { isolation: values.isolation } : {}),
        ...(values.persist !== undefined ? { persist: values.persist } : {}),
        ...(values["stall-timeout-ms"] !== undefined ? { stallTimeoutMs: Number(values["stall-timeout-ms"]) } : {}),
      });
      console.log(JSON.stringify(await relayCall(entry, request)));
      return;
    }
    case "replay": {
      if (positionals.length !== 1) throw new Error("Usage: agent-pair replay <run-id>");
      const { loadRunTimeline } = await import("./metrics/index.js");
      if (!loadRunTimeline(positionals[0])) throw new Error(`No recorded timeline found for run ${positionals[0]}.`);
      const result = await relayCall(entry, { action: "dashboard" }) as { url: string };
      const url = `${result.url}?replay=${encodeURIComponent(positionals[0])}`;
      if (!values["no-open"]) openDashboardUrl(url);
      console.log(url);
      return;
    }
    case "export": {
      if (positionals.length !== 1 || (values.format && !["json", "html"].includes(values.format))) throw new Error("Usage: agent-pair export <run-id> [--format json|html] [--output <file>]");
      const { writeRunExport } = await import("./metrics/index.js");
      console.log(JSON.stringify(writeRunExport(positionals[0], { format: values.format === "html" ? "html" : "json", outputPath: values.output })));
      return;
    }
    case "dashboard": {
      const result = await relayCall(entry, { action: "dashboard" }) as { url: string };
      if (!values["no-open"] && process.env.AGENT_PAIR_NO_DASHBOARD !== "1") {
        openDashboardUrl(result.url);
      }
      console.log(result.url);
      return;
    }
    case "resume": {
      if (positionals.length !== 1) throw new Error("Usage: agent-pair resume <tag>");
      const plan = resumePlan(positionals[0]);
      if (values["dry-run"]) console.log(JSON.stringify(plan, null, 2));
      else await launchResume(plan, { tmux: values.tmux });
      return;
    }
    case "init": {
      const workspace = workspaceRoot(process.cwd());
      const path = join(workspace, "plan.md");
      if (existsSync(path) || existsSync(join(workspace, "PLAN.md"))) {
        console.log("A plan already exists in this workspace.");
        return;
      }
      const template = readFileSync(join(dirname(entry), "..", "templates", "plan.md"), "utf8");
      writeFileSync(path, template, { flag: "wx" });
      console.log(`Created ${path}`);
      return;
    }
    default:
      throw new Error(`Unknown command ${command}. Run agent-pair --help.`);
  }
}

function selectedProfiles(option?: string) {
  if (option === undefined) return pairRoles;
  return [...new Set(option.split(",").map((value) => roleSchema.parse(value.trim())))];
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Agent Pair failed.");
  process.exitCode = 1;
});
