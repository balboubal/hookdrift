import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { eventFileName, loadContract } from "../src/core/contract.js";
import { parseFailure } from "../src/core/fixtures.js";
import { plain } from "../src/core/text.js";
import { runInfer } from "../src/commands/infer.js";
import { runCheck, type LastRun } from "../src/commands/check.js";

/**
 * Fixes for the 0.1.3 adversarial review. Every case here reproduced against
 * 0.1.3-pre before it was changed; the assertions pin the behaviour that
 * replaced it.
 */
const now = () => "2026-08-04T00:00:00.000Z";
const quiet = () => {};

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "hookdrift-id-"));
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
const fixture = (name: string, payload: object) =>
  writeFileSync(join(cwd, "fx", name), JSON.stringify(payload));
const contracts = () => {
  const dir = join(cwd, ".hookdrift", "p");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
};
const lastRun = (): LastRun =>
  JSON.parse(readFileSync(join(cwd, ".hookdrift", "last-run.json"), "utf8"));

describe("event names map to storage identities without collisions", () => {
  it("does not merge the hand-constructed 32-bit hash collision", () => {
    // h = 31h + charCode: 31*47 + 768 == 31*63 + 272 == 2225, and both names
    // sanitized to "__", so 0.1.3-pre wrote both events to __~1pt.contract.json.
    writeConfig();
    fixture("a.json", { type: "/\u0300", onlyA: 1 });
    fixture("b.json", { type: "?\u0110", onlyB: 2 });
    expect(runInfer({ cwd, log: quiet, now })).toBe(0);

    expect(contracts()).toHaveLength(2);
    for (const f of contracts()) {
      const c = JSON.parse(readFileSync(join(cwd, ".hookdrift", "p", f), "utf8"));
      expect(Object.keys(c.fields)).not.toEqual(
        expect.arrayContaining(["onlyA", "onlyB"]),
      );
    }
  });

  it("keeps case-only and reserved-name events apart", () => {
    // Windows and macOS compare filenames case-insensitively, so Event/event
    // shared one file; CON.contract.json cannot be created on Windows at all.
    expect(eventFileName("Event")).not.toBe(eventFileName("event"));
    expect(eventFileName("event")).toBe("event.contract.json");
    expect(eventFileName("CON")).toMatch(/^CON~[0-9a-f]{16}\.contract\.json$/);
    expect(eventFileName("trailing.")).toContain("~");
  });

  it("leaves real provider event names in their plain readable form", () => {
    // The migration cost of the new scheme must be zero for actual providers.
    for (const e of [
      "checkout.session.completed",
      "payment_intent.amount_capturable_updated",
      "customer.subscription.pending_update_expired",
      "checkouts_update",
      "issues",
    ]) {
      expect(eventFileName(e)).toBe(`${e}.contract.json`);
    }
  });

  it("refuses a contract file whose stored identity is not the one requested", () => {
    writeConfig();
    fixture("a.json", { type: "alpha", a: 1 });
    runInfer({ cwd, log: quiet, now });
    const file = join(cwd, ".hookdrift", "p", "alpha.contract.json");
    const c = JSON.parse(readFileSync(file, "utf8"));
    c.event = "beta";
    writeFileSync(file, JSON.stringify(c));

    expect(() => loadContract(file, { provider: "p", event: "alpha" })).toThrow(
      /Refusing to merge two identities/,
    );
    // check surfaces it as a finding rather than dying.
    expect(runCheck({ cwd, log: quiet, now })).toBe(1);
    expect(lastRun().findings[0]!.kind).toBe("invalid_contract");
  });

  it("isolates an over-long event instead of aborting every other event", () => {
    writeConfig();
    fixture("ok.json", { type: "fine", a: 1 });
    fixture("long.json", { type: "a".repeat(300), a: 1 });
    const lines: string[] = [];

    expect(runInfer({ cwd, log: (l) => lines.push(l), now })).toBe(1);
    expect(lines.join("\n")).toMatch(/identity longer than 200 characters/);
    expect(contracts()).toEqual(["fine.contract.json"]);
  });
});

