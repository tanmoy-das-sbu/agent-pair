import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const workspace = process.env.BENCH_WORKSPACE;
const { JobQueue } = await import(pathToFileURL(join(workspace, "src", "queue.mjs")).href);
const { backoffDelay } = await import(pathToFileURL(join(workspace, "src", "retry.mjs")).href);

test("enforces exact maxSize without off-by-one", () => {
  const q = new JobQueue(2);
  q.push("a", 1);
  q.push("b", 1);
  assert.throws(() => q.push("c", 1), /capacity/i);
});

test("preserves FIFO order for equal priorities", () => {
  const q = new JobQueue(5);
  q.push("first", 2);
  q.push("second", 2);
  q.push("third", 2);
  assert.equal(q.pop(), "first");
  assert.equal(q.pop(), "second");
  assert.equal(q.pop(), "third");
});

test("caps exponential backoff at maxDelayMs", () => {
  assert.equal(backoffDelay(0, 100, 500), 100);
  assert.equal(backoffDelay(2, 100, 500), 400);
  assert.equal(backoffDelay(3, 100, 500), 500);
  assert.equal(backoffDelay(10, 100, 500), 500);
});
