# Contributing

Bug reports and reproductions are the most useful thing you can send.

## Working on it

```bash
npm ci
npm run build     # some tests exercise the compiled dist/cli.js
npm test
```

Node 20 or newer. CI runs the suite on Linux, Windows and macOS against Node 20
and 22 — filename handling depends on filesystem case-sensitivity and on Windows
reserved device names, so a Linux-only pass is not evidence.

## The one rule

**A defect does not exist until it reproduces.** Every fix in this repository
started as a failing case someone could run, and the commit that fixes it adds
that case to the suite. A pull request that changes behaviour without a test
demonstrating the old behaviour was wrong is very hard to review, and this
project has already shipped two "fixes" for problems that turned out not to
exist.

If you are reporting rather than fixing, the ideal issue is a payload (redacted
is fine — shape is what matters), the contract, the command you ran and what you
expected instead. `hookdrift check --json` output is usually enough.

## Scope

hookdrift compares webhook payloads on disk against a committed structural
contract. It deliberately does not:

- sit in the delivery path or validate at runtime — it cannot stop the first
  surprising payload, and [the README says so](README.md#honest-limitations);
- do AST analysis (`impact` is ranked text matching, and says so);
- make network calls of any kind. This is enforced by
  [a test](test/no-network.test.ts) and is not negotiable.

Changes that would alter contract format need a version bump and a migration
path — contracts are committed files in other people's repositories.

## Tests

`test/pathology.test.ts` documents behaviour that is **known to be wrong**
(ambiguous dotted paths, `items[]` collisions). Those assertions pin what
currently happens so a future fix is a visible, deliberate change. Do not
"fix" a pathology test by changing its expectation without changing the code.

## Security

Please report vulnerabilities privately — see [SECURITY.md](SECURITY.md).
