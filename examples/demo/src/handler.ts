// Demo consumer code: this is what `hookdrift impact` searches to answer
// "which of my code reads the field that just drifted?"
export function onChargeSucceeded(payload: any) {
  const refunded = payload.data.object.amount_refunded;
  const pending = payload.pending_webhooks ?? 0;
  switch (payload.data.object.currency) {
    case "usd":
    case "eur":
    case "gbp":
      break;
  }
  return { refunded, pending, paid: payload.data.object.paid };
}
