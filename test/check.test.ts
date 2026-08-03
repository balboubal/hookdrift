import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInfer } from "../src/commands/infer.js";
import { runCheck } from "../src/commands/check.js";

let cwd: string;
const quiet = () => {};
const now = () => "2026-07-31T00:00:00.000Z";

function writeFixtures(dir: string, event: string, samples: unknown[]) {
  const d = join(cwd, "fixtures", dir);
  mkdirSync(d, { recursive: true });
  samples.forEach((s, i) =>
    writeFileSync(join(d, `${i}.json`), JSON.stringify({ type: event, ...(s as object) })),
  );
}

function writeConfig(strict = false) {
  writeFileSync(
    join(cwd, "hookdrift.config.json"),
    JSON.stringify({
      contractsDir: ".hookdrift",
      providers: { stripe: { fixtures: "fixtures/**/*.json", eventPath: "type" } },
      source: [],
      strict,
      minSamples: 1,
    }),
  );
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "hookdrift-test-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("infer → check wiring and exit codes", () => {
  it("exits 0 with no findings when nothing drifted", () => {
    writeConfig();
    writeFixtures("stripe", "charge.succeeded", [{ amount: 100 }, { amount: 200 }]);
    expect(runInfer({ cwd, log: quiet, now })).toBe(0);
    expect(runCheck({ cwd, log: quiet, now })).toBe(0);
  });

  it("exits 1 on breaking drift", () => {
    writeConfig();
    writeFixtures("stripe", "charge.succeeded", [{ amount: 100 }]);
    runInfer({ cwd, log: quiet, now });
    rmSync(join(cwd, "fixtures"), { recursive: true });
    writeFixtures("stripe", "charge.succeeded", [{ amount: "100" }]); // string now
    expect(runCheck({ cwd, log: quiet, now })).toBe(1);
  });

  it("exits 0 on warning-only drift, 1 under --strict", () => {
    writeConfig();
    writeFixtures("stripe", "charge.succeeded", [{ amount: 100, b: 1 }]);
    runInfer({ cwd, log: quiet, now });
    rmSync(join(cwd, "fixtures"), { recursive: true });
    // required → optional is a WARNING
    writeFixtures("stripe", "charge.succeeded", [{ amount: 100, b: 1 }, { amount: 100 }]);
    expect(runCheck({ cwd, log: quiet, now })).toBe(0);
    expect(runCheck({ cwd, strict: true, log: quiet, now })).toBe(1);
  });

  it("strict in config applies when no flag is passed", () => {
    writeConfig(true);
    writeFixtures("stripe", "charge.succeeded", [{ amount: 100, b: 1 }]);
    runInfer({ cwd, log: quiet, now });
    rmSync(join(cwd, "fixtures"), { recursive: true });
    writeFixtures("stripe", "charge.succeeded", [{ amount: 100, b: 1 }, { amount: 100 }]);
    expect(runCheck({ cwd, log: quiet, now })).toBe(1);
  });

  it("exits 1 when the fixtures glob matches nothing at all", () => {
    // A typo'd glob used to print "OK 0 contract(s) checked" and exit 0 -
    // drift detection silently off in CI forever.
    writeConfig();
    const lines: string[] = [];
    expect(runCheck({ cwd, log: (l) => lines.push(l), now })).toBe(1);
    expect(lines.join("\n")).toContain("no fixtures matched");
  });

  it("REGRESSION: explain and impact mirror a checked-nothing failure instead of laundering it", async () => {
    const { runExplain } = await import("../src/commands/misc.js");
    const { runImpact } = await import("../src/commands/impact.js");
    writeConfig(); // glob matches nothing - no fixtures written
    expect(runCheck({ cwd, log: quiet, now })).toBe(1);
    const lines: string[] = [];
    expect(runExplain(cwd, (l) => lines.push(l))).toBe(1); // was 0 with "No drift detected."
    expect(lines.join("\n")).toContain("not evidence of health");
    expect(runImpact(cwd, quiet)).toBe(1); // was 0
  });

  it("uncontracted events are INFO, exit 0", () => {
    writeConfig();
    writeFixtures("stripe", "charge.succeeded", [{ amount: 100 }]);
    expect(runCheck({ cwd, log: quiet, now })).toBe(0);
  });

  it("names committed contracts that this run never exercised", () => {
    writeConfig();
    writeFixtures("a", "charge.succeeded", [{ amount: 100 }]);
    writeFixtures("b", "charge.refunded", [{ amount: 100 }]);
    runInfer({ cwd, log: quiet, now }); // two contracts on disk
    rmSync(join(cwd, "fixtures"), { recursive: true });
    writeFixtures("a", "charge.succeeded", [{ amount: 100 }]); // refunded dries up
    const lines: string[] = [];
    expect(runCheck({ cwd, log: (l) => lines.push(l), now })).toBe(0); // note, not failure
    const out = lines.join("\n");
    expect(out).toContain("not exercised by this run");
    expect(out).toContain("charge.refunded.contract.json");
  });

  it("infer merge on second run never narrows; --rebuild replaces", () => {
    writeConfig();
    writeFixtures("stripe", "charge.succeeded", [{ amount: 100 }, { amount: "oops" }]);
    runInfer({ cwd, log: quiet, now });
    rmSync(join(cwd, "fixtures"), { recursive: true });
    writeFixtures("stripe", "charge.succeeded", [{ amount: 100 }]);
    runInfer({ cwd, log: quiet, now }); // merge keeps the string type
    expect(runCheck({ cwd, log: quiet, now })).toBe(0);
    runInfer({ cwd, rebuild: true, log: quiet, now }); // rebuild narrows to number only
    rmSync(join(cwd, "fixtures"), { recursive: true });
    writeFixtures("stripe", "charge.succeeded", [{ amount: "oops" }]);
    expect(runCheck({ cwd, log: quiet, now })).toBe(1);
  });
});
