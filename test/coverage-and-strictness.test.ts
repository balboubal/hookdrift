import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { loadConfig } from "../src/core/config.js";
import { runInfer } from "../src/commands/infer.js";
import { runCheck, type LastRun } from "../src/commands/check.js";
import { flattenSample, MAX_DEPTH } from "../src/core/observe.js";

/**
 * Fixes for the external production-readiness review: enforcement must never
 * fail open on a typo, and a green check must be able to prove WHAT it checked.
 */
const NOW = "2026-08-04T00:00:00.000Z";
const now = () => NOW;
const quiet = () => {};

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "hookdrift-cov-"));
  mkdirSync(join(cwd, "fx"), { recursive: true });
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function writeConfig(extra: object = {}) {
  writeFileSync(
    join(cwd, "hookdrift.config.json"),
    JSON.stringify({
      contractsDir: ".hookdrift",
      providers: { p: { fixtures: "fx/**/*.json", eventPath: "type" } },
      source: [],
      minSamples: 1,
      ...extra,
    }),
  );
}
function fixtures(payloads: object[]) {
  rmSync(join(cwd, "fx"), { recursive: true, force: true });
  mkdirSync(join(cwd, "fx"), { recursive: true });
  payloads.forEach((p, i) =>
    writeFileSync(join(cwd, "fx", `${i}.json`), JSON.stringify({ type: "e", ...p })),
  );
}
const lastRun = (): LastRun =>
  JSON.parse(readFileSync(join(cwd, ".hookdrift", "last-run.json"), "utf8"));

describe("unknown flags and arguments are rejected, never ignored", () => {
  it("REGRESSION: a mistyped --strcit fails instead of silently disabling strict", () => {
    writeConfig();
    fixtures([{ a: 1 }]);
    expect(main(["check", "--strcit"], cwd)).toBe(2);
  });

  it("rejects unknown flags on every command that takes them", () => {
    writeConfig();
    fixtures([{ a: 1 }]);
    expect(main(["infer", "--rebuidl"], cwd)).toBe(2);
    expect(main(["impact", "--stict"], cwd)).toBe(2);
    expect(main(["explain", "--json"], cwd)).toBe(2); // valid elsewhere, not here
  });

  it("rejects surplus positional arguments", () => {
    writeConfig();
    fixtures([{ a: 1 }]);
    expect(main(["check", "dir-one", "dir-two"], cwd)).toBe(2);
  });

  it("still accepts every documented flag", () => {
    writeConfig();
    fixtures([{ a: 1 }]);
    expect(main(["infer", "--rebuild"], cwd)).toBe(0);
    expect(main(["check", "--strict", "--json", "--show-suppressed"], cwd)).toBe(0);
  });
});

describe("nested config objects reject typos", () => {
  it("REGRESSION: a typo'd ignore key no longer silently suppresses every kind", () => {
    writeConfig({ ignore: [{ path: "a", kinds: "new_field", reason: "typo" }] });
    expect(() => loadConfig(cwd)).toThrowError(/kinds/);
  });

  it("a misplaced key inside a provider is rejected", () => {
    writeConfig({ providers: { p: { fixtures: "fx/**/*.json", eventPath: "type", strict: true } } });
    expect(() => loadConfig(cwd)).toThrowError(/strict/);
  });

  it("a provider name that would escape contractsDir is rejected", () => {
    writeConfig({ providers: { "../escaped": { fixtures: "fx/**/*.json", eventPath: "type" } } });
    expect(() => loadConfig(cwd)).toThrowError(/Invalid key in record/);
  });
});

describe("the report proves what was checked", () => {
  it("records matched, parsed, skipped, observed, checked and unexercised", () => {
    writeConfig();
    fixtures([{ a: 1 }, { a: 2 }]);
    runInfer({ cwd, log: quiet, now });
    writeFileSync(join(cwd, "fx", "broken.json"), "{truncated");
    runCheck({ cwd, log: quiet, now });

    const c = lastRun().coverage;
    expect(c.filesMatched).toBe(3);
    expect(c.filesParsed).toBe(2);
    expect(c.skipped).toHaveLength(1);
    expect(c.skipped[0]!.file).toContain("broken.json");
    expect(c.contractsChecked).toBe(1);
    expect(c.eventsObserved).toBe(1);
    expect(c.partial).toBe(false);
  });

  it("--fail-on-skipped turns an unusable fixture into a failure", () => {
    writeConfig();
    fixtures([{ a: 1 }]);
    runInfer({ cwd, log: quiet, now });
    writeFileSync(join(cwd, "fx", "broken.json"), "{truncated");
    expect(runCheck({ cwd, log: quiet, now })).toBe(0); // default: visible, not fatal
    expect(runCheck({ cwd, failOnSkipped: true, log: quiet, now })).toBe(1);
    expect(lastRun().findings.some((f) => f.kind === "skipped_fixture")).toBe(true);
  });

  it("--fail-on-uncontracted catches a renamed or brand-new event", () => {
    writeConfig();
    fixtures([{ a: 1 }]);
    runInfer({ cwd, log: quiet, now });
    rmSync(join(cwd, "fx"), { recursive: true, force: true });
    mkdirSync(join(cwd, "fx"));
    writeFileSync(join(cwd, "fx", "0.json"), JSON.stringify({ type: "RENAMED", a: 1 }));

    expect(runCheck({ cwd, log: quiet, now })).toBe(0);
    expect(lastRun().coverage.eventsUncontracted).toEqual(["p/RENAMED"]);
    expect(lastRun().coverage.contractsUnexercised).toEqual(["p/e.contract.json"]);
    expect(runCheck({ cwd, failOnUncontracted: true, log: quiet, now })).toBe(1);
  });

  it("unexercised contracts are machine-readable, not just a console note", () => {
    writeConfig();
    fixtures([{ a: 1 }]);
    runInfer({ cwd, log: quiet, now });
    const dir = join(cwd, ".hookdrift", "p");
    writeFileSync(
      join(dir, "ghost.contract.json"),
      readFileSync(join(dir, "e.contract.json"), "utf8").replace('"event": "e"', '"event": "ghost"'),
    );
    runCheck({ cwd, log: quiet, now });
    expect(lastRun().coverage.contractsUnexercised).toContain("p/ghost.contract.json");
  });
});

