import { describe, expect, it } from "vitest";
import { observe } from "../src/core/observe.js";
import { buildContract } from "../src/core/contract.js";

const NOW = "2026-07-31T00:00:00.000Z";

function contractOf(samples: unknown[]) {
  return buildContract("test", "test.event", observe(samples), NOW);
}

describe("flattening & types", () => {
  it("flattens nested objects to dotted paths and records intermediate objects", () => {
    const c = contractOf([{ data: { object: { amount: 100 } } }]);
    expect(c.fields["data"]!.types).toEqual(["object"]);
    expect(c.fields["data.object"]!.types).toEqual(["object"]);
    expect(c.fields["data.object.amount"]!.types).toEqual(["number"]);
  });

  it("represents arrays as path[] with the union of element schemas", () => {
    const c = contractOf([{ refunds: [{ id: "r_1" }, { id: "r_2", partial: true }] }]);
    expect(c.fields["refunds"]!.types).toEqual(["array"]);
    expect(c.fields["refunds[]"]!.types).toEqual(["object"]);
    expect(c.fields["refunds[].id"]!.types).toEqual(["string"]);
    expect(c.fields["refunds[].partial"]!.types).toEqual(["boolean"]);
  });

  it("unions types observed across samples", () => {
    const c = contractOf([{ v: "a" }, { v: 1 }]);
    expect(c.fields["v"]!.types).toEqual(["string", "number"]);
  });

  it("tracks null as nullable, never as a type", () => {
    const c = contractOf([{ v: "a" }, { v: null }]);
    expect(c.fields["v"]!.types).toEqual(["string"]);
    expect(c.fields["v"]!.nullable).toBe(true);
    expect(c.fields["v"]!.presence).toBe(1);
  });
});

describe("presence", () => {
  it("is samplesContainingPath / totalSamples", () => {
    const c = contractOf([{ a: 1, b: 2 }, { a: 1 }, { a: 1, b: 2 }, { a: 1 }]);
    expect(c.fields["a"]!.presence).toBe(1);
    expect(c.fields["b"]!.presence).toBe(0.5);
  });
});

describe("format detection (conservative: every value must match)", () => {
  const cases: [string, string[]][] = [
    ["iso8601", ["2026-07-01T12:00:00Z", "2026-07-02", "2026-07-03T01:02:03.5+02:00"]],
    ["uuid", ["6ba7b810-9dad-11d1-80b4-00c04fd430c8", "A987FBC9-4BED-4078-8F07-9141BA07C9F3"]],
    ["email", ["a@example.com", "dev+tag@sub.example.co.uk"]],
    ["url", ["https://example.com/x?y=1", "http://api.example.com"]],
    ["numeric_string", ["123", "-4.5", "0"]],
    ["base64", ["aGVsbG8gd29ybGQhIQ==", "c3VyZS9zdXJlK3N1cmU="]],
  ];
  for (const [format, values] of cases) {
    it(`detects ${format}`, () => {
      const c = contractOf(values.map((v) => ({ f: v })));
      expect(c.fields["f"]!.format).toBe(format);
    });
  }

  it("claims no format when any value deviates", () => {
    const c = contractOf([{ f: "2026-07-01" }, { f: "not a date" }]);
    expect(c.fields["f"]!.format).toBeUndefined();
  });

  it("does not claim base64 for ordinary words that fit the charset", () => {
    const c = contractOf([{ f: "administrators" }, { f: "identification" }]);
    expect(c.fields["f"]!.format).toBeUndefined();
  });

  it("detects unix_seconds and unix_millis by magnitude", () => {
    const secs = contractOf([{ t: 1_753_920_000 }, { t: 1_753_920_100 }]);
    expect(secs.fields["t"]!.format).toBe("unix_seconds");
    const ms = contractOf([{ t: 1_753_920_000_000 }]);
    expect(ms.fields["t"]!.format).toBe("unix_millis");
    const plain = contractOf([{ t: 42 }]);
    expect(plain.fields["t"]!.format).toBeUndefined();
  });

  it("tracks intOnly for numbers", () => {
    expect(contractOf([{ n: 1 }, { n: 2 }]).fields["n"]!.intOnly).toBe(true);
    expect(contractOf([{ n: 1 }, { n: 2.5 }]).fields["n"]!.intOnly).toBe(false);
    expect(contractOf([{ n: "x" }]).fields["n"]!.intOnly).toBeUndefined();
  });
});

describe("enum inference", () => {
  const currencies = ["usd", "eur", "gbp"];
  const samples = (n: number) => Array.from({ length: n }, (_, i) => ({ c: currencies[i % 3] }));

  it("claims an enum at ≥ 30 samples with ≤ 12 distinct values", () => {
    const c = contractOf(samples(30));
    expect(c.fields["c"]!.enum).toEqual(["eur", "gbp", "usd"]);
    expect(c.fields["c"]!.enumConfidence).toBe(0.9); // 1 - 3/30
  });

  it("claims nothing below 30 samples", () => {
    const c = contractOf(samples(29));
    expect(c.fields["c"]!.enum).toBeUndefined();
  });

  it("claims nothing above 12 distinct values", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ c: `v${i % 13}` }));
    const c = contractOf(many);
    expect(c.fields["c"]!.enum).toBeUndefined();
  });

  it("caps enumConfidence at 0.99", () => {
    const c = contractOf(Array.from({ length: 1000 }, () => ({ c: "usd" })));
    expect(c.fields["c"]!.enumConfidence).toBe(0.99);
  });
});
