import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { observe } from "../src/core/observe.js";
import { buildContract, mergeContract } from "../src/core/contract.js";
import { diffContract } from "../src/core/diff.js";
import { pathMatches } from "../src/core/ignore.js";
import { loadConfig } from "../src/core/config.js";
import { runInfer } from "../src/commands/infer.js";
import { runCheck, type LastRun } from "../src/commands/check.js";
import { runImpact } from "../src/commands/impact.js";

const NOW = "2026-08-01T00:00:00.000Z";
const now = () => NOW;
const quiet = () => {};

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "hookdrift-s2-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function writeConfig(extra: object = {}) {
  writeFileSync(
    join(cwd, "hookdrift.config.json"),
    JSON.stringify({
      contractsDir: ".hookdrift",
      providers: { stripe: { fixtures: "fx/**/*.json", eventPath: "type" } },
      source: [],
      minSamples: 1,
      ...extra,
    }),
  );
}

function writeFx(name: string, payload: object) {
  const d = join(cwd, "fx");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, name), JSON.stringify({ type: "charge.succeeded", ...payload }));
}

function lastRun(): LastRun {
  return JSON.parse(readFileSync(join(cwd, ".hookdrift", "last-run.json"), "utf8"));
}

describe("ignore pattern matching", () => {
  it("matches exact, trailing *, and trailing **", () => {
    expect(pathMatches("a.b.c", "a.b.c")).toBe(true);
    expect(pathMatches("a.b.c", "a.b")).toBe(false);
    expect(pathMatches("a.b.*", "a.b.c")).toBe(true);
    expect(pathMatches("a.b.*", "a.b.c.d")).toBe(false);
    expect(pathMatches("a.b.**", "a.b.c")).toBe(true);
    expect(pathMatches("a.b.**", "a.b.c.d.e")).toBe(true);
    expect(pathMatches("a.b.**", "a.b")).toBe(false);
    expect(pathMatches("a.*", "a.refunds[]")).toBe(true);
  });
});

describe("suppression via config ignore rules", () => {
  it("suppresses matching findings, reports the count, and keeps them in last-run.json", () => {
    writeConfig({
      ignore: [{ path: "tax", kind: "path_removed", reason: "known Stripe deprecation" }],
    });
    writeFx("a.json", { amount: 1, tax: 2 });
    runInfer({ cwd, log: quiet, now });
    rmSync(join(cwd, "fx"), { recursive: true });
    writeFx("b.json", { amount: 1 }); // tax removed -> BREAKING, but suppressed
    const lines: string[] = [];
    const code = runCheck({ cwd, log: (l) => lines.push(l), now });
    expect(code).toBe(0); // the only breaking finding is suppressed
    const summary = lines.join("\n");
    expect(summary).toContain("(1 suppressed)");
    expect(summary).not.toContain("known Stripe deprecation"); // hidden without the flag
    const run = lastRun();
    const f = run.findings.find((x) => x.path === "tax")!;
    expect(f.suppressed).toBe(true);
    expect(f.suppressReason).toBe("known Stripe deprecation");
  });

  it("--show-suppressed prints them without changing the exit code", () => {
    writeConfig({ ignore: [{ path: "tax", reason: "vendor quirk" }] });
    writeFx("a.json", { amount: 1, tax: 2 });
    runInfer({ cwd, log: quiet, now });
    rmSync(join(cwd, "fx"), { recursive: true });
    writeFx("b.json", { amount: 1 });
    const lines: string[] = [];
    const code = runCheck({ cwd, showSuppressed: true, log: (l) => lines.push(l), now });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("[suppressed: vendor quirk]");
  });

  it("a kind-scoped rule does not suppress other kinds at the same path", () => {
    writeConfig({ ignore: [{ path: "amount", kind: "new_field" }] });
    writeFx("a.json", { amount: 1 });
    runInfer({ cwd, log: quiet, now });
    rmSync(join(cwd, "fx"), { recursive: true });
    writeFx("b.json", { amount: "boom" }); // type_changed, not new_field
    expect(runCheck({ cwd, log: quiet, now })).toBe(1);
  });
});

