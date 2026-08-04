# Changelog

Notable changes per release. Dates are the publish date.

## 0.1.3 — unreleased

Response to an external production-readiness review. Every item below was
reproduced against the previous release before it was changed.

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
- New **`--fail-on-skipped`** and **`--fail-on-uncontracted`** (with config
  equivalents) turn coverage holes into failures. Defaults are unchanged.

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
