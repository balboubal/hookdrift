// The consuming code. This is what `hookdrift impact` searches: the point is to
// answer "which of my lines read the field that changed?" rather than just
// "something changed".

export async function onCheckoutUpdate(payload) {
  // Reads the field that went missing during the April 2026 incident.
  const checkoutId = payload.id;

  // A checkout without an id cannot be reconciled against our own record, so
  // this row silently stops updating - no throw, no 500, no alert.
  await upsertAbandonedCheckout({
    shopifyCheckoutId: checkoutId,
    email: payload.email,
    total: payload.total_price,
    updatedAt: payload.updated_at,
  });

  return { ok: true };
}

async function upsertAbandonedCheckout(row) {
  if (!row.shopifyCheckoutId) {
    // In the real failure mode this branch is not even present: the write just
    // goes ahead with undefined and the row never matches again.
    return;
  }
  // ... persist
}
