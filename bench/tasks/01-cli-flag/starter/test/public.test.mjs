import assert from "node:assert/strict";
import test from "node:test";
import { formatSummary } from "../src/format.mjs";

test("formats text output", () => {
  assert.equal(formatSummary(["alpha"]), "Count: 1 (alpha)");
});
