import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function saveRun(directory: string, id: string, value: unknown): void {
  const root = join(directory, "runs");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = join(root, `${id}.json`);
  const temporary = join(root, `${id}.${process.pid}.tmp`);
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, file);
}

export function removeRun(directory: string, id: string): void {
  try { unlinkSync(join(directory, "runs", `${id}.json`)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export function loadRuns(directory: string): unknown[] {
  const root = join(directory, "runs");
  let names: string[];
  try { names = readdirSync(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return names.filter((name) => /^[a-f0-9-]{36}\.json$/.test(name)).map((name) => JSON.parse(readFileSync(join(root, name), "utf8")));
}
