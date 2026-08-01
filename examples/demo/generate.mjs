// Deterministic fixture generator for the demo repo. Writes:
//   fixtures/stripe/*.json          36 realistic charge.succeeded events
//   fixtures/github/push/*.json     5 push events (event name from folder)
//   fixtures-drifted/...            the same providers after "the vendor shipped a change"
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const seed = (i) => {
  // mulberry32 — stable across runs so fixtures diff cleanly in git
  let a = 0x9e3779b9 ^ i;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];
const hex = (rnd, n) =>
  Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(rnd() * 16)]).join("");

function charge(i, drift = false) {
  const rnd = seed(i);
  const created = 1751328000 + i * 3600;
  const currencies = drift ? ["usd", "eur", "chf"] : ["usd", "eur", "gbp"];
  const amount = 500 + Math.floor(rnd() * 20) * 250;
  const obj = {
    id: `ch_3${hex(rnd, 22)}`,
    object: "charge",
    amount,
    amount_captured: drift && i % 3 === 0 ? amount + 0.5 : amount,
    amount_refunded: 0,
    balance_transaction: `txn_3${hex(rnd, 22)}`,
    billing_details: {
      address: { city: pick(rnd, ["London", "Paris", "Berlin"]), country: pick(rnd, ["GB", "FR", "DE"]) },
      email: drift ? `user${i}` : `user${i}@example.com`,
      name: `Customer ${i}`,
    },
    captured: true,
    created,
    currency: pick(rnd, currencies),
    customer: `cus_${hex(rnd, 14)}`,
    description: i % 4 === 0 ? null : `Order #${1000 + i}`,
    disputed: false,
    failure_code: null,
    failure_message: null,
    livemode: true,
    metadata: {},
    outcome: {
      network_status: "approved_by_network",
      reason: null,
      risk_level: "normal",
      seller_message: "Payment complete.",
      type: "authorized",
    },
    paid: drift && i === 4 ? null : true,
    payment_intent: `pi_3${hex(rnd, 22)}`,
    payment_method: `pm_1${hex(rnd, 22)}`,
    payment_method_details: {
      card: { brand: pick(rnd, ["visa", "mastercard", "amex"]), country: "US", last4: String(1000 + Math.floor(rnd() * 9000)) },
      type: "card",
    },
    receipt_email: rnd() < 0.6 ? `user${i}@example.com` : null,
    receipt_url: `https://pay.stripe.com/receipts/${hex(rnd, 32)}`,
    refunded: false,
    status: "succeeded",
  };
  if (drift) {
    if (i % 2 === 0) {
      // Expandable field: same field arrives expanded when the merchant's own
      // request asked for expansion. Should be INFO, not BREAKING.
      obj.balance_transaction = {
        id: obj.balance_transaction,
        object: "balance_transaction",
        amount: amount - 59,
        currency: obj.currency,
        fee: 59,
        net: amount - 118,
        status: "available",
      };
    }
    obj.totals = { amount_refunded: obj.amount_refunded }; // BREAKING: path moved
    delete obj.amount_refunded;
    obj.calculated_statement_descriptor = "EXAMPLE.COM"; // INFO: new field (suppressed via config ignore)
  }
  const evt = {
    id: `evt_1${hex(rnd, 22)}`,
    object: "event",
    api_version: "2026-06-30",
    created: created + 1,
    data: { object: obj },
    livemode: true,
    pending_webhooks: 1,
    request: { id: `req_${hex(rnd, 14)}`, idempotency_key: null },
    type: "charge.succeeded",
  };
  if (drift && i % 5 === 0) delete evt.pending_webhooks; // WARNING: required → optional
  return evt;
}

function push(i) {
  const rnd = seed(1000 + i);
  const sha = () => hex(rnd, 40);
  const commit = (n) => ({
    id: sha(),
    message: `commit ${n} of push ${i}`,
    timestamp: new Date((1751328000 + i * 7200 + n * 60) * 1000).toISOString(),
    author: { name: "Dev Eloper", email: "dev@example.com" },
  });
  const commits = Array.from({ length: 1 + (i % 3) }, (_, n) => commit(n));
  return {
    ref: "refs/heads/main",
    before: sha(),
    after: sha(),
    created: false,
    deleted: false,
    forced: i % 4 === 0,
    repository: {
      id: 987654321,
      name: "example-app",
      full_name: "example-org/example-app",
      private: true,
      owner: { name: "example-org", email: null },
    },
    pusher: { name: "dev-eloper", email: "dev@example.com" },
    commits,
    head_commit: commits[commits.length - 1],
  };
}

for (const dir of ["fixtures", "fixtures-drifted"]) {
  rmSync(join(root, dir), { recursive: true, force: true });
}
const write = (rel, data) => {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
};

for (let i = 0; i < 36; i++) write(`fixtures/stripe/charge-${String(i).padStart(2, "0")}.json`, charge(i));
for (let i = 0; i < 5; i++) write(`fixtures/github/push/push-${i}.json`, push(i));
for (let i = 0; i < 10; i++) write(`fixtures-drifted/stripe/charge-${String(i).padStart(2, "0")}.json`, charge(i, true));
for (let i = 0; i < 5; i++) write(`fixtures-drifted/github/push/push-${i}.json`, push(i));
console.log("fixtures written");
