# stripe-live

A scratch directory for capturing **real** Stripe events and diffing two API
versions against each other. The fixtures are deliberately not committed: real
captures carry customer data, and contracts record object keys and enum values
verbatim (see [SECURITY.md](../../SECURITY.md)). You populate it yourself.

```bash
# terminal 1 - your account's current API version
stripe listen --format json > current.jsonl
# terminal 1 again, or a second listener - the newest version
stripe listen --latest --format json > target.jsonl

# terminal 2 - produce the events you actually consume
stripe trigger charge.succeeded

# split either capture into one file per event
node split-jsonl.mjs current.jsonl fixtures-current
node split-jsonl.mjs target.jsonl  fixtures-target

npx hookdrift infer fixtures-current   # contract from what you run today
npx hookdrift check fixtures-target    # does the target version still match it?
```

`hookdrift.config.json` here already points at `fixtures-{current,target}/**/*.json`,
because the optional directory argument filters that glob rather than replacing
it. Until you capture something, `check` correctly reports that nothing matched.