describe("polymorphic fields (expandable-field handling)", () => {
  const idStr = "txn_3MkQpL2eZvKYlo2C0AbCdEfG";
  const expanded = { id: idStr, object: "balance_transaction", amount: 100, fee: 3 };

  it("infer auto-detects string+object with ID-like strings", () => {
    const samples = [
      { bt: idStr },
      { bt: expanded },
      { bt: "txn_9XyZaB3cDeFgHiJkLmNoPqRs" },
    ];
    const c = buildContract("p", "e", observe(samples), NOW);
    expect(c.fields["bt"]!.polymorphic).toBe(true);
    expect(c.fields["bt"]!.types).toEqual(["string", "object"]);
  });

  it("does not auto-detect when strings are not ID-like", () => {
    const c = buildContract("p", "e", observe([{ v: "hello world" }, { v: { a: 1 } }]), NOW);
    expect(c.fields["v"]!.polymorphic).toBeUndefined();
  });

  it("widening on an annotated polymorphic field is INFO", () => {
    const c = buildContract("p", "e", observe([{ bt: idStr }]), NOW);
    c.fields["bt"]!.polymorphic = true;
    const fs = diffContract(c, observe([{ bt: expanded }]), { minSamples: 1 });
    const widened = fs.find((f) => f.path === "bt" && f.kind === "type_changed")!;
    expect(widened.severity).toBe("INFO");
    // Children of the expanded object are folded into the widening finding.
    expect(fs.filter((f) => f.kind === "new_field")).toHaveLength(0);
  });

  it("unannotated expandable pattern is downgraded to INFO by the heuristic", () => {
    const c = buildContract("p", "e", observe([{ bt: idStr }]), NOW);
    expect(c.fields["bt"]!.polymorphic).toBeUndefined(); // string-only, no annotation
    const fs = diffContract(c, observe([{ bt: expanded }, { bt: idStr }]), { minSamples: 1 });
    const f = fs.find((x) => x.path === "bt" && x.kind === "type_changed")!;
    expect(f.severity).toBe("INFO");
    expect(f.message).toContain("expandable");
    expect(fs.some((x) => x.severity === "BREAKING")).toBe(false);
  });

  it("narrowing on a polymorphic field is WARNING", () => {
    const c = buildContract("p", "e", observe([{ bt: idStr }, { bt: expanded }]), NOW);
    expect(c.fields["bt"]!.polymorphic).toBe(true);
    const fs = diffContract(c, observe([{ bt: idStr }]), { minSamples: 1 });
    const f = fs.find((x) => x.path === "bt" && x.kind === "type_changed")!;
    expect(f.severity).toBe("WARNING");
    expect(f.message).toContain("narrowed");
  });

  // REGRESSION (permanent): a complete shape replacement must never be INFO.
  // An earlier version downgraded a contract of 40 ID strings checked against
  // all-object samples to INFO on the contract's prefixed_id format alone -
  // but code doing bt.startsWith("txn_") crashes on an object. Only
  // coexistence within the new batch proves both shapes are legitimate.
  it("REGRESSION: all-object replacement of an ID-string field is WARNING, never INFO", () => {
    const oldS = Array.from({ length: 40 }, (_, i) => ({
      bt: `txn_${String(i).padStart(2, "0")}AbCdEfGhIjKlMnOp`,
    }));
    const c = buildContract("p", "e", observe(oldS), NOW);
    expect(c.fields["bt"]!.format).toBe("prefixed_id");
    const newS = Array.from({ length: 20 }, (_, i) => ({ bt: { ...expanded, amount: i } }));
    const fs = diffContract(c, observe(newS), { minSamples: 1 });
    const f = fs.find((x) => x.path === "bt" && x.kind === "type_changed")!;
    expect(f.severity).not.toBe("INFO");
    expect(f.severity).toBe("WARNING");
    expect(f.message).toContain("shape changed completely");
    expect(f.message).toContain("Verify");
  });

  it("REGRESSION: coexistence of both shapes in the new batch stays INFO", () => {
    const c = buildContract("p", "e", observe([{ bt: idStr }]), NOW);
    const fs = diffContract(c, observe([{ bt: expanded }, { bt: idStr }]), { minSamples: 1 });
    const f = fs.find((x) => x.path === "bt" && x.kind === "type_changed")!;
    expect(f.severity).toBe("INFO");
    expect(f.message).toContain("coexist");
  });

  it("the symmetric flip (object contract, all-ID-string batch) is also WARNING", () => {
    const c = buildContract("p", "e", observe([{ bt: expanded }, { bt: { ...expanded } }]), NOW);
    const fs = diffContract(c, observe([{ bt: idStr }, { bt: idStr }]), { minSamples: 1 });
    const f = fs.find((x) => x.path === "bt" && x.kind === "type_changed")!;
    expect(f.severity).toBe("WARNING");
  });

  it("a genuine string -> number change on a non-polymorphic field stays BREAKING", () => {
    const c = buildContract("p", "e", observe([{ amount: "100" }]), NOW);
    const fs = diffContract(c, observe([{ amount: 100 }]), { minSamples: 1 });
    expect(fs.find((x) => x.path === "amount")!.severity).toBe("BREAKING");
  });

  it("merge keeps polymorphic sticky and can detect it from format evidence", () => {
    const old = buildContract("p", "e", observe([{ bt: idStr }]), NOW);
    expect(old.fields["bt"]!.format).toBe("prefixed_id");
    // New batch arrives fully expanded (no strings at all): the old format
    // claim is the ID evidence.
    const merged = mergeContract(old, observe([{ bt: expanded }]), NOW);
    expect(merged.fields["bt"]!.polymorphic).toBe(true);
    const again = mergeContract(merged, observe([{ bt: expanded }]), NOW);
    expect(again.fields["bt"]!.polymorphic).toBe(true);
  });
});

