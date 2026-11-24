#!/usr/bin/env node
import { readFileSync, existsSync, writeFileSync } from "node:fs";
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

  Use --profiles codex,antigravity,claude with setup or doctor to select clients.
`;

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args, allowPositionals: true,
    options: {
      "dry-run": { type: "boolean" },
      apply: { type: "boolean" },
      "no-open": { type: "boolean" },
      profile: { type: "string" },
      profiles: { type: "string" },
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
      const plan = setupPlan(entry, selectedProfiles(values.profiles));
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
      for (const line of await doctor(entry, selectedProfiles(values.profiles))) console.log(line);
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
    case "capture-session":
      console.log(JSON.stringify(captureSession(roleSchema.parse(values.profile), JSON.parse(readFileSync(0, "utf8")))));
      return;
    case "close": {
      const request = requestSchema.parse({ action: "close", runId: positionals[0] });
      console.log(JSON.stringify(await relayCall(entry, request)));
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
      else await launchResume(plan);
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
