import { describe, expect, it } from "vitest";
import { observe } from "../src/core/observe.js";
import { buildContract, contractPath } from "../src/core/contract.js";
import { diffContract } from "../src/core/diff.js";

/**
 * Documentation tests for known-but-accepted pathological behavior, from the
 * pre-launch adversarial sweep. These pin CURRENT behavior so a future change
 * is a conscious decision, not an accident. None of these are endorsements.
 */
const NOW = "2026-08-03T00:00:00.000Z";

describe("path-grammar collisions (documented, not endorsed)", () => {
  it("a literal 'a.b' key is conflated with nested a.b - one contract path carries both", () => {
    const c = buildContract("p", "e", observe([{ "a.b": 1, a: { b: "s" } }]), NOW);
    // Both the literal key's number and the nested string land on path "a.b".
    expect(c.fields["a.b"]!.types).toEqual(["string", "number"]);
    // Consequence: the literal key vanishing is invisible while nested a.b remains.
    const drifted = diffContract(c, observe([{ a: { b: "s" } }]), { minSamples: 1 });
    expect(drifted.filter((f) => f.path === "a.b" && f.kind === "path_removed")).toHaveLength(0);
  });

  it("a literal 'items[]' key is conflated with the array-element path of a real items array", () => {
    const c = buildContract(
      "p",
      "e",
      observe([{ "items[]": true, items: ["x"] }]),
      NOW,
    );
    expect(c.fields["items[]"]!.types).toEqual(["string", "boolean"]);
  });
});

describe("event-name sanitization (documented)", () => {
  it("event names differing only in sanitized characters share one contract file", () => {
    // "a/b" and "a_b" both sanitize to "a_b.contract.json" - infer would merge
    // them silently. contractPath is where the collision happens.
    expect(contractPath("c", "p", "a/b")).toBe(contractPath("c", "p", "a_b"));
  });
});

describe("numeric extremes (documented)", () => {
  it("1e999 parses to Infinity and is accepted as an ordinary number", () => {
    const payload = JSON.parse('{"v": 1e999}');
    const c = buildContract("p", "e", observe([payload]), NOW);
    expect(c.fields["v"]!.types).toEqual(["number"]);
    expect(c.fields["v"]!.intOnly).toBe(false); // Number.isInteger(Infinity) is false
    // Round-trip stability: the same batch diffs clean.
    expect(diffContract(c, observe([payload]), { minSamples: 1 })).toHaveLength(0);
  });

  it("lone surrogates in keys and values survive the round trip", () => {
    const payload = JSON.parse('{"k": "\\ud800", "\\ud800x": 1}');
    const c = buildContract("p", "e", observe([payload]), NOW);
    expect(Object.keys(c.fields)).toHaveLength(2);
    expect(diffContract(c, observe([payload]), { minSamples: 1 })).toHaveLength(0);
  });
});
