---
name: Bug report
about: A finding with the wrong severity, a missed change, or a crash
title: ""
labels: bug
assignees: ""
---

<!--
Severity bugs are the most valuable reports this project can get: a false
BREAKING is what gets the tool uninstalled, and a missed break is what it
exists to prevent. The payload pair below is what makes them reproducible.
-->

**Provider and event type**
<!-- e.g. stripe / charge.succeeded, github / push -->

**hookdrift version**
<!-- output of `npx hookdrift --version` -->

**Minimal payload pair**

Please redact real values — hookdrift only ever reasons about structure, so
placeholder values that keep the same *types and shapes* reproduce the bug
just as well. Two payloads is usually enough.

<details><summary>Payload the contract was inferred from</summary>

```json
{ }
```

</details>

<details><summary>Payload that produced the wrong result</summary>

```json
{ }
```

</details>

**Expected severity**
<!-- BREAKING / WARNING / INFO / no finding at all - and why -->

**Actual severity**
<!-- What hookdrift reported. Paste the finding line, or `hookdrift check --json` output. -->

**Anything else**
<!-- Relevant hookdrift.config.json (especially `ignore`, `minSamples`, `strict`), OS, Node version -->
