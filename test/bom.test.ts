import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";
import { loadFixtures } from "../src/core/fixtures.js";
import { loadContract, saveContract, buildContract } from "../src/core/contract.js";
import { observe } from "../src/core/observe.js";
import { runInfer } from "../src/commands/infer.js";

/**
 * UTF-8 BOM tolerance. Windows adds BOMs freely - PowerShell redirection writes
 * one, so the README's own `stripe listen > events.jsonl` instruction produces
 * BOM-prefixed files. Before 0.1.1 a BOM made `loadConfig` throw and made every
 * fixture skip silently, which surfaced as "0 samples" with no error.
 */
const BOM = "\uFEFF";
const NOW = "2026-08-02T00:00:00.000Z";
const quiet = () => {};
const now = () => NOW;

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "hookdrift-bom-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const CONFIG = {
  contractsDir: ".hookdrift",
  providers: { stripe: { fixtures: "fx/**/*.json", eventPath: "type" } },
  source: [],
  minSamples: 1,
};

function writeConfig(withBom: boolean) {
  writeFileSync(
    join(cwd, "hookdrift.config.json"),
    (withBom ? BOM : "") + JSON.stringify(CONFIG, null, 2),
    "utf8",
  );
}

function writeFixtures(withBom: boolean, n = 4) {
  const d = join(cwd, "fx");
  mkdirSync(d, { recursive: true });
  for (let i = 0; i < n; i++) {
    writeFileSync(
      join(d, `${i}.json`),
      (withBom ? BOM : "") + JSON.stringify({ type: "charge.succeeded", amount: 100 + i }),
      "utf8",
    );
  }
}

describe("config with a UTF-8 BOM", () => {
  it("loads correctly instead of throwing", () => {
    writeConfig(true);
    const c = loadConfig(cwd);
    expect(c.providers.stripe!.fixtures).toBe("fx/**/*.json");
    expect(c.contractsDir).toBe(".hookdrift");
  });

  it("parses identically to the BOM-free form", () => {
    writeConfig(true);
    const withBom = loadConfig(cwd);
    writeConfig(false);
    expect(withBom).toEqual(loadConfig(cwd));
  });
});

describe("fixtures with a UTF-8 BOM", () => {
  // The case that matters most: this failed silently, reporting no error and
  // simply producing zero samples.
  it("are parsed rather than silently skipped", () => {
    writeFixtures(true);
    const batch = loadFixtures(cwd, "fx/**/*.json", "type");
    expect(batch.skipped).toEqual([]);
    expect(batch.fileCount).toBe(4);
    expect(batch.events.get("charge.succeeded")).toHaveLength(4);
  });

  it("produce a real contract through infer, not an empty run", () => {
    writeConfig(false);
    writeFixtures(true);
    const lines: string[] = [];
    expect(runInfer({ cwd, log: (l) => lines.push(l), now })).toBe(0);
    const out = lines.join("\n");
    expect(out).not.toContain("skipped");
    expect(out).toContain("4 new sample(s)");
    expect(out).not.toContain("No contracts written");
  });

  it("still reports genuinely malformed JSON as skipped", () => {
    writeFixtures(true, 2);
    writeFileSync(join(cwd, "fx", "broken.json"), BOM + "{not json", "utf8");
    const batch = loadFixtures(cwd, "fx/**/*.json", "type");
    expect(batch.skipped).toHaveLength(1);
    expect(batch.skipped[0]!.reason).toContain("invalid JSON");
    expect(batch.events.get("charge.succeeded")).toHaveLength(2);
  });
});

describe("committed contract with a UTF-8 BOM", () => {
  it("loads correctly", () => {
    const file = join(cwd, "c.contract.json");
    const contract = buildContract("stripe", "charge.succeeded", observe([{ amount: 1 }]), NOW);
    saveContract(file, contract);
    // Simulate an editor that re-saved the committed file with a BOM.
    const raw = BOM + JSON.stringify(contract, null, 2);
    writeFileSync(file, raw, "utf8");
    expect(loadContract(file)).toEqual(contract);
  });
});

describe("hookdrift never writes a BOM itself", () => {
  it("infer output is BOM-free", () => {
    writeConfig(false);
    writeFixtures(false);
    runInfer({ cwd, log: quiet, now });
    const file = join(cwd, ".hookdrift", "stripe", "charge.succeeded.contract.json");
    const bytes = readFileSync(file);
    expect([bytes[0], bytes[1], bytes[2]]).not.toEqual([0xef, 0xbb, 0xbf]);
  });
});
