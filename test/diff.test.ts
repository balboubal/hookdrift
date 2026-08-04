import { describe, expect, it } from "vitest";
import { observe } from "../src/core/observe.js";
import { buildContract } from "../src/core/contract.js";
import { diffContract } from "../src/core/diff.js";
import type { Finding } from "../src/types.js";

const NOW = "2026-07-31T00:00:00.000Z";

// Unit tests use tiny sample sets, so disable the minimum-sample guard here;
// the guard itself is tested explicitly in session2.test.ts.
function diff(oldSamples: unknown[], newSamples: unknown[]): Finding[] {
  const contract = buildContract("p", "e", observe(oldSamples), NOW);
  return diffContract(contract, observe(newSamples), { minSamples: 1 });
}

const one = (fs: Finding[], kind: string) => {
  const hits = fs.filter((f) => f.kind === kind);
  expect(hits, `expected exactly one ${kind} in ${JSON.stringify(fs, null, 2)}`).toHaveLength(1);
  return hits[0]!;
};

describe("BREAKING", () => {
  it("path present in contract, absent from all new samples", () => {
    const f = one(diff([{ id: "a", tax: 5 }], [{ id: "b" }]), "path_removed");
    expect(f.severity).toBe("BREAKING"); // presence 1.0 -> p = 0
    expect(f.path).toBe("tax");
    expect(f.message).toContain("contract presence 1 (1/1 samples)");
  });

  it("incompatible type change (string → number)", () => {
    const f = one(diff([{ v: "100" }], [{ v: 100 }]), "type_changed");
    expect(f.severity).toBe("BREAKING");
    expect(f.path).toBe("v");
  });

  it("scalar → object is a type change", () => {
    const f = one(diff([{ v: "x" }], [{ v: { nested: true } }]), "type_changed");
    expect(f.severity).toBe("BREAKING");
  });

  it("previously non-nullable path now null in any sample", () => {
    const f = one(diff([{ v: "x" }, { v: "y" }], [{ v: "z" }, { v: null }]), "became_nullable");
    expect(f.severity).toBe("BREAKING");
    expect(f.message).toContain("1 null value(s)");
  });

  it("a moved path is reported as a move, not delete+add", () => {
    const fs = diff(
      [{ amount: 100, other: "x" }],
      [{ totals: { amount: 100 }, other: "x" }],
    );
    const f = one(fs, "path_moved");
    expect(f.severity).toBe("BREAKING");
    expect(f.path).toBe("amount");
    expect(f.movedTo).toBe("totals.amount");
    expect(fs.filter((x) => x.kind === "path_removed")).toHaveLength(0);
    // The new parent object is still a new field, but amount itself is not.
    expect(fs.filter((x) => x.kind === "new_field" && x.path === "totals.amount")).toHaveLength(0);
  });

  it("enum value vanished is BREAKING only when the contract declares the enum closed", () => {
    // 3 distinct over 100 samples -> confidence 0.97; 60 new values >= 50.
    const oldS = Array.from({ length: 100 }, (_, i) => ({ c: ["usd", "eur", "gbp"][i % 3] }));
    const newS = Array.from({ length: 60 }, (_, i) => ({ c: ["usd", "eur"][i % 2] }));

    // Inferred enums cannot distinguish "removed" from "rare and unsampled".
    const inferred = one(diff(oldS, newS), "enum_value_removed");
    expect(inferred.severity).toBe("WARNING");
    expect(inferred.message).toContain("gbp");
    expect(inferred.message).toContain("enumAuthoritative");

    // Declared closed by hand: the provider documents the set, so it breaks.
    const contract = buildContract("p", "e", observe(oldS), NOW);
    contract.fields["c"]!.enumAuthoritative = true;
    const declared = diffContract(contract, observe(newS), { minSamples: 1 }).find(
      (x) => x.kind === "enum_value_removed",
    )!;
    expect(declared.severity).toBe("BREAKING");
  });

  it("enum value vanished below the confidence bar is WARNING, not breaking", () => {
    // 3 distinct over 40 samples -> confidence 0.925 < 0.95.
    const oldS = Array.from({ length: 40 }, (_, i) => ({ c: ["usd", "eur", "gbp"][i % 3] }));
    const newS = Array.from({ length: 60 }, (_, i) => ({ c: ["usd", "eur"][i % 2] }));
    const f = one(diff(oldS, newS), "enum_value_removed");
    expect(f.severity).toBe("WARNING");
  });

  it("enum value vanished with < 50 new observed values is WARNING, not breaking", () => {
    const oldS = Array.from({ length: 100 }, (_, i) => ({ c: ["usd", "eur", "gbp"][i % 3] }));
    const newS = Array.from({ length: 30 }, (_, i) => ({ c: ["usd", "eur"][i % 2] }));
    const f = one(diff(oldS, newS), "enum_value_removed");
    expect(f.severity).toBe("WARNING");
  });

  it("array became scalar (and vice versa)", () => {
    const a = one(diff([{ items: [1, 2] }], [{ items: "1,2" }]), "array_scalar_flip");
    expect(a.severity).toBe("BREAKING");
    const b = one(diff([{ items: "1,2" }], [{ items: [1, 2] }]), "array_scalar_flip");
    expect(b.severity).toBe("BREAKING");
  });

  it("suppresses descendant findings under a removed subtree", () => {
    const fs = diff(
      [{ obj: { a: 1, b: { c: 2 } } }],
      [{ other: true }],
    );
    const removed = fs.filter((f) => f.kind === "path_removed");
    expect(removed).toHaveLength(1);
    expect(removed[0]!.path).toBe("obj");
  });
});

