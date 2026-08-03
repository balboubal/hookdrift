import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInfer } from "../src/commands/infer.js";
import { runCheck } from "../src/commands/check.js";
import { loadContract } from "../src/core/contract.js";

/**
 * Committed contracts get hand-edited (the README suggests polymorphic: true)
 * and mangled by merge conflicts. Before validation: a missing samplesObserved
 * made the next infer merge write samplesObserved: null and presence: null on
 * every field with exit 0 - permanent silent poisoning; presence: 1.5 produced
 * negative "probabilities"; polymorphic: "yes" (truthy string) silently
 * activated severity downgrades. Failures must be loud and name the file.
 */
const NOW = "2026-08-03T00:00:00.000Z";
const now = () => NOW;
const quiet = () => {};

let cwd: string;
let contractFile: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "hookdrift-cval-"));
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
  writeFileSync(join(cwd, "fx", "a.json"), '{"type":"e","amount":1}');
  runInfer({ cwd, log: quiet, now });
  contractFile = join(cwd, ".hookdrift", "p", "e.contract.json");
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function mutate(fn: (c: Record<string, unknown>) => void) {
  const c = JSON.parse(readFileSync(contractFile, "utf8"));
  fn(c);
  writeFileSync(contractFile, JSON.stringify(c));
}

describe("corrupted committed contracts fail loudly, naming the file", () => {
  it("REGRESSION: missing samplesObserved no longer poisons the contract on merge", () => {
    mutate((c) => delete c.samplesObserved);
    expect(() => loadContract(contractFile)).toThrowError(/samplesObserved/);
    // Through the command: infer reports and skips it (exit 1) rather than
    // writing nulls with exit 0. It no longer throws - one bad contract must
    // not abort inference for every other event.
    const lines: string[] = [];
    expect(runInfer({ cwd, log: (l) => lines.push(l), now })).toBe(1);
    expect(lines.join("\n")).toContain("SKIPPED");
    // And the on-disk contract was not rewritten with nulls.
    const onDisk = JSON.parse(readFileSync(contractFile, "utf8"));
    expect(onDisk.fields.amount.presence).not.toBeNull();
  });

  it("presence out of range is rejected with the offending key named", () => {
    mutate((c) => {
      (c.fields as Record<string, { presence: number }>).amount.presence = 1.5;
    });
    expect(() => loadContract(contractFile)).toThrowError(/fields\.amount\.presence/);
  });

  it("polymorphic as a truthy string is rejected, not silently honored", () => {
    mutate((c) => {
      (c.fields as Record<string, { polymorphic?: unknown }>).amount.polymorphic = "yes";
    });
    expect(() => loadContract(contractFile)).toThrowError(/polymorphic/);
  });

  it("truncated JSON names the file instead of throwing a bare parse error", () => {
    writeFileSync(contractFile, readFileSync(contractFile, "utf8").slice(0, 40));
    expect(() => loadContract(contractFile)).toThrowError(new RegExp("is not valid JSON"));
    // check surfaces it as a finding naming the file, and still fails the run.
    const lines: string[] = [];
    expect(runCheck({ cwd, log: (l) => lines.push(l), now })).toBe(1);
    const out = lines.join("\n");
    expect(out).toContain("e.contract.json");
    expect(out).toContain("is not valid JSON");
  });

  it("unknown extra keys pass through (forward compatibility)", () => {
    mutate((c) => {
      c.futureTopLevel = true;
      (c.fields as Record<string, Record<string, unknown>>).amount.futureFieldKey = 1;
    });
    expect(loadContract(contractFile)).not.toBeNull();
    expect(runCheck({ cwd, log: quiet, now })).toBe(0);
  });
});
