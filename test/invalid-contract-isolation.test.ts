import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInfer } from "../src/commands/infer.js";
import { runCheck, type LastRun } from "../src/commands/check.js";
import { runExplain } from "../src/commands/misc.js";
import { runImpact } from "../src/commands/impact.js";
import { loadConfig } from "../src/core/config.js";

/**
 * Contract validation must never cost more than it buys. Before this, ONE
 * unreadable contract threw out of runCheck: every other contract's findings
 * were lost (including genuine BREAKING drift in a different provider),
 * last-run.json kept the previous green run, and explain/impact then reported
 * that stale run as current health. Published 0.1.1 - which had no validation -
 * correctly reported the drift, so this was a regression, not a hardening.
 */
const NOW = "2026-08-04T00:00:00.000Z";
const now = () => NOW;
const quiet = () => {};

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "hookdrift-iso-"));
  mkdirSync(join(cwd, "fx"), { recursive: true });
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "src", "h.js"), "const a = payload.amount;\n");
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function writeConfig(providers: Record<string, { fixtures: string; eventPath: string }>) {
  writeFileSync(
    join(cwd, "hookdrift.config.json"),
    JSON.stringify({
      contractsDir: ".hookdrift",
      providers,
      source: ["src/**/*.js"],
      minSamples: 1,
    }),
  );
}
function fixtures(dir: string, payloads: object[]) {
  rmSync(join(cwd, dir), { recursive: true, force: true });
  mkdirSync(join(cwd, dir), { recursive: true });
  payloads.forEach((p, i) =>
    writeFileSync(join(cwd, dir, `${i}.json`), JSON.stringify({ type: "e", ...p })),
  );
}
const lastRun = (): LastRun =>
  JSON.parse(readFileSync(join(cwd, ".hookdrift", "last-run.json"), "utf8"));

describe("an unreadable contract is isolated, not fatal", () => {
  beforeEach(() => {
    writeConfig({ p: { fixtures: "fx/**/*.json", eventPath: "type" } });
    fixtures("fx", [{ amount: 1 }, { amount: 2 }]);
    runInfer({ cwd, log: quiet, now });
    runCheck({ cwd, log: quiet, now }); // green baseline -> last-run.json
    // The exact hand-edit the tool's own message tells users to make, typo'd
    // as a quoted string.
    const cf = join(cwd, ".hookdrift", "p", "e.contract.json");
    const c = JSON.parse(readFileSync(cf, "utf8"));
    c.fields["amount"].polymorphic = "true";
    writeFileSync(cf, JSON.stringify(c));
    fixtures("fx", [{ amount: "s1" }, { amount: "s2" }]); // real drift arrives too
  });

  it("REGRESSION: check reports it as a finding and exits 1, instead of throwing", () => {
    const lines: string[] = [];
    expect(runCheck({ cwd, log: (l) => lines.push(l), now })).toBe(1);
    const out = lines.join("\n");
    expect(out).toContain("committed contract could not be read");
    expect(out).toContain("went unchecked");
    expect(out).toContain("polymorphic"); // names the offending key
    expect(out).toContain("--rebuild"); // and the recovery
    const run = lastRun();
    expect(run.findings.some((f) => f.kind === "invalid_contract")).toBe(true);
    expect(run.exitCode).toBe(1);
  });

  it("REGRESSION: explain and impact no longer report the stale green run as health", () => {
    runCheck({ cwd, log: quiet, now });
    const lines: string[] = [];
    expect(runExplain(cwd, (l) => lines.push(l))).toBe(0);
    expect(lines.join("\n")).not.toContain("No drift detected");
    expect(runImpact(cwd, quiet)).toBe(1); // BREAKING present, even unmappable
  });

  it("REGRESSION: a bad contract in one provider does not hide drift in another", () => {
    writeConfig({
      good: { fixtures: "good/**/*.json", eventPath: "type" },
      bad: { fixtures: "bad/**/*.json", eventPath: "type" },
    });
    fixtures("good", [{ amount: 1 }]);
    fixtures("bad", [{ amount: 1 }]);
    runInfer({ cwd, log: quiet, now });
    const cf = join(cwd, ".hookdrift", "bad", "e.contract.json");
    const c = JSON.parse(readFileSync(cf, "utf8"));
    c.samplesObserved = "not a number";
    writeFileSync(cf, JSON.stringify(c));
    fixtures("good", [{ amount: "drifted" }]); // genuine BREAKING in the healthy provider

    const lines: string[] = [];
    expect(runCheck({ cwd, log: (l) => lines.push(l), now })).toBe(1);
    const run = lastRun();
    expect(run.findings.some((f) => f.provider === "good" && f.severity === "BREAKING")).toBe(true);
    expect(run.findings.some((f) => f.provider === "bad" && f.kind === "invalid_contract")).toBe(true);
  });

  it("infer skips the unreadable contract, keeps going, and exits 1", () => {
    const lines: string[] = [];
    expect(runInfer({ cwd, log: (l) => lines.push(l), now })).toBe(1);
    expect(lines.join("\n")).toContain("SKIPPED");
    expect(lines.join("\n")).toContain("--rebuild");
  });

  it("infer --rebuild recovers, as the error message promises", () => {
    expect(runInfer({ cwd, rebuild: true, log: quiet, now })).toBe(0);
    expect(runCheck({ cwd, log: quiet, now })).toBe(0); // rebuilt from the drifted batch
  });
});

describe("config rejects a provider name that cannot be a directory", () => {
  it("an empty provider name is a config error, not a wedged contract", () => {
    writeConfig({ "": { fixtures: "fx/**/*.json", eventPath: "type" } });
    expect(() => loadConfig(cwd)).toThrowError(/providers\.: Invalid key in record/);
  });
});