describe("WARNING", () => {
  it("required path became optional", () => {
    const f = one(diff([{ a: 1, b: 2 }], [{ a: 1, b: 2 }, { a: 1 }]), "required_became_optional");
    expect(f.severity).toBe("WARNING");
    expect(f.path).toBe("b");
    expect(f.message).toContain("1/2 new samples");
  });

  it("new value in an inferred enum", () => {
    const oldS = Array.from({ length: 30 }, (_, i) => ({ c: ["usd", "eur"][i % 2] }));
    const f = one(diff(oldS, [{ c: "usd" }, { c: "chf" }]), "enum_value_added");
    expect(f.severity).toBe("WARNING");
    expect(f.message).toContain("chf");
  });

  it("string format changed", () => {
    const f = one(
      diff([{ t: "2026-07-01T00:00:00Z" }], [{ t: "1753920000" }]),
      "format_changed",
    );
    expect(f.severity).toBe("WARNING");
    expect(f.message).toContain("iso8601 -> numeric_string");
  });

  it("numeric precision shift (integers only → floats)", () => {
    const f = one(diff([{ n: 10 }, { n: 20 }], [{ n: 10.5 }]), "precision_shift");
    expect(f.severity).toBe("WARNING");
  });
});

describe("INFO", () => {
  it("new optional field appeared", () => {
    const f = one(diff([{ a: 1 }], [{ a: 1, extra: "x" }]), "new_field");
    expect(f.severity).toBe("INFO");
    expect(f.path).toBe("extra");
  });

  it("new nested object reports one finding for the subtree root", () => {
    const fs = diff([{ a: 1 }], [{ a: 1, extra: { x: 1, y: { z: 2 } } }]);
    const added = fs.filter((f) => f.kind === "new_field");
    expect(added).toHaveLength(1);
    expect(added[0]!.path).toBe("extra");
  });

  it("presence moved without crossing the required/optional boundary", () => {
    const oldS = [{ a: 1, m: 1 }, { a: 1, m: 1 }, { a: 1, m: 1 }, { a: 1 }]; // 0.75
    const newS = [{ a: 1, m: 1 }, { a: 1 }, { a: 1 }, { a: 1 }]; // 0.25
    const f = one(diff(oldS, newS), "presence_shift");
    expect(f.severity).toBe("INFO");
    expect(f.path).toBe("m");
  });

  it("identical samples produce zero findings", () => {
    const s = [{ id: "x", data: { object: { amount: 1, tags: ["a"] } } }];
    expect(diff(s, s)).toHaveLength(0);
  });
});
