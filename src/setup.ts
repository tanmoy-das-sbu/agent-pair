import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  getAdapter,
  registrationFor,
  resolveConfigHome,
  type AdapterLookupOptions,
  type AdapterRegistration,
  type AdapterSetupEdit,
} from "./adapters/index.js";
import { pairRoles, type Role } from "./types.js";
import { dataDirectory } from "./workspace.js";

export type Registration = AdapterRegistration;
type Edit = AdapterSetupEdit;

export function registration(entry: string, role: string): Registration {
  return registrationFor(entry, role, dataDirectory());
}

function read(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

export function setupPlan(
  entry: string,
  profiles: readonly (Role | string)[] = pairRoles,
  options?: AdapterLookupOptions,
): Edit[] {
  const configHome = resolveConfigHome();
  const dataDir = dataDirectory();
  const skillContent = readFileSync(join(dirname(entry), "..", "skills", "agent-pair", "SKILL.md"), "utf8");
  return profiles.flatMap((profile) => {
    const adapter = getAdapter(profile, options);
    if (!adapter.supportsRelayProfile) {
      throw new Error(
        `Cannot configure "${adapter.id}": this experimental adapter does not yet have a supported core relay profile (--profile ${adapter.id}). Refusing to write unusable MCP configuration.`,
      );
    }
    return adapter.setup({
      entry,
      configHome,
      skillContent,
      dataDir,
      readFile: read,
      registration: registrationFor(entry, adapter.id, dataDir),
    });
  });
}

function replaceFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.agent-pair-${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function applySetup(plan: Edit[]): void {
  const changed = plan.filter((edit) => edit.content !== edit.original);
  const applied: Edit[] = [];
  try {
    for (const edit of changed) {
      if (read(edit.path) !== edit.original) throw new Error(`Config changed while setup was running: ${edit.path}`);
      if (edit.original !== undefined) {
        writeFileSync(`${edit.path}.agent-pair-${randomUUID()}.bak`, edit.original, { flag: "wx", mode: 0o600 });
      }
      replaceFile(edit.path, edit.content);
      applied.push(edit);
    }
  } catch (error) {
    const rollbackFailures = [];
    for (const edit of applied.reverse()) {
      try {
        if (read(edit.path) !== edit.content) throw new Error("Changed during setup");
        if (edit.original === undefined) rmSync(edit.path, { force: true });
        else replaceFile(edit.path, edit.original);
      } catch {
        rollbackFailures.push(edit.path);
      }
    }
    if (rollbackFailures.length) {
      throw new Error(`Setup stopped. Review the backups for: ${rollbackFailures.join(", ")}`, { cause: error });
    }
    throw error;
  }
}
