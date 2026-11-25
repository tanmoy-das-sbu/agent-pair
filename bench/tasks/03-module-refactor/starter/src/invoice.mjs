export function calculateInvoice(items) {
  let subtotal = 0;
  for (const item of items) {
    subtotal += item.qty * item.unitPrice;
  }
  return { subtotal, total: subtotal };
}
