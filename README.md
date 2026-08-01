# hookdrift

**Detect when a third-party webhook payload changes shape — before it silently breaks your handler in production.**

Stripe adds a field. Shopify makes one nullable. GitHub renames a nested object. Delivery still succeeds, you still return 200, and you find out days later from a customer. hookdrift infers a structural contract from your saved webhook payloads, commits it to git, and fails CI when new payloads stop matching it.

![hookdrift demo](docs/demo.svg)

## Quickstart

```bash
# 1. Point it at a folder of saved webhook payloads (JSON, one per file)
npx hookdrift init
# edit hookdrift.config.json: set your fixtures glob and event field

# 2. Build contracts and commit them
npx hookdrift infer
git add .hookdrift && git commit -m "webhook contracts"

# 3. In CI (or whenever you save fresh payloads): diff against the contracts
npx hookdrift check          # exit 1 on breaking drift
npx hookdrift impact         # map findings to the code that reads those fields
```

A provider changing their payload now shows up as a **reviewable diff in a pull request**, with severity attached and the consuming code lines listed.

## What it detects

| Severity | Examples | Exit code |
|---|---|---|
| **BREAKING** | field removed; incompatible type change (`string → number`, scalar ↔ array); non-nullable field goes null; field moved (reported as a move, not delete+add); high-confidence enum value disappears | 1 |
| **WARNING** | required field becomes optional; **new enum value appears** (breaks exhaustive `switch`es — the classic silent failure); string format changes; integers-only field starts sending floats | 0 (1 with `--strict`) |
| **INFO** | new optional field; presence ratio shifts; type widening on polymorphic/expandable fields | 0 |

False-positive control is a design goal, not an afterthought:

- **Expandable fields** (Stripe-style: an ID string *or* the expanded object, depending on your own request params) are detected automatically — mixed shapes with ID-like strings get `"polymorphic": true` in the contract and never report as breaking.
- **Minimum-sample guards**: one missing payload is not evidence. Presence findings downgrade to INFO below `minSamples` (default 10); enum-removal is only BREAKING with ≥ 0.95 confidence and ≥ 50 new observations.
- **Ignore rules** with mandatory visibility: suppressed findings are counted in every summary (`2 breaking, 5 warnings (1 suppressed)`) and shown with `--show-suppressed`. Nothing is ever silently dropped.

## Config reference

`hookdrift.config.json`:

```jsonc
{
  "contractsDir": ".hookdrift",          // where contracts live (commit this)
  "providers": {
    "stripe": {
      "fixtures": "test/fixtures/stripe/**/*.json",
      "eventPath": "type"                // payload field holding the event name
    },
    "github": {
      "fixtures": "test/fixtures/github/**/*.json",
      "eventPath": "@dirname"            // GitHub sends the event in a header,
    }                                    // so use the fixture's folder name
  },
  "source": ["src/**/*.{ts,js,tsx}"],    // searched by `hookdrift impact`
  "strict": false,                       // warnings fail CI too
  "minSamples": 10,                      // below this, presence findings are INFO
  "ignore": [
    {
      "path": "data.object.metadata.**", // `*` = one segment, `**` = any depth
      "kind": "new_field",               // omit to suppress all kinds here
      "reason": "merchant-controlled free-form keys"
    }
  ]
}
```

Commands: `init` · `infer [dir]` (`--rebuild` to allow narrowing) · `check [dir]` (`--strict`, `--json`, `--show-suppressed`) · `impact` · `explain`.

## GitHub Action

```yaml
- uses: <org>/hookdrift@v1
  with:
    strict: false
```

Posts **one** PR comment, updated in place on re-runs. No findings → no comment. If a previous run reported drift that is now resolved, the existing comment is updated to say so.

## What this is *not*

- **Not webhook infrastructure.** No receiving, routing, queueing, retries, or replay — Hookdeck, Svix, and Convoy do that well. They monitor *delivery*; hookdrift monitors *shape*. A 200 response with a broken field looks healthy to them by design.
- **Not a schema registry or contract-testing framework.** Pact needs cooperation from the producer; you do not control Stripe.
- **Not a payload store.** Contracts contain field paths, types, formats, presence ratios, and small enum value sets — never payload values.

## Honest limitations

- **Fixture-based.** v1 diffs saved payloads on disk; it is only as current as your fixtures. Capture them from your test webhooks, replay logs, or provider CLI (e.g. `stripe listen`).
- **`impact` is textual matching**, not AST resolution. It will miss dynamic access (`payload[key]`) and can flag unrelated uses of common field names. Treat it as a ranked starting point.
- **Inference needs volume.** Enums require ≥ 30 observations; presence ratios stabilize with sample count. `infer` merges new samples and only ever widens — narrowing requires an explicit `--rebuild`.

## Zero network calls

hookdrift reads local files and writes local files. There is no telemetry, no phone-home, nothing. This is enforced by [a test](test/no-network.test.ts) that boobytraps `fetch`, `http`, `https`, and raw sockets and then runs every command.

## License

MIT
