// Reproduces the shape change from the April 2026 Shopify incident:
// https://community.shopify.dev/t/webhooks-sometimes-sent-with-wrong-api-version-payload/33251
//
// checkouts/update webhooks pinned to API version 2025-07 intermittently arrived
// without the `id` field, because a co-existing subscription resolving to
// 2026-04 applied that version's `id` removal across the whole store.
//
// Payloads here are SYNTHETIC. The shape mirrors a Shopify checkouts/update
// body; every value is invented. Nothing here came from a real store.
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

// Deterministic PRNG so the fixtures are stable across regenerations.
const seeded = (i) => {
  let a = 0x9e3779b9 ^ i;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const pick = (r, xs) => xs[Math.floor(r() * xs.length)];
const hex = (r, n) =>
  Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(r() * 16)]).join("");

/** @param withId whether the `id` field is present - the whole point of the case study */
function checkout(i, withId) {
  const r = seeded(i);
  const created = new Date(Date.UTC(2026, 3, 10, 8, 0, 0) + i * 3_600_000).toISOString();
  const price = (20 + Math.floor(r() * 180)).toFixed(2);
  const body = {
    // `id` is deliberately omitted for the drifted samples.
    ...(withId ? { id: 30000000000000 + i * 7717 } : {}),
    token: hex(r, 32),
    cart_token: hex(r, 32),
    email: `customer${i}@example.invalid`,
    gateway: null,
    buyer_accepts_marketing: i % 3 === 0,
    created_at: created,
    updated_at: created,
    landing_site: "/",
    note: null,
    currency: "USD",
    presentment_currency: "USD",
    completed_at: null,
    closed_at: null,
    phone: null,
    source_name: pick(r, ["web", "shopify_draft_order"]),
    abandoned_checkout_url: `https://example-store.myshopify.com/checkouts/${hex(r, 32)}`,
    total_price: price,
    subtotal_price: price,
    total_tax: "0.00",
    total_discounts: "0.00",
    total_line_items_price: price,
    line_items: [
      {
        key: hex(r, 16),
        product_id: 8000000000000 + i,
        variant_id: 4400000000000 + i,
        sku: `SKU-${1000 + i}`,
        vendor: "Example Vendor",
        title: `Example Product ${i}`,
        variant_title: pick(r, ["Small", "Medium", "Large"]),
        quantity: 1 + Math.floor(r() * 3),
        price,
        grams: 200 + Math.floor(r() * 800),
        requires_shipping: true,
        taxable: true,
        gift_card: false,
      },
    ],
    customer: {
      id: 6000000000000 + i,
      email: `customer${i}@example.invalid`,
      first_name: "Example",
      last_name: "Customer",
      state: "disabled",
      currency: "USD",
      created_at: created,
    },
    shipping_address: {
      first_name: "Example",
      last_name: "Customer",
      address1: `${100 + i} Example Street`,
      city: pick(r, ["Portland", "Austin", "Denver"]),
      province: pick(r, ["Oregon", "Texas", "Colorado"]),
      country: "United States",
      zip: String(10000 + i * 7),
      phone: null,
      province_code: null,
    },
  };
  return body;
}

const write = (rel, data) => {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
};

for (const d of ["fixtures-before", "fixtures-after", "fixtures-total"]) {
  rmSync(join(root, d), { recursive: true, force: true });
}

const N = 24;
// Before: every payload carries `id`, as a 2025-07 payload should.
for (let i = 0; i < N; i++) {
  write(`fixtures-before/shopify/checkouts_update/${String(i).padStart(2, "0")}.json`, checkout(i, true));
}
// After: `id` missing from 7 of 24 - intermittent, as reported in the thread.
const missing = new Set([2, 5, 9, 13, 16, 20, 23]);
for (let i = 0; i < N; i++) {
  write(
    `fixtures-after/shopify/checkouts_update/${String(i).padStart(2, "0")}.json`,
    checkout(i, !missing.has(i)),
  );
}

// Contrast batch: `id` missing from every payload. Not what happened - included
// so the difference between "sometimes absent" and "gone" is runnable, not just
// asserted.
for (let i = 0; i < N; i++) {
  write(`fixtures-total/shopify/checkouts_update/${String(i).padStart(2, "0")}.json`, checkout(i, false));
}

console.log(`before: ${N} payloads, all with id`);
console.log(`after:  ${N} payloads, ${missing.size} missing id (${Math.round((missing.size / N) * 100)}%)`);
console.log(`total:  ${N} payloads, none with id (contrast case, not the incident)`);
