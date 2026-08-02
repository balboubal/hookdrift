# Security Policy

Please report vulnerabilities privately via [GitHub Security Advisories](https://github.com/balboubal/hookdrift/security/advisories/new) rather than a public issue.

## What hookdrift guarantees

Two properties are architectural, not incidental, and a break in either is a security bug worth reporting:

- **No network calls.** hookdrift reads local files and writes local files. There is no telemetry and no phone-home. This is enforced by [a test](test/no-network.test.ts) that boobytraps `fetch`, `http`, `https`, and raw sockets, then runs every command.
- **No payload values.** Contracts record field paths, types, formats, presence ratios, and small enum value sets — never the values of your payloads. If you can construct a payload whose values leak into a contract, `last-run.json`, or any output beyond the documented enum sets, that is a bug.

Reports against a supported release get an initial response within a few days.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | yes       |
