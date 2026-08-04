# Security Policy

Please report vulnerabilities privately via [GitHub Security Advisories](https://github.com/balboubal/hookdrift/security/advisories/new) rather than a public issue.

## What hookdrift guarantees

Two properties are architectural, not incidental, and a break in either is a security bug worth reporting:

- **No network calls.** hookdrift reads local files and writes local files. There is no telemetry and no phone-home. This is enforced by [a test](test/no-network.test.ts) that boobytraps `fetch`, `http`, `https`, and raw sockets, then runs every command.
- **No payload values, with three documented exceptions.** Contracts record field paths, types, formats, presence ratios — not the values in your payloads. If you can construct a payload whose values leak into a contract, `last-run.json`, or any output *other than the three cases below*, that is a bug worth reporting.

## What does get written, and why it matters

Three things that look like structure are, in some payloads, data. Read this before pointing hookdrift at payloads containing personal or secret material.

- **Object keys become path segments.** hookdrift flattens `{"a":{"b":1}}` to the path `a.b`. If a payload uses a *map keyed by data* — `usersByEmail`, `tokensById`, per-tenant metadata — those keys become contract paths, and contracts are committed to git. A payload like `{"usersByEmail": {"alice@example.com": …}}` produces the literal path `usersByEmail.alice@example.com`.
- **Enum values are stored verbatim.** After ≥ 30 string observations at a path with ≤ 12 distinct values, hookdrift records the values themselves so it can detect a new one appearing. A field that happens to repeat a small set of tenant names, internal environments, or identifiers will have those written into the contract. Values longer than 200 characters are never treated as enum members, so a large blob cannot be persisted this way.
- **The event name is a payload value.** `eventPath` names the field hookdrift reads the event type from, and that value becomes the contract's `event`, part of its filename, and part of every line of output. For a normal discriminator (`checkout.session.completed`) this is inert structure — but point `eventPath` at the wrong field and whatever it holds is written to disk.

`hookdrift infer` warns when a path segment or an event name looks like data rather than structure (an email, a `sk_`/`whsec_`-style prefix, a UUID, or a long opaque string). The check is a heuristic: it will not catch everything, and it is not a substitute for reading the diff.

All three are inherent to the current design rather than accidents, and none is fixed by redaction today. Until wildcard map support exists, the mitigations are: keep dynamic-map payloads out of your fixture corpus (or strip those subtrees before saving), and **review generated contracts before committing them** — they are plain JSON and diff cleanly in a pull request, which is the point at which anything unexpected is easiest to catch.

Two things that used to leak and no longer do, listed because you may be running an older release: JSON parse errors are reported as a category and position rather than the parser's own message, which quoted a slice of the file (0.1.3); and enum values had no length bound, so a multi-megabyte string was persisted whole (0.1.3).

## Running hookdrift on untrusted input

`check` on fixtures from an untrusted pull request is reasonable. `infer` is not: it writes files derived from that input. In CI, run the Action with least privilege (`permissions: pull-requests: write` and nothing else), no secrets in the job, and never `infer` on material a fork controls. hookdrift bounds what it will write — contract paths cannot escape `contractsDir` (including through symlinks), `contractsDir` itself cannot escape the project, and provider/event identities are length-bounded — but it does not yet bound total work: file count, payload size and path cardinality are unlimited, so a hostile corpus can still exhaust CI time.

Reports against a supported release get an initial response within a few days.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | yes       |
