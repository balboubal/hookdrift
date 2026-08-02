---
title: A field disappeared from Shopify webhooks for two days and every monitor stayed green
published: false
tags: webhooks, shopify, api, testing
canonical_url: https://github.com/balboubal/hookdrift/blob/main/docs/case-study-shopify-april-2026.md
---

In April 2026, Shopify webhooks pinned to API version `2025-07` began intermittently arriving without the `id` field. Delivery succeeded. The HTTP headers said `2025-07`, as subscribed. Handlers returned 200. Nothing in the delivery path had anything to report, because from the delivery path's point of view nothing had gone wrong.

This is a walkthrough of that incident: what it looked like from the receiving end, why delivery monitoring cannot catch this class of failure by design, and a reproduction you can run against sanitized fixtures.

The incident is real and resolved. The primary source is the Shopify Developer Community thread [Webhooks sometimes sent with wrong API version payload](https://community.shopify.dev/t/webhooks-sometimes-sent-with-wrong-api-version-payload/33251). Everything attributed to Shopify below is quoted from it.

---

## What it looked like

On 13 April 2026, a developer posting as `mropanen` opened a thread reporting that `checkouts/update` webhooks were "intermittently arriving with the wrong API version payload."

Reconstruct the order in which they'd have encountered it:

**First, nothing.** Webhooks arrive. The endpoint returns 200. Delivery dashboards show a healthy success rate, because every delivery genuinely succeeded.

**Then, data that is quietly wrong.** Some fraction of `checkouts/update` payloads arrive without `id`. A handler that reads `payload.id` to reconcile against its own records now gets `undefined`. It doesn't throw — reading a missing property from a JavaScript object is legal and yields `undefined`. Whatever it writes is keyed on nothing. The row stops updating. No exception, no 500, no retry, because as far as HTTP is concerned the request was handled.

**Then, the confusing part.** The request metadata contradicts the payload:

```
x-shopify-api-version:  2025-07
x-shopify-topic:        checkouts/update
x-shopify-event-id:     00000000-0000-4000-8000-000000000001
x-shopify-triggered-at: 2026-04-10T14:13:05.000000000Z
```

The version header says `2025-07`, exactly the version subscribed to — while the body arrives shaped like a different version. So the obvious hypothesis, "someone changed our API version," is disproved by the first thing you check. And the failure is *intermittent*: some payloads have `id`, some don't. That rules out the second hypothesis too, since a version change would be uniform.

At this point you are debugging a payload that is correct according to its own metadata, wrong only sometimes, and failing in a way that produces no errors anywhere.

**Then, the cause.** A Shopify staff member, `Donal-Shopify`, replied on 14 April explaining the mechanism:

> If a store happens to have another subscription for the same topic that resolves to 2026-04, the `id` removal applies to all subscriptions on that store, regardless of the version they're actually pinned to.

`id` was removed from this payload in API version `2026-04`. If a store had *any* subscription for that topic resolving to `2026-04`, the removal leaked across every subscription on the store — including ones explicitly pinned to `2025-07`. The intermittency wasn't randomness in the payload; it was which subscription happened to serve a given delivery.

**Then, resolution.** On 15 April, Shopify confirmed a fix had been deployed and was rolling out.

The thread is resolved. This is not an open problem with Shopify, and the point of writing it up is not that Shopify shipped a bug — everyone ships bugs. The point is the *shape* of the failure, which recurs across providers and is structurally invisible to the tooling most teams have pointed at their webhooks.

## Why delivery monitoring cannot catch this

Webhook infrastructure — Hookdeck, Svix, Convoy, and the retry logic most teams write themselves — monitors delivery. It answers: did the request arrive, what status came back, how long did it take, does it need retrying?

For this incident, every one of those answers was good. The request arrived. The status was 200. It was fast. Nothing needed retrying.

That isn't a gap in those products; it's their contract. A 200 response *is* the consumer asserting it handled the payload. The delivery layer has no model of what the payload should contain and no knowledge of which fields your code reads. It cannot distinguish "handled correctly" from "handled a payload missing a field the handler needed," because the only signal it has is the status code, and your handler returned 200 in both cases.

The failure is one layer up: the payload's *shape* changed, and nothing was checking shape.

Nor would schema validation at the edge necessarily have helped, unless someone had written a schema asserting `id` is required and kept it current with the version they were pinned to. That's the work almost nobody does by hand, because it means maintaining a parallel description of every payload you consume.

## Reproducing it

The reproduction below uses synthetic payloads shaped like `checkouts/update`. Every value is invented and email addresses use the reserved `.invalid` domain; nothing came from a real store. Fixtures and the generator are in [`examples/case-study-shopify`](https://github.com/balboubal/hookdrift/tree/main/examples/case-study-shopify).

Two batches, 24 payloads each:

- **before** — every payload has `id`, as a `2025-07` payload should
- **after** — `id` missing from 7 of 24 (29%), matching the intermittency reported

Build a contract from the good batch:

```
$ npx hookdrift infer fixtures-before

shopify/checkouts_update: created (24 new sample(s), 24 total, 55 paths)

1 contract(s) in .hookdrift/ — commit them to git.
```

That contract is a file you commit. It records, among 55 paths, that `id` appeared in 24 of 24 samples.

Now check the drifted batch against it:

```
$ npx hookdrift check fixtures-after

shopify/checkouts_update
  WARNING   id  required -> optional: present in 24/24 contract samples but only 17/24 new samples

0 breaking, 1 warning(s), 0 info across 1 contract(s)
```

**WARNING, not BREAKING — and exit code 0.** That deserves explanation rather than defence, because it's the honest output and the interesting one.

The field did not disappear. It appeared in 17 of 24 payloads. A tool that called this BREAKING would be asserting the field was removed, which is false — and the same rule would then fire every time an optional field happened to be absent from a small sample, which is how a checker earns a permanent place in everyone's ignore list. What actually changed is that a field which was always present became sometimes-present. That is precisely a warning.

For teams that want any such change to stop a deploy, `--strict` promotes warnings to failures:

```
$ npx hookdrift check fixtures-after --strict

0 breaking, 1 warning(s), 0 info across 1 contract(s) [strict]
$ echo $?
1
```

By contrast, had `id` gone missing from *every* payload, the same rule reaches a different conclusion:

```
$ npx hookdrift check fixtures-total

shopify/checkouts_update
  BREAKING  id  absent from all 24 new sample(s); contract presence 1 (24/24 samples),
                so absence across 24 sample(s) is p=0 by chance

1 breaking, 0 warning(s), 0 info across 1 contract(s)
```

Same field, same contract, different evidence, different severity.

### Which code is affected

Knowing a field changed is half an answer. The other half is which lines read it:

```
$ npx hookdrift impact

shopify/checkouts_update
  WARNING   id  required -> optional: present in 24/24 contract samples but only 17/24 new samples
            referenced in:
              src/checkout-handler.js:7
              src/checkout-handler.js:9

Searched 1 file(s). Note: this is textual matching, not AST analysis - it will miss
dynamic access (payload[key]) and may flag unrelated uses of common field names.
```

Line 7 is `const checkoutId = payload.id;` — the line that starts returning `undefined`.

Line 9 is a comment containing the word "id". That is a false positive, and it is left in this write-up deliberately: the matching is textual, ranked by how much of the path matched, not resolved through the AST. It will miss `payload[key]` entirely and it will flag prose. It's a ranked starting point for a human, not a proof.

## The case where the timing works: version upgrades

The reproduction above is a post-mortem. The same three commands run *before* a deploy when both payload sets already exist — which is exactly the situation during a provider API-version upgrade, and both major providers hand you the fixtures.

**Shopify** ships a CLI that generates a webhook payload for any API version you name, so you can produce a batch for your current version and a batch for the one you're moving to without touching production.

**Stripe's** [versioning guide](https://docs.stripe.com/webhooks/versioning) recommends running old and new webhook endpoints in parallel through an upgrade. That gives you two batches from real traffic, on the same events, at the same time.

Either way the workflow is the same:

```
npx hookdrift infer  fixtures-current-version    # contract from what you consume today
npx hookdrift check  fixtures-new-version        # what changes if you upgrade
npx hookdrift impact                             # which of your code reads those fields
```

The output is a list of every field that moved, vanished, changed type, or became nullable between the two versions, mapped to the lines that read them — produced while the upgrade is still a branch. That is the case where a fixture-based tool is genuinely preventative rather than diagnostic, and it recurs on a schedule rather than waiting for a vendor bug.

## What this does not do

hookdrift compares payloads that are already on disk. For a *surprise* change that timing matters, and stating it plainly is more useful than a caveat in a footer:

**An unannounced change reaches production before it reaches your fixtures.** Nothing fixture-based would have stopped the first `id`-less checkout from hitting that handler. What changes is the diagnosis path — from "our abandoned-checkout rows look wrong, why?" to a named field, a measured frequency, and two line numbers. In this incident that's the difference between reading webhook bodies by hand and reading one line of output.

Note also what the contract contains: field paths, types, formats, presence ratios, and small enumerated value sets. Not values. The reproduction above never needed a real payload, because shape is all the comparison uses.

## This isn't one vendor

On 8 August 2025, GitHub [announced changes to Activity Events API payloads](https://github.blog/changelog/2025-08-08-upcoming-changes-to-github-events-api-payloads/), effective 7 October 2025 with a brownout test on 8 September. `author_association` was removed from seven event types — Pull Request, Pull Request Review, Pull Request Review Comment, Issue, Issue Comment, Commit Comment, and Discussion — along with commit summaries and counts from Push events. GitHub's stated rationale was smaller payloads and faster responses, and it noted the removed fields remain available through the main REST API.

One distinction worth being precise about, because it's easy to get wrong: **that changelog covers the Events API, not webhooks.** It has been cited as a webhook change and it isn't one. It belongs here for a different reason — it's the same failure shape from the consumer's side. A field your code reads stops being sent. Your requests keep succeeding. If you were reading `author_association` to decide whether a commenter was a maintainer, that logic quietly starts evaluating `undefined`.

The difference is that GitHub announced it, twice, with a brownout. Shopify's was a bug and nobody could announce it. Both leave you in the same position: consuming a payload whose shape no longer matches what your code assumes, with no error to alert on.

## What generalizes

**Delivery monitoring and shape monitoring answer different questions.** "Did it arrive?" and "was it the shape my code expects?" are independent, and the first being healthy tells you nothing about the second. Most teams monitor the first and assume the second. A 200 response is your own code's assertion that it coped — it is not evidence that it did.

**Presence has to be statistical, not binary.** This is the part that decides whether a shape checker is usable. An optional field absent from a small batch is not evidence of removal, and treating it as such produces alerts that get muted, after which the tool detects nothing at all because nobody reads it.

The workable version is to ask how surprising the absence is given how often the field was seen before. If a field appeared in 24 of 24 samples and is now absent from all 24, the probability of that under "nothing changed" is effectively zero, and BREAKING is warranted. If it appeared in 5 of 21 samples and is missing from the next 6, the probability is about 0.2 — a one-in-five coincidence, which is not a finding at all. hookdrift computes `(1 - presence)^N` and grades severity from it; the specific thresholds matter less than refusing to treat every absence as equally meaningful.

And the intermittent case — this incident — is neither. The field is still arriving, just not always. Reporting that as a removal would be wrong; reporting nothing would miss a real regression. It is a required field becoming optional, which is its own finding with its own severity.

---

*Reproduction: [`examples/case-study-shopify`](https://github.com/balboubal/hookdrift/tree/main/examples/case-study-shopify) — `node generate.mjs`, then `npx hookdrift infer fixtures-before` and `npx hookdrift check fixtures-after`. hookdrift is MIT-licensed and makes no network calls; [the repo](https://github.com/balboubal/hookdrift) has the details.*
