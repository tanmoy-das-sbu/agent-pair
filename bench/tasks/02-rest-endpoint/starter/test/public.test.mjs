import assert from "node:assert/strict";
import test from "node:test";
import { ItemStore } from "../src/store.mjs";

test("starts empty", () => {
  const store = new ItemStore();
  assert.deepEqual(store.list(), []);
});
