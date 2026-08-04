# Security Policy

Please report vulnerabilities privately via [GitHub Security Advisories](https://github.com/balboubal/hookdrift/security/advisories/new) rather than a public issue.

## What hookdrift guarantees

Two properties are architectural, not incidental, and a break in either is a security bug worth reporting:

- **No network calls.** hookdrift reads local files and writes local files. There is no telemetry and no phone-home. This is enforced by [a test](test/no-network.test.ts) that boobytraps `fetch`, `http`, `https`, and raw sockets, then runs every command.
- **No payload values, with two documented exceptions.** Contracts record field paths, types, formats, presence ratios — not the values in your payloads. If you can construct a payload whose values leak into a contract, `last-run.json`, or any output *other than the two cases below*, that is a bug worth reporting.

## What does get written, and why it matters

Two things that look like structure are, in some payloads, data. Read this before pointing hookdrift at payloads containing personal or secret material.

- **Object keys become path segments.** hookdrift flattens `{"a":{"b":1}}` to the path `a.b`. If a payload uses a *map keyed by data* — `usersByEmail`, `tokensById`, per-tenant metadata — those keys become contract paths, and contracts are committed to git. A payload like `{"usersByEmail": {"alice@example.com": …}}` produces the literal path `usersByEmail.alice@example.com`.
- **Enum values are stored verbatim.** After ≥ 30 string observations at a path with ≤ 12 distinct values, hookdrift records the values themselves so it can detect a new one appearing. A field that happens to repeat a small set of tenant names, internal environments, or identifiers will have those written into the contract.

Both are inherent to the current design rather than accidents, and neither is fixed by redaction today. Until wildcard map support exists, the mitigations are: keep dynamic-map payloads out of your fixture corpus (or strip those subtrees before saving), and **review generated contracts before committing them** — they are plain JSON and diff cleanly in a pull request, which is the point at which anything unexpected is easiest to catch.

Reports against a supported release get an initial response within a few days.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | yes       |
