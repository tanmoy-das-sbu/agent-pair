import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const workspace = process.env.BENCH_WORKSPACE;
const { createApp } = await import(pathToFileURL(join(workspace, "src", "server.mjs")).href);

test("serves /health, creates items via POST /items, lists via GET /items, and rejects invalid payloads", async (t) => {
  const server = createApp();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });

  const created = await fetch(`${base}/items`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "sprocket" }),
  });
  assert.equal(created.status, 201);
  const item = await created.json();
  assert.equal(item.name, "sprocket");

  const list = await fetch(`${base}/items`);
  assert.equal(list.status, 200);
  const body = await list.json();
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].name, "sprocket");

  const invalid = await fetch(`${base}/items`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{bad json",
  });
  assert.equal(invalid.status, 400);
});
