# Changelog

Notable changes per release. Dates are the publish date.

## 0.1.3 — 2026-08-05

Response to two external production-readiness reviews, the second adversarial
and aimed at the fixes from the first. Every item below was reproduced before
it was changed.

### Storage identity is collision-resistant

- **Distinct events can no longer share a contract file.** The 6-character
  32-bit hash added earlier was collidable by hand rather than by search:
  `"/̀"` and `"?Đ"` both sanitized to `__` and both hashed to `1pt`,
  so two unrelated events silently merged into one plausible-looking contract
  and coverage reported two contracts checked against one file. Names are now
  disambiguated with 64 bits of SHA-256.
- **Case-only and reserved names are disambiguated too.** `Event` and `event`
  shared a file on Windows and macOS; `CON`, `PRN`, `COM1` and friends cannot
  be created on Windows at all. Only lowercase, filename-safe, non-reserved,
  bounded names keep their plain form — which is every real Stripe, Shopify and
  GitHub event, so existing contracts are untouched.
- **A contract file that holds a different identity than the one requested is
  refused** rather than merged. Any collision now fails loudly.
- **Provider and event identities are length-bounded** (200 characters; 64 for
  a provider). A 300-character event name previously aborted the entire run
  with a bare filesystem errno.
- **Every per-event failure in `infer` is isolated**, including errors from the
  write itself. One bad event no longer costs the inference of all the others.

### Containment is physical, not lexical

- `path.resolve` normalises `..` but does not follow symlinks, so a symlinked
  provider directory passed the containment check and wrote outside the tree.
  Real paths are now compared where they exist.
- `contractsDir` — the one path hookdrift writes to — must stay inside the
  project. An untrusted pull request could otherwise point it anywhere.

### Contracts cannot be internally contradictory

- Relations are validated, not just field types. A contract declaring
  `presence: 0` with `containCount: 100` of 100 samples was accepted, and the
  complete disappearance of that required field then came out as INFO with exit
  0 — a false green from a file that passed validation. Also rejected: counts
  above the sample total, enums on non-string fields, empty or duplicated
  enums, `enumAuthoritative` without an enum, `polymorphic` outside the
  string/object pair, and unparseable timestamps. Contracts written by earlier
  releases still load.

### Concurrent runs do not clobber each other

- `check` reports carry a `runId`. `impact` re-reads `last-run.json` before
  writing its references back and refuses to write when the id has changed —
  previously a clean check that finished during a scan was silently reverted to
  the older failing report, timestamp included.

### Privacy

- **Parse errors no longer quote the file.** Node's message for
  `{"token":sk_live_SECRET123}` embeds the payload; it was stored in
  `coverage.skipped` and printed. Replaced with a category and, where the
  parser supplies one, a line/column.
- **Enum values are length-bounded** (200 characters). Thirty observations of
  one 200,000-character string were persisted verbatim as a one-value enum.
- **`infer` warns when the event name itself looks like data** — it is a
  payload value, and it lands in the contract body and its filename.
- `SECURITY.md` documents three exceptions rather than two, and says plainly
  what is and is not bounded when running on untrusted input.

### Output and enforcement

- **Control and bidi characters are stripped from human output.** An event
  named `e\x1b[31mRED` reached the terminal byte-for-byte; `--json` still
  carries raw values for machine consumers.
- **`--version` and `help` reject unknown flags** like every other command.
- **`contractsChecked` counts comparisons that succeeded**, not attempts. A
  contract whose diff threw was still reported as checked.
- The enum-removal message no longer tells you to set `enumAuthoritative` when
  it is already set; it says which threshold was missed instead.

### GitHub Action

