# Case study reproduction — Shopify, April 2026

Fixtures and code backing [`docs/case-study-shopify-april-2026.md`](../../docs/case-study-shopify-april-2026.md).

Reproduces the shape change from [Webhooks sometimes sent with wrong API version payload](https://community.shopify.dev/t/webhooks-sometimes-sent-with-wrong-api-version-payload/33251): `checkouts/update` webhooks pinned to API version `2025-07` intermittently arriving without the `id` field.

**The payloads are synthetic.** The shape mirrors a `checkouts/update` body; every value is invented and email addresses use the reserved `.invalid` domain. Nothing here came from a real store.

## Reproduce

```bash
node generate.mjs                        # writes all three fixture batches

npx hookdrift infer fixtures-before      # contract from payloads that all carry `id`
npx hookdrift check fixtures-after       # the incident: id missing from 7 of 24  -> WARNING, exit 0
npx hookdrift check fixtures-after --strict   # same finding, exit 1
npx hookdrift check fixtures-total       # contrast: id missing from all 24       -> BREAKING, exit 1
npx hookdrift impact                     # maps the last check's findings to src/checkout-handler.js
```

Run them in that order — `check` needs the contract from `infer`, and `impact` reads the findings the previous `check` wrote to `.hookdrift/last-run.json`.

## The three batches

| Batch | Payloads | With `id` | What it represents |
|---|---|---|---|
| `fixtures-before` | 24 | 24 | A healthy `2025-07` batch |
| `fixtures-after` | 24 | 17 | The incident — intermittent absence (29% missing) |
| `fixtures-total` | 24 | 0 | Not what happened; included so the severity difference is runnable |

`fixtures-after` is the interesting one. Because `id` still arrives most of the time, hookdrift reports `required -> optional` as a **WARNING**, not a removal — calling it BREAKING would assert something false. `fixtures-total` shows the same rule reaching BREAKING once absence is total and `p=0`.

## Files

- `generate.mjs` — deterministic generator; regenerating produces byte-identical fixtures
- `hookdrift.config.json` — `eventPath: "@dirname"`, because Shopify sends the topic in a header rather than the body
- `src/checkout-handler.js` — the consuming code `impact` searches; line 7 reads `payload.id`
