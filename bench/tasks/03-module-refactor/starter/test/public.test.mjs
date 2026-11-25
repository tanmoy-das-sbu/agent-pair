import assert from "node:assert/strict";
import test from "node:test";
import { calculateInvoice } from "../src/invoice.mjs";

test("sums simple line items", () => {
  assert.equal(calculateInvoice([{ qty: 2, unitPrice: 5 }]).total, 10);
});