describe("dynamic object keys are surfaced before they are committed", () => {
  it("warns when contract paths look like payload data", () => {
    writeConfig();
    fixtures([
      { usersByEmail: { "alice@example.invalid": 1 }, tokens: { sk_live_AAAAAAAAAAAAAAAA: true } },
    ]);
    const lines: string[] = [];
    runInfer({ cwd, log: (l) => lines.push(l), now });
    const out = lines.join("\n");
    expect(out).toContain("WARNING");
    expect(out).toContain("look like data rather than structure");
    expect(out).toContain("SECURITY.md");
  });

  it("stays quiet for ordinary structural paths", () => {
    writeConfig();
    fixtures([{ data: { object: { amount: 1, currency: "usd" } } }]);
    const lines: string[] = [];
    runInfer({ cwd, log: (l) => lines.push(l), now });
    expect(lines.join("\n")).not.toContain("WARNING");
  });
});

describe("statistical claims match the evidence behind them", () => {
  it("REGRESSION: a corpus never drifts against itself (presence rounding)", async () => {
    const { observe } = await import("../src/core/observe.js");
    const { buildContract } = await import("../src/core/contract.js");
    const { diffContract } = await import("../src/core/diff.js");
    // 19,999/20,000 rounds to presence 1.0; the exact count must decide.
    const samples = Array.from({ length: 20000 }, (_, i) => (i === 0 ? { a: 1 } : { a: 1, rare: 1 }));
    const c = buildContract("p", "e", observe(samples), NOW);
    expect(c.fields["rare"]!.presence).toBe(1); // still rounded for display
    expect(c.fields["rare"]!.containCount).toBe(19999); // but the truth is stored
    expect(diffContract(c, observe(samples), { minSamples: 1 })).toHaveLength(0);
  });

  it("REGRESSION: a one-sample baseline cannot produce a BREAKING removal", async () => {
    const { observe } = await import("../src/core/observe.js");
    const { buildContract } = await import("../src/core/contract.js");
    const { diffContract } = await import("../src/core/diff.js");
    const c = buildContract("p", "e", observe([{ x: 1 }]), NOW);
    const f = diffContract(c, observe([{ y: 2 }]), { minSamples: 10 }).find((x) => x.path === "x")!;
    expect(f.severity).toBe("WARNING");
    expect(f.message).toContain("below minSamples");
  });

  it("a well-evidenced baseline still breaks on a genuine removal", async () => {
    const { observe } = await import("../src/core/observe.js");
    const { buildContract } = await import("../src/core/contract.js");
    const { diffContract } = await import("../src/core/diff.js");
    const base = Array.from({ length: 40 }, () => ({ x: 1 }));
    const c = buildContract("p", "e", observe(base), NOW);
    const f = diffContract(c, observe([{ y: 2 }, { y: 3 }]), { minSamples: 10 }).find(
      (x) => x.path === "x",
    )!;
    expect(f.severity).toBe("BREAKING");
  });
});

describe("depth limit replaces stack overflow", () => {
  it("a payload nested past the limit fails with a named, bounded error", () => {
    let o: unknown = 1;
    for (let i = 0; i < MAX_DEPTH + 10; i++) o = { n: o };
    expect(() => flattenSample(o)).toThrowError(new RegExp(`deeper than ${MAX_DEPTH}`));
  });

  it("ordinary nesting is unaffected", () => {
    let o: unknown = 1;
    for (let i = 0; i < 50; i++) o = { n: o };
    // Paths are n, n.n, ... 50 deep; the root object itself has no path.
    expect(flattenSample(o).size).toBe(50);
  });

  it("check reports it against the event instead of crashing the run", () => {
    writeConfig();
    fixtures([{ a: 1 }]);
    runInfer({ cwd, log: quiet, now });
    const deep = `{"type":"e","deep":${"{\"n\":".repeat(MAX_DEPTH + 50)}1${"}".repeat(MAX_DEPTH + 50)}}`;
    writeFileSync(join(cwd, "fx", "0.json"), deep);
    expect(runCheck({ cwd, log: quiet, now })).toBe(1);
    const f = lastRun().findings.find((x) => x.kind === "invalid_contract");
    expect(f?.message).toContain("nests deeper than");
  });
});