describe("filesystem containment is physical, not lexical", () => {
  it("refuses to follow a link out of contractsDir", () => {
    writeConfig();
    mkdirSync(join(cwd, ".hookdrift"), { recursive: true });
    const outside = join(cwd, "outside");
    mkdirSync(outside);
    try {
      symlinkSync(outside, join(cwd, ".hookdrift", "p"), "junction");
    } catch {
      return; // unprivileged Windows without developer mode
    }
    fixture("0.json", { type: "e", a: 1 });

    expect(runInfer({ cwd, log: quiet, now })).toBe(1);
    expect(existsSync(join(outside, "e.contract.json"))).toBe(false);
  });

  it("refuses a contractsDir outside the project", () => {
    writeConfig({ contractsDir: "../escaped" });
    fixture("0.json", { type: "e", a: 1 });
    expect(main(["infer"], cwd)).toBe(2);
  });
});

describe("contract validation rejects self-contradictory files", () => {
  const write = (fields: object, samplesObserved = 100) => {
    mkdirSync(join(cwd, ".hookdrift", "p"), { recursive: true });
    writeFileSync(
      join(cwd, ".hookdrift", "p", "e.contract.json"),
      JSON.stringify({
        version: 1,
        provider: "p",
        event: "e",
        samplesObserved,
        firstSeen: "2026-01-01T00:00:00Z",
        lastUpdated: "2026-01-01T00:00:00Z",
        fields,
      }),
    );
    return join(cwd, ".hookdrift", "p", "e.contract.json");
  };

  it("rejects presence that contradicts the exact count", () => {
    // Accepted by 0.1.3-pre: the field then read as never-present, so its
    // complete disappearance came out as INFO with exit 0.
    const f = write({ x: { types: ["number"], presence: 0, containCount: 100 } });
    expect(() => loadContract(f)).toThrow(/contradicts containCount/);
  });

  it("rejects a count larger than the sample total", () => {
    const f = write({ x: { types: ["number"], presence: 1, containCount: 101 } });
    expect(() => loadContract(f)).toThrow(/exceeds samplesObserved/);
  });

  it("rejects enum, polymorphic and timestamp contradictions", () => {
    expect(() =>
      loadContract(write({ x: { types: ["number"], presence: 1, enum: ["a"] } })),
    ).toThrow(/enums are string-only/);
    expect(() =>
      loadContract(
        write({ x: { types: ["string"], presence: 1, enum: ["a", "a"] } }),
      ),
    ).toThrow(/duplicate enum values/);
    expect(() =>
      loadContract(
        write({ x: { types: ["string"], presence: 1, enumAuthoritative: true } }),
      ),
    ).toThrow(/no enum/);
    expect(() =>
      loadContract(
        write({ x: { types: ["string", "number"], presence: 1, polymorphic: true } }),
      ),
    ).toThrow(/string\/object expandable pair/);
  });

  it("still accepts a contract written by the previous release", () => {
    // No containCount: pre-0.1.3 contracts must keep loading.
    const f = write({ x: { types: ["string"], presence: 0.5 } }, 10);
    expect(loadContract(f)!.samplesObserved).toBe(10);
  });
});

