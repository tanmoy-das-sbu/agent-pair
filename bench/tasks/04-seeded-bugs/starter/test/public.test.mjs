import assert from "node:assert/strict";
import test from "node:test";
import { JobQueue } from "../src/queue.mjs";

test("returns higher priority first", () => {
  const q = new JobQueue(5);
  q.push("low", 1);
  q.push("high", 5);
  assert.equal(q.pop(), "high");
});
