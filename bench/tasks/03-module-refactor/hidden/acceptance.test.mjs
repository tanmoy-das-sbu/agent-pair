import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const workspace = process.env.BENCH_WORKSPACE;
const { applyDiscount, calculateTax } = await import(pathToFileURL(join(workspace, "src", "tax.mjs")).href);
const { calculateInvoice } = await import(pathToFileURL(join(workspace, "src", "invoice.mjs")).href);

test("exports pure tax and discount helpers", () => {
  assert.equal(applyDiscount(100, 15), 85);
  assert.equal(calculateTax(85, 0.1), 8.5);
});

test("calculates rounded totals and rejects negative quantities", () => {
  const result = calculateInvoice(
    [{ qty: 3, unitPrice: 19.99 }],
    { discountPercent: 10, taxRate: 0.0825 },
  );
  assert.equal(result.subtotal, 59.97);
  assert.equal(result.discounted, 53.97);
  assert.equal(result.tax, 4.45);
  assert.equal(result.total, 58.42);
  assert.deepEqual(calculateInvoice([]), { subtotal: 0, discounted: 0, tax: 0, total: 0 });
  assert.throws(() => calculateInvoice([{ qty: -1, unitPrice: 10 }]));
});
