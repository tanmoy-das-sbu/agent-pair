import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

const workspace = process.env.BENCH_WORKSPACE;
const cli = join(workspace, "src", "cli.mjs");

test("supports default text output", () => {
  const out = execFileSync(process.execPath, [cli, "one", "two"], { encoding: "utf8" }).trim();
  assert.equal(out, "Count: 2 (one, two)");
});

test("supports --format json output", () => {
  const out = execFileSync(process.execPath, [cli, "--format", "json", "one", "two"], { encoding: "utf8" }).trim();
  assert.deepEqual(JSON.parse(out), { count: 2, items: ["one", "two"] });
});

test("rejects unsupported format with non-zero exit", () => {
  const result = spawnSync(process.execPath, [cli, "--format", "xml", "one"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
});
