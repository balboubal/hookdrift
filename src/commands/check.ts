import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "../types.js";
import { loadConfig } from "../core/config.js";
import { loadFixtures } from "../core/fixtures.js";
import { observe } from "../core/observe.js";
import { contractPath, loadContract } from "../core/contract.js";
import { diffContract } from "../core/diff.js";

export interface CheckOptions {
  cwd: string;
  fixturesDir?: string;
  strict?: boolean;
  log?: (line: string) => void;
  now?: () => string;
}

export interface LastRun {
  ranAt: string;
  strict: boolean;
  exitCode: number;
  findings: Finding[];
}

const COLORS: Record<string, string> = {
  BREAKING: "\x1b[31m",
  WARNING: "\x1b[33m",
  INFO: "\x1b[36m",
};
const RESET = "\x1b[0m";
const useColor = () => process.stdout.isTTY && !process.env.NO_COLOR;

export function formatFinding(f: Finding, color: boolean): string {
  const sev = color ? `${COLORS[f.severity]}${f.severity}${RESET}` : f.severity;
  const lines = [`${sev.padEnd(color ? 18 : 9)} ${f.path}  ${f.message}`];
  if (f.refs?.length) {
    lines.push("          referenced in:");
    for (const r of f.refs) lines.push(`            ${r.file}:${r.line}`);
  }
  return lines.join("\n");
}

export function runCheck(opts: CheckOptions): number {
  const { cwd, fixturesDir } = opts;
  const log = opts.log ?? console.log;
  const now = opts.now ?? (() => new Date().toISOString());
  const config = loadConfig(cwd);
  const strict = opts.strict ?? config.strict;
  const contractsDir = join(cwd, config.contractsDir);
  const findings: Finding[] = [];
  let checked = 0;

  for (const [provider, pc] of Object.entries(config.providers)) {
    const batch = loadFixtures(cwd, pc.fixtures, pc.eventPath, fixturesDir);
    for (const s of batch.skipped) log(`  skipped ${s.file}: ${s.reason}`);
    for (const [event, samples] of [...batch.events.entries()].sort()) {
      const contract = loadContract(contractPath(contractsDir, provider, event));
      if (!contract) {
        findings.push({
          provider,
          event,
          path: "",
          severity: "INFO",
          kind: "uncontracted_event",
          message: `${samples.length} sample(s) observed but no committed contract — run \`hookdrift infer\` to create one`,
        });
        continue;
      }
      checked += 1;
      findings.push(...diffContract(contract, observe(samples)));
    }
  }

  const breaking = findings.filter((f) => f.severity === "BREAKING").length;
  const warning = findings.filter((f) => f.severity === "WARNING").length;
  const info = findings.length - breaking - warning;
  const exitCode = breaking > 0 || (strict && warning > 0) ? 1 : 0;

  // Persist for `explain` and `impact`.
  mkdirSync(contractsDir, { recursive: true });
  const report: LastRun = { ranAt: now(), strict, exitCode, findings };
  writeFileSync(join(contractsDir, "last-run.json"), JSON.stringify(report, null, 2) + "\n", "utf8");

  const color = useColor();
  if (findings.length === 0) {
    log(`✓ ${checked} contract(s) checked — no drift detected.`);
  } else {
    let lastEvent = "";
    for (const f of findings) {
      const key = `${f.provider}/${f.event}`;
      if (key !== lastEvent) {
        log(`\n${key}`);
        lastEvent = key;
      }
      log("  " + formatFinding(f, color).split("\n").join("\n  "));
    }
    log(
      `\n${breaking} breaking, ${warning} warning(s), ${info} info across ${checked} contract(s)${strict ? " [strict]" : ""}`,
    );
  }
  return exitCode;
}