- **`impact` output can no longer break out of its code fence.** It was
  inserted raw inside a fixed ``` block, so an enum value containing a fence,
  `</details>`, a heading and a mention injected all three into the comment.
  The fence is now longer than any backtick run in the content, control bytes
  are stripped, and the volume is bounded by lines. The optional details block
  is dropped whole rather than sliced, so truncation cannot cut a fence in half.
- **`strict` must be exactly `true` or `false`.** `ture` silently meant false —
  the same fail-open as a mistyped `--strcit`.
- **The version input is validated against the SemVer 2.0.0 grammar.** The
  previous pattern accepted `1.2.3-..` and `1.2.3-01` and rejected valid
  `1.2.3+build.1`.
- New `fail-on-skipped`, `fail-on-uncontracted` and `fail-on-unexercised`
  inputs expose the coverage gates to CI.

### Honest reporting

- **A summary never claims health without naming the coverage hole.** With 9 of
  10 fixtures unreadable, `check` printed a bare
  `OK 1 contract(s) checked - no unsuppressed drift.` Both summary lines now
  carry the skipped count and point at `--fail-on-skipped`.
- **`explain` mirrors the exit code of the run it describes**, as `impact`
  already did. It exited 0 while printing BREAKING drift, so
  `hookdrift explain && deploy` deployed. *Behaviour change:* a script relying
  on `explain` always exiting 0 will now see 1 when the last check failed.
- **`check <dir>` that matches nothing names the directory argument.** It blamed
  only the config globs, which is the wrong thing to fix when the argument was
  what narrowed the run - and that is the README's headline upgrade workflow.
- Skipped-fixture notices print repo-relative paths, matching `--json`.
  Run-level findings render under `(run)` rather than a bare `/`.
- Exit codes are documented in `--help`: 0 nothing to fail a build, 1 drift or
  a run that checked nothing, 2 bad usage or config.

### Packaging and repository

- `prepack` builds, so a clean checkout packs the CLI. Previously only
  `prepublishOnly` did, leaving `npm pack` and git installs with a three-file
  package containing no `dist/`.
- **The contracts directory is seeded with a `.gitignore` for `last-run.json`.**
  The README says `git add .hookdrift`, and that directory holds both the
  contracts (meant to be committed) and the last check's transient report (not),
  so the documented command committed a file that then reappeared dirty after
  every run. An existing `.gitignore` is never overwritten.
- CI runs on Linux, Windows and macOS against Node 20 and 22. Contract filenames
  now depend on filesystem case-sensitivity and Windows reserved device names,
  so a Linux-only pass was no longer evidence.
- `prepare` builds too, so `npm install github:balboubal/hookdrift` gets a
  working binary instead of a package with no `dist/`.
- The README demo image showed `check ./fixtures`, which reports no drift; the
  output beside it comes from `check ./fixtures-drifted`. The image now shows
  the command that produces it, and `examples/demo`, `examples/stripe-live` and
  `examples/github-live` have READMEs explaining what they are.
- The no-network test now exercises `impact`, which README and SECURITY.md both
  claimed it covered.

### Known limits, unchanged

Ambiguous dotted paths (a literal `a.b` key collides with nested `a.b`), no
root-type node, no per-enum-value counts, no map/wildcard redaction, and no
manifest of *expected* events (the gates cover committed contracts and observed
events; an event that never got a contract and never appears in fixtures is
invisible to both). These need a versioned contract v2
with a migration and are not being rushed into a patch release. hookdrift
remains an advisory tool: use it to surface evidence and focus review, not as
the sole gate whose green run authorises production.

---

The first review's findings, all still in this release:

### Enforcement no longer fails open

- **Unknown flags and surplus arguments are rejected** (exit 2) instead of
  ignored. `check --strcit` previously ran non-strict and exited 0 — a safety
  flag that disappears on a typo is worse than no flag.
- **Provider and ignore-rule config objects are strict.** A typo'd `kinds` key
  was silently stripped, turning a kind-scoped ignore rule into one that
  suppressed *every* kind at that path, including BREAKING findings.
- **Provider names are restricted to filename-safe characters**, and contract
  paths are refused if they resolve outside `contractsDir`. A provider named
  `../escaped` wrote contracts outside `.hookdrift`.

### A green check can prove what it checked

- `last-run.json` and `--json` now carry a **`coverage` block**: files matched,
  files parsed, files skipped (with reasons), events observed, contracts
  checked, contracts unexercised, events uncontracted, and whether a directory
  argument made the run partial.
- New **`--fail-on-skipped`**, **`--fail-on-uncontracted`** and
  **`--fail-on-unexercised`** (with config equivalents) turn coverage holes
  into failures. Defaults are unchanged. The three together make a green run
  mean "every fixture parsed, every event had a contract, every contract was
  compared". Gate findings are deliberately not silenceable by ignore rules.

### Statistics match the evidence behind them

- **Contracts store an exact `containCount`.** Presence is rounded to 4dp for
  display, which made 19,999/20,000 persist as `1.0` and then report
  "required → optional" against the very corpus it was built from. Merging uses
  the exact count too, instead of reconstructing it from a rounded ratio.
- **BREAKING absence requires `minSamples` of baseline evidence.** A
  one-sample baseline yielded `p=0` and an instant BREAKING, which a single
  observation cannot support; below the threshold it caps at WARNING.
- **Enum removal is WARNING unless the enum is declared closed** via
  `"enumAuthoritative": true`. `enumConfidence` measures whether a path looks
  like an enum at all, not whether a specific value is gone: a value seen once
  in 1,000 observations is absent from 60 fresh samples ~94% of the time with
  nothing changed.

### Robustness

- Event names that sanitize identically (`a/b` and `a_b`) no longer share a
  contract file; a deterministic hash disambiguates. Filename-safe names are
  unchanged.
- Payload traversal is depth-bounded (512). A deeply nested payload died with
  an unattributed stack overflow; it is now reported against its event.
- Contracts and `last-run.json` are written via temp file + rename, so an
  interrupted or concurrent run cannot leave a truncated file.

### GitHub Action

- The CLI version input **defaults to an exact release, not `latest`**, and is
  validated against a semver grammar.
- Inputs reach the shell as environment variables rather than being
  interpolated into the command line.
- Payload-derived strings are **escaped before entering PR Markdown**, control
  characters stripped, values length-bounded, `@` neutralised.
- Comment lookup is paginated and requires a bot author.
- `impact` output is rendered only when it succeeded; the comment step is
  `continue-on-error` so a fork PR's read-only token cannot mask the result.

### Documentation

- `SECURITY.md` now states the two cases where payload data *does* reach a
  contract — object keys become path segments, and inferred enum values are
  stored verbatim — and `infer` warns when it writes paths that look like data.
- Runtime dependencies are pinned exactly.

## 0.1.2 — 2026-08-04

- Contract validation with per-contract isolation: one unreadable contract no
  longer aborts the run and loses other providers' findings.
- `__proto__` and other `Object.prototype` member names work as payload keys.
- UTF-16LE/BE fixture, config and contract files are read correctly.
- `impact` gained `--strict`, stopped crashing on zero-segment paths, and no
  longer duplicates references when re-run.
- `check` exits 1 when its globs match nothing; `explain` and `impact` mirror
  that state instead of reporting health.
- Polymorphic fields no longer accept types outside the string/object pair as
  INFO.
- Publishes are pinned to `registry.npmjs.org`.

## 0.1.1 — 2026-08-03

- Tolerate UTF-8 BOMs in config, fixtures and contracts.

## 0.1.0 — 2026-08-02

- First release: `init`, `infer`, `check`, `impact`, `explain`; evidence-scaled
  severities; ignore rules; JSON output; GitHub Action.
