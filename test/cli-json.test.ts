import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * True end-to-end: spawns the compiled CLI (dist/cli.js) as a child process,
 * exactly as npx would, and asserts on real stdout/stderr/exit codes. The
 * other --json coverage calls runCheck() in-process; this is the only test
 * that would catch a break in the bin wiring itself.
 */
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

function runCli(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  // spawnSync rather than execFileSync: the latter only yields stdout on a
  // zero exit, and this suite asserts on stderr in success cases too.
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.error) throw res.error;
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

let cwd: string;
beforeEach(() => {
  if (!existsSync(CLI)) {
    throw new Error(`dist/cli.js not found - run \`npm run build\` before the test suite`);
  }
  cwd = mkdtempSync(join(tmpdir(), "hookdrift-e2e-"));
  writeFileSync(
    join(cwd, "hookdrift.config.json"),
    JSON.stringify({
      contractsDir: ".hookdrift",
      providers: { stripe: { fixtures: "fx/**/*.json", eventPath: "type" } },
      source: [],
      minSamples: 1,
    }),
  );
  mkdirSync(join(cwd, "fx"), { recursive: true });
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function writeFixtures(payloads: object[]) {
  rmSync(join(cwd, "fx"), { recursive: true, force: true });
  mkdirSync(join(cwd, "fx"), { recursive: true });
  payloads.forEach((p, i) =>
    writeFileSync(join(cwd, "fx", `${i}.json`), JSON.stringify({ type: "charge.succeeded", ...p })),
  );
}

describe("help and version aliases through the compiled CLI", () => {
  it("-h, --help and help all print usage and exit 0", () => {
    for (const alias of ["-h", "--help", "help"]) {
      const res = runCli([alias], cwd);
      expect(res.status, alias).toBe(0);
      expect(res.stdout, alias).toContain("hookdrift check");
    }
  });

  it("-v, --version and version all print the package version and exit 0", () => {
    const outputs = ["-v", "--version", "version"].map((alias) => {
      const res = runCli([alias], cwd);
      expect(res.status, alias).toBe(0);
      return res.stdout.trim();
    });
    expect(new Set(outputs).size).toBe(1);
    expect(outputs[0]).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("check --json end-to-end through the compiled CLI", () => {
  it("emits a single valid JSON document with the findings array, exit 0 when nothing breaks", () => {
    writeFixtures([{ amount: 100 }, { amount: 200 }]);
    expect(runCli(["infer"], cwd).status).toBe(0);

    const res = runCli(["check", "--json"], cwd);
    expect(res.status).toBe(0);
    const report = JSON.parse(res.stdout); // throws if stdout is not pure JSON
    expect(report.exitCode).toBe(0);
    expect(Array.isArray(report.findings)).toBe(true);
    expect(report.findings).toHaveLength(0);
  });

  it("exit 1 on breaking drift, stdout still valid JSON carrying the finding", () => {
    writeFixtures([{ amount: 100 }, { amount: 200 }]);
    runCli(["infer"], cwd);
    writeFixtures([{ amount: "broken" }, { amount: "also broken" }]);

    const res = runCli(["check", "--json"], cwd);
    expect(res.status).toBe(1);
    const report = JSON.parse(res.stdout);
    expect(report.exitCode).toBe(1);
    expect(report.findings.some((f: { severity: string }) => f.severity === "BREAKING")).toBe(true);
    expect(report.findings.some((f: { kind: string }) => f.kind === "type_changed")).toBe(true);
  });

  it("keeps stdout pure JSON when incidental notes exist - they go to stderr", () => {
    writeFixtures([{ amount: 100 }]);
    runCli(["infer"], cwd);
    writeFileSync(join(cwd, "fx", "broken.json"), "{not json");

    const res = runCli(["check", "--json"], cwd);
    expect(res.status).toBe(0);
    expect(() => JSON.parse(res.stdout)).not.toThrow();
    expect(res.stderr).toContain("skipped");
  });

  it("--strict flips warning-only runs to exit 1 in --json mode too", () => {
    writeFixtures([{ amount: 100, opt: 1 }, { amount: 100, opt: 1 }]);
    runCli(["infer"], cwd);
    writeFixtures([{ amount: 100, opt: 1 }, { amount: 100 }]); // required -> optional = WARNING

    expect(runCli(["check", "--json"], cwd).status).toBe(0);
    const strict = runCli(["check", "--json", "--strict"], cwd);
    expect(strict.status).toBe(1);
    expect(JSON.parse(strict.stdout).exitCode).toBe(1);
  });
});
