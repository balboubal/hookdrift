import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { observe } from "../src/core/observe.js";
import { buildContract, mergeContract, loadContract, saveContract } from "../src/core/contract.js";
import { diffContract } from "../src/core/diff.js";
import { runInfer } from "../src/commands/infer.js";
import { runCheck } from "../src/commands/check.js";

/**
 * Payload keys that collide with Object.prototype members. "__proto__" is a
 * legal JSON member name and reaches real payloads through anything that
 * echoes user-controlled keys (metadata objects, form builders). Before the
 * null-prototype fix: the field silently vanished from the contract, the
 * SECOND infer crashed with "p.types is not iterable" and aborted the whole
 * run, and drift on the field was reported as "no drift" even under --strict.
 */
const NOW = "2026-08-03T00:00:00.000Z";
const now = () => NOW;
const quiet = () => {};

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "hookdrift-proto-"));
  writeFileSync(
    join(cwd, "hookdrift.config.json"),
    JSON.stringify({
      contractsDir: ".hookdrift",
      providers: { p: { fixtures: "fx/**/*.json", eventPath: "type" } },
      source: [],
      minSamples: 1,
    }),
  );
  mkdirSync(join(cwd, "fx"), { recursive: true });
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("__proto__ and Object.prototype-member keys", () => {
  it("REGRESSION: a top-level __proto__ key is recorded, and infer stays idempotent", () => {
    writeFileSync(join(cwd, "fx", "a.json"), '{"type":"e","id":"x","__proto__":"v1"}');
    expect(runInfer({ cwd, log: quiet, now })).toBe(0);
    const contract = JSON.parse(
      readFileSync(join(cwd, ".hookdrift", "p", "e.contract.json"), "utf8"),
    );
    expect(Object.keys(contract.fields)).toContain("__proto__");
    // The second infer used to crash with "p.types is not iterable".
    expect(runInfer({ cwd, log: quiet, now })).toBe(0);
    const after = JSON.parse(readFileSync(join(cwd, ".hookdrift", "p", "e.contract.json"), "utf8"));
    expect(after.samplesObserved).toBe(2);
  });

  it("REGRESSION: drift on a __proto__ field is detected, not laundered", () => {
    writeFileSync(join(cwd, "fx", "a.json"), '{"type":"e","id":"x","__proto__":"v1"}');
    runInfer({ cwd, log: quiet, now });
    writeFileSync(join(cwd, "fx", "a.json"), '{"type":"e","id":"x","__proto__":12345}');
    expect(runCheck({ cwd, log: quiet, now })).toBe(1); // type change = BREAKING
  });

  it("new fields named after Object.prototype members are reported as new_field", () => {
    const c = buildContract("p", "e", observe([{ a: 1 }]), NOW);
    const file = join(cwd, "c.contract.json");
    saveContract(file, c);
    const loaded = loadContract(file)!;
    const findings = diffContract(
      loaded,
      observe([{ a: 1, toString: "x", constructor: "y", valueOf: "z" }]),
      { minSamples: 1 },
    );
    const added = findings.filter((f) => f.kind === "new_field").map((f) => f.path);
    expect(added).toEqual(expect.arrayContaining(["toString", "constructor", "valueOf"]));
  });

  it("mergeContract widens a __proto__ field like any other", () => {
    const old = buildContract("p", "e", observe([JSON.parse('{"__proto__":"s"}')]), NOW);
    const merged = mergeContract(old, observe([JSON.parse('{"__proto__":1}')]), NOW);
    expect(merged.fields["__proto__"]!.types).toEqual(["string", "number"]);
  });
});
