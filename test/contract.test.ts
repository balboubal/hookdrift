import { describe, expect, it } from "vitest";
import { observe } from "../src/core/observe.js";
import { buildContract, mergeContract } from "../src/core/contract.js";

const T0 = "2026-07-01T00:00:00.000Z";
const T1 = "2026-07-31T00:00:00.000Z";

describe("mergeContract — merging only widens", () => {
  it("raises samplesObserved and recomputes presence over the combined total", () => {
    const old = buildContract("p", "e", observe([{ a: 1, b: 2 }, { a: 1, b: 2 }]), T0);
    const merged = mergeContract(old, observe([{ a: 1 }, { a: 1 }]), T1);
    expect(merged.samplesObserved).toBe(4);
    expect(merged.fields["a"]!.presence).toBe(1);
    expect(merged.fields["b"]!.presence).toBe(0.5); // 2/4 — unseen in new batch
    expect(merged.firstSeen).toBe(T0);
    expect(merged.lastUpdated).toBe(T1);
  });

  it("widens type sets and never removes a type", () => {
    const old = buildContract("p", "e", observe([{ v: "s" }]), T0);
    const merged = mergeContract(old, observe([{ v: 1 }]), T1);
    expect(merged.fields["v"]!.types).toEqual(["string", "number"]);
    // New batch shows only number; the old string claim must survive.
    const again = mergeContract(merged, observe([{ v: 2 }]), T1);
    expect(again.fields["v"]!.types).toEqual(["string", "number"]);
  });

  it("keeps nullable once observed", () => {
    const old = buildContract("p", "e", observe([{ v: null }]), T0);
    const merged = mergeContract(old, observe([{ v: "x" }]), T1);
    expect(merged.fields["v"]!.nullable).toBe(true);
  });

  it("drops a format claim when contradicted, never adds one to an existing path", () => {
    const old = buildContract("p", "e", observe([{ d: "2026-07-01" }]), T0);
    expect(old.fields["d"]!.format).toBe("iso8601");
    const contradicted = mergeContract(old, observe([{ d: "nope" }]), T1);
    expect(contradicted.fields["d"]!.format).toBeUndefined();
    // Once dropped it stays dropped even if new values would match again.
    const again = mergeContract(contradicted, observe([{ d: "2026-07-02" }]), T1);
    expect(again.fields["d"]!.format).toBeUndefined();
  });

  it("widens enum value sets and drops the claim past the cap", () => {
    const mk = (vals: string[], n: number) =>
      Array.from({ length: n }, (_, i) => ({ c: vals[i % vals.length] }));
    const old = buildContract("p", "e", observe(mk(["usd", "eur"], 40)), T0);
    expect(old.fields["c"]!.enum).toEqual(["eur", "usd"]);

    const widened = mergeContract(old, observe(mk(["gbp"], 5)), T1);
    expect(widened.fields["c"]!.enum).toEqual(["eur", "gbp", "usd"]);

    const flood = Array.from({ length: 20 }, (_, i) => ({ c: `x${i}` }));
    const dropped = mergeContract(old, observe(flood), T1);
    expect(dropped.fields["c"]!.enum).toBeUndefined();
  });

  it("never adds an enum claim to an existing non-enum path", () => {
    // 20 samples: below the enum threshold, no claim.
    const mk = (n: number) => Array.from({ length: n }, () => ({ c: "usd" }));
    const old = buildContract("p", "e", observe(mk(20)), T0);
    expect(old.fields["c"]!.enum).toBeUndefined();
    // 20 more would cross the threshold on a rebuild — but merge must not narrow.
    const merged = mergeContract(old, observe(mk(20)), T1);
    expect(merged.fields["c"]!.enum).toBeUndefined();
  });

  it("adds new paths with presence over the combined total", () => {
    const old = buildContract("p", "e", observe([{ a: 1 }, { a: 1 }, { a: 1 }]), T0);
    const merged = mergeContract(old, observe([{ a: 1, fresh: true }]), T1);
    expect(merged.fields["fresh"]!.presence).toBe(0.25); // 1/4
  });

  it("flips intOnly to false when floats appear and keeps it false", () => {
    const old = buildContract("p", "e", observe([{ n: 1 }]), T0);
    const merged = mergeContract(old, observe([{ n: 2.5 }]), T1);
    expect(merged.fields["n"]!.intOnly).toBe(false);
    const again = mergeContract(merged, observe([{ n: 3 }]), T1);
    expect(again.fields["n"]!.intOnly).toBe(false);
  });
});