describe("minimum-sample guards", () => {
  const contract = () =>
    buildContract("p", "e", observe(Array.from({ length: 20 }, () => ({ a: 1, b: 2 }))), NOW);

  it("downgrades required_became_optional to INFO below minSamples", () => {
    const fs = diffContract(contract(), observe([{ a: 1, b: 2 }, { a: 1 }]), { minSamples: 10 });
    const f = fs.find((x) => x.kind === "required_became_optional")!;
    expect(f.severity).toBe("INFO");
    expect(f.message).toContain("below minSamples=10");
  });

  it("keeps WARNING at or above minSamples", () => {
    const newS = [...Array.from({ length: 9 }, () => ({ a: 1, b: 2 })), { a: 1 }];
    const fs = diffContract(contract(), observe(newS), { minSamples: 10 });
    expect(fs.find((x) => x.kind === "required_became_optional")!.severity).toBe("WARNING");
  });
});

describe("config validation", () => {
  it("names the offending key on a wrong type", () => {
    writeFileSync(join(cwd, "hookdrift.config.json"), JSON.stringify({ contractsDir: 123 }));
    expect(() => loadConfig(cwd)).toThrowError(/contractsDir/);
  });

  it("rejects unknown keys (typo protection)", () => {
    writeFileSync(join(cwd, "hookdrift.config.json"), JSON.stringify({ strick: true }));
    expect(() => loadConfig(cwd)).toThrowError(/strick/);
  });

  it("rejects a bad ignore kind", () => {
    writeFileSync(
      join(cwd, "hookdrift.config.json"),
      JSON.stringify({ ignore: [{ path: "a", kind: "not_a_kind" }] }),
    );
    expect(() => loadConfig(cwd)).toThrowError(/ignore\.0\.kind/);
  });

  it("fills defaults for omitted keys", () => {
    writeFileSync(join(cwd, "hookdrift.config.json"), JSON.stringify({}));
    const c = loadConfig(cwd);
    expect(c.minSamples).toBe(10);
    expect(c.ignore).toEqual([]);
    expect(c.strict).toBe(false);
  });
});

describe("--json output", () => {
  it("emits the full report as JSON with unchanged exit codes", () => {
    writeConfig();
    writeFx("a.json", { amount: 1 });
    runInfer({ cwd, log: quiet, now });
    rmSync(join(cwd, "fx"), { recursive: true });
    writeFx("b.json", { amount: "boom" });
    const lines: string[] = [];
    const code = runCheck({ cwd, json: true, log: (l) => lines.push(l), now });
    expect(code).toBe(1);
    const report = JSON.parse(lines.join("\n")) as LastRun;
    expect(report.exitCode).toBe(1);
    expect(report.findings.some((f) => f.kind === "type_changed")).toBe(true);
    expect(report.ranAt).toBe(NOW);
  });
});

describe("impact (heuristic code mapping)", () => {
  it("ranks full-path matches above leaf-only matches and persists refs", () => {
    writeConfig({ source: ["src/**/*.ts"] });
    writeFx("a.json", { data: { object: { amount: 1, tax_amount: 2 } } });
    runInfer({ cwd, log: quiet, now });
    rmSync(join(cwd, "fx"), { recursive: true });
    writeFx("b.json", { data: { object: { amount: 1 } } }); // tax_amount removed

    const src = join(cwd, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "handler.ts"),
      [
        "export function handle(payload: any) {",
        "  const t = payload.data.object.tax_amount;", // full chain -> 1.0
        "  console.log(obj.tax_amount);", // leaf property -> 1/3
        "  const { tax_amount } = other;", // bare identifier -> 0.5/3
        "}",
      ].join("\n"),
    );

    expect(runCheck({ cwd, log: quiet, now })).toBe(1);
    const lines: string[] = [];
    expect(runImpact(cwd, (l) => lines.push(l))).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("src/handler.ts:2");
    expect(out).toContain("textual matching, not AST analysis");

    const refs = lastRun().findings.find((f) => f.path === "data.object.tax_amount")!.refs!;
    expect(refs[0]).toMatchObject({ file: "src/handler.ts", line: 2, score: 1 });
    expect(refs.map((r) => r.line)).toEqual([2, 3, 4]);
    expect(refs[1]!.score).toBeGreaterThan(refs[2]!.score);
  });

  it("reports when nothing matches", () => {
    writeConfig({ source: ["src/**/*.ts"] });
    writeFx("a.json", { zorbltrax: 1, keep: 1 });
    runInfer({ cwd, log: quiet, now });
    rmSync(join(cwd, "fx"), { recursive: true });
    writeFx("b.json", { keep: 1 });
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "x.ts"), "export const nothing = 1;");
    runCheck({ cwd, log: quiet, now });
    const lines: string[] = [];
    runImpact(cwd, (l) => lines.push(l));
    expect(lines.join("\n")).toContain("no references found");
  });
});