describe("payload values do not leak through incidental channels", () => {
  it("reports a parse failure without quoting the file", () => {
    // Node: `Unexpected token 's', "{"token":sk_live_SE"... is not valid JSON`
    expect(parseFailure(new Error(`Unexpected token 's', "{"token":sk_live_SE"... is not valid JSON`)))
      .not.toMatch(/sk_live/);
    expect(parseFailure(new Error("Expected ',' or '}' after property value in JSON at position 6 (line 1 column 7)")))
      .toBe("invalid JSON at line 1 column 7");
    expect(parseFailure(new Error("Unexpected end of JSON input"))).toMatch(/truncated/);
  });

  it("keeps a secret-shaped fixture out of coverage.skipped", () => {
    writeConfig();
    fixture("ok.json", { type: "e", a: 1 });
    runInfer({ cwd, log: quiet, now });
    writeFileSync(join(cwd, "fx", "bad.json"), '{"token":sk_live_SECRET123}');

    runCheck({ cwd, log: quiet, now });
    expect(JSON.stringify(lastRun().coverage.skipped)).not.toMatch(/sk_live/);
  });

  it("warns when the event name itself looks like data", () => {
    writeConfig();
    fixture("0.json", { type: "sk_live_EVENTSECRET", a: 1 });
    const lines: string[] = [];
    runInfer({ cwd, log: (l) => lines.push(l), now });
    expect(lines.join("\n")).toMatch(/event name itself looks like data/);
  });

  it("never records an over-long string as an enum value", () => {
    writeConfig();
    for (let i = 0; i < 30; i++) fixture(`${i}.json`, { type: "e", blob: "x".repeat(5000) });
    runInfer({ cwd, log: quiet, now });
    const c = JSON.parse(
      readFileSync(join(cwd, ".hookdrift", "p", "e.contract.json"), "utf8"),
    );
    expect(c.fields.blob.enum).toBeUndefined();
  });

  it("strips terminal control and bidi bytes from human output only", () => {
    expect(plain("e\u001b[31mRED")).toBe("e[31mRED");
    expect(plain("a\u202eb\u200bc")).toBe("abc");
    // An object key becomes a contract path, so a hostile key is the channel
    // that carries provider text into a finding message and then the terminal.
    writeConfig();
    fixture("0.json", { type: "e", "\u001b[31mred": 1 });
    runInfer({ cwd, log: quiet, now });
    fixture("0.json", { type: "e", t: 1 });
    const lines: string[] = [];
    runCheck({ cwd, log: (l) => lines.push(l), now });
    expect(lines.join("\n")).toContain("[31mred"); // path still reported
    expect(lines.join("\n")).not.toContain("\u001b"); // ...without the escape
    // --json is the machine channel and keeps the raw value.
    expect(JSON.stringify(lastRun())).toContain("\\u001b[31mred");
  });
});

describe("coverage counts and command aliases", () => {
  it("does not count a comparison that threw as a contract checked", () => {
    writeConfig();
    fixture("0.json", { type: "e", a: 1 });
    runInfer({ cwd, log: quiet, now });
    writeFileSync(
      join(cwd, "fx", "0.json"),
      '{"type":"e","d":' + '{"n":'.repeat(900) + "1" + "}".repeat(900) + "}",
    );

    expect(runCheck({ cwd, log: quiet, now })).toBe(1);
    expect(lastRun().coverage.contractsChecked).toBe(0);
    expect(lastRun().findings[0]!.message).toMatch(/could not compare/);
  });

  it("rejects unknown flags on --version and help too", () => {
    writeConfig();
    expect(main(["--version", "--bogus"], cwd)).toBe(2);
    expect(main(["help", "--bogus"], cwd)).toBe(2);
    expect(main(["--version"], cwd)).toBe(0);
    expect(main(["help"], cwd)).toBe(0);
  });

  it("keeps last-run.json out of the commit the README tells you to make", () => {
    // README: `git add .hookdrift && git commit`. That directory holds both the
    // contracts (meant to be committed) and the transient report of the last
    // check (not), so the documented command committed a file that then
    // reappeared dirty after every subsequent run.
    writeConfig();
    fixture("0.json", { type: "e", a: 1 });
    runInfer({ cwd, log: quiet, now });
    const ignore = join(cwd, ".hookdrift", ".gitignore");
    expect(existsSync(ignore)).toBe(true);
    expect(readFileSync(ignore, "utf8")).toMatch(/^last-run\.json$/m);

    // An existing rule is never clobbered.
    writeFileSync(ignore, "mine\n");
    runCheck({ cwd, log: quiet, now });
    expect(readFileSync(ignore, "utf8")).toBe("mine\n");
  });

  it("leaves no directory behind when a run matches nothing", () => {
    writeConfig({ providers: { p: { fixtures: "nothing/**/*.json", eventPath: "type" } } });
    expect(runInfer({ cwd, log: quiet, now })).toBe(1);
    expect(existsSync(join(cwd, ".hookdrift"))).toBe(false);
  });

  it("gives every check report a distinct runId", () => {
    writeConfig();
    fixture("0.json", { type: "e", a: 1 });
    runInfer({ cwd, log: quiet, now });
    runCheck({ cwd, log: quiet, now });
    const first = lastRun().runId;
    runCheck({ cwd, log: quiet, now });
    expect(first).toBeTruthy();
    expect(lastRun().runId).not.toBe(first);
  });
});
