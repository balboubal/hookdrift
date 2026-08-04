# demo

The example behind the animated SVG in the [root README](../../README.md). Everything here is generated, so you can reproduce the image's output exactly.

```bash
node generate.mjs                         # regenerate the payloads (optional; they are committed)
npx hookdrift infer ./fixtures            # contract from the "before" corpus
npx hookdrift check ./fixtures-drifted    # the drifted corpus - exit 1
```

`fixtures/` is the healthy corpus the committed contracts in `.hookdrift/` were built from — checking against it reports no drift and exits 0. `fixtures-drifted/` is the same events weeks later, carrying every finding kind the tool can produce: a moved field, a non-nullable field going null, a precision shift, a format change, an enum value gone and a new one arriving, a required field going optional, an expandable field, and a new subtree.

One finding is suppressed by the `ignore` rule in [hookdrift.config.json](hookdrift.config.json) — that is why the summary reads `(1 suppressed)`. Run with `--show-suppressed` to see it.

Two providers are configured to show both `eventPath` styles: Stripe carries the event name in the payload (`"eventPath": "type"`), GitHub sends it in a header, so fixtures go in a folder per event and the config uses `"@dirname"`.
