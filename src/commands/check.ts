import { writeFileSync, mkdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { globSync } from "tinyglobby";
import type { Finding } from "../types.js";
import { loadConfig } from "../core/config.js";
import { loadFixtures } from "../core/fixtures.js";
import { observe } from "../core/observe.js";
import { contractPath, loadContract } from "../core/contract.js";
import { diffContract } from "../core/diff.js";
import { matchIgnore } from "../core/ignore.js";

export interface CheckOptions {
  cwd: string;
  fixturesDir?: string;
  strict?: boolean;
  showSuppressed?: boolean;
  json?: boolean;
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
const DIM = "\x1b[2m";
const useColor = () => process.stdout.isTTY && !process.env.NO_COLOR;

export function formatFinding(f: Finding, color: boolean): string {
  let sev: string = f.severity;
  if (f.suppressed) {
    sev = color ? `${DIM}${f.severity}${RESET}` : f.severity;
  } else if (color) {
    sev = `${COLORS[f.severity]}${f.severity}${RESET}`;
  }
  const pad = color ? 18 : 9;
  const note = f.suppressed
    ? `  [suppressed${f.suppressReason ? `: ${f.suppressReason}` : ""}]`
    : "";
  const lines = [`${sev.padEnd(pad)} ${f.path}  ${f.message}${note}`];
  if (f.refs?.length) {
    lines.push("          referenced in:");
    for (const r of f.refs) lines.push(`            ${r.file}:${r.line}`);
  }
  return lines.join("\n");
}

export function runCheck(opts: CheckOptions): number {
  const { cwd, fixturesDir } = opts;
  const json = opts.json ?? false;
  // In --json mode stdout is the report; route incidental notes to stderr.
  const log = opts.log ?? (json ? (l: string) => console.error(l) : console.log);
  const now = opts.now ?? (() => new Date().toISOString());
  const config = loadConfig(cwd);
  const strict = opts.strict ?? config.strict;
  const contractsDir = join(cwd, config.contractsDir);
  const findings: Finding[] = [];
  const exercised = new Set<string>();
  let checked = 0;

  for (const [provider, pc] of Object.entries(config.providers)) {
    const batch = loadFixtures(cwd, pc.fixtures, pc.eventPath, fixturesDir);
    for (const s of batch.skipped) log(`  skipped ${s.file}: ${s.reason}`);
    for (const [event, samples] of [...batch.events.entries()].sort()) {
      exercised.add(resolve(contractPath(contractsDir, provider, event)));
      // One unreadable contract must not abort the run: it used to throw out of
      // runCheck, losing every finding from every other contract - including
      // genuine BREAKING drift elsewhere - and leaving last-run.json stale so
      // explain/impact then reported the previous run as current health.
      // It is reported as its own BREAKING finding and the run continues.
      let contract;
      try {
        contract = loadContract(contractPath(contractsDir, provider, event));
      } catch (e) {
        findings.push({
          provider,
          event,
          path: "",
          severity: "BREAKING",
          kind: "invalid_contract",
          message: `committed contract could not be read, so ${samples.length} sample(s) went unchecked: ${(e as Error).message.split("\n").join(" ")}`,
        });
        continue;
      }
      if (!contract) {
        findings.push({
          provider,
          event,
          path: "",
          severity: "INFO",
          kind: "uncontracted_event",
          message: `${samples.length} sample(s) observed but no committed contract - run \`hookdrift infer\` to create one`,
        });
        continue;
      }
      checked += 1;
      findings.push(
        ...diffContract(contract, observe(samples), { minSamples: config.minSamples }),
      );
    }
  }

  // A committed contract whose event produced no fixtures this run is not
  // checked - and silence about that is how coverage decays invisibly (a
  // capture pipeline that stops emitting one event type keeps CI green
  // forever). Say so. A note rather than a failure, because partial runs
  // against a fixtures subdirectory are legitimate.
  const onDisk = globSync("*/*.contract.json", { cwd: contractsDir, absolute: true });
  const unexercised = onDisk.filter((f) => !exercised.has(resolve(f)));
  if (unexercised.length > 0) {
    const names = unexercised
      .slice(0, 5)
      .map((f) => relative(contractsDir, f).replace(/\\/g, "/"))
      .join(", ");
    log(
      `note: ${unexercised.length} committed contract(s) not exercised by this run (no matching fixtures): ${names}${unexercised.length > 5 ? ", ..." : ""}`,
    );
  }

  // Ignore rules apply after diffing: findings are flagged, never dropped, so
  // last-run.json (and --json) always retain the full picture.
  for (const f of findings) {
    const rule = matchIgnore(config.ignore, f);
    if (rule) {
      f.suppressed = true;
      if (rule.reason) f.suppressReason = rule.reason;
    }
  }

  const active = findings.filter((f) => !f.suppressed);
  const suppressed = findings.length - active.length;
  const breaking = active.filter((f) => f.severity === "BREAKING").length;
  const warning = active.filter((f) => f.severity === "WARNING").length;
  const info = active.length - breaking - warning;
  // Zero contracts checked AND zero findings means the fixtures globs matched
  // nothing at all - a typo'd path, not a healthy run. "No drift" would be
  // the silent-failure lie this tool exists to prevent, so fail loudly.
  // (Fixtures without contracts still produce uncontracted_event findings and
  // exit 0, so a first run before `infer` is unaffected.)
  const nothingMatched = checked === 0 && findings.length === 0;
  const exitCode = nothingMatched || breaking > 0 || (strict && warning > 0) ? 1 : 0;

  // Persist for `explain` and `impact`.
  mkdirSync(contractsDir, { recursive: true });
  const report: LastRun = { ranAt: now(), strict, exitCode, findings };
  writeFileSync(join(contractsDir, "last-run.json"), JSON.stringify(report, null, 2) + "\n", "utf8");

  if (json) {
    // The nothing-matched failure has no finding to carry it, so in --json mode
    // it would otherwise reach CI as exit 1 with an empty findings array and no
    // explanation anywhere. Diagnose on stderr, keeping stdout pure JSON.
    if (nothingMatched) {
      log(
        `No contracts checked and no fixtures matched - check the fixtures globs in hookdrift.config.json.`,
      );
    }
    (opts.log ?? console.log)(JSON.stringify(report, null, 2));
    return exitCode;
  }

  const color = useColor();
  const toShow = opts.showSuppressed ? findings : active;
  if (nothingMatched) {
    log(
      `No contracts checked and no fixtures matched - check the fixtures globs in hookdrift.config.json.`,
    );
  } else if (toShow.length === 0) {
    const supNote = suppressed > 0 ? ` (${suppressed} suppressed)` : "";
    log(`OK ${checked} contract(s) checked - no unsuppressed drift${supNote}.`);
  } else {
    let lastEvent = "";
    for (const f of toShow) {
      const key = `${f.provider}/${f.event}`;
      if (key !== lastEvent) {
        log(`\n${key}`);
        lastEvent = key;
      }
      log("  " + formatFinding(f, color).split("\n").join("\n  "));
    }
    const supNote = suppressed > 0 ? ` (${suppressed} suppressed)` : "";
    log(
      `\n${breaking} breaking, ${warning} warning(s), ${info} info${supNote} across ${checked} contract(s)${strict ? " [strict]" : ""}`,
    );
    if (suppressed > 0 && !opts.showSuppressed) {
      log(`Run with --show-suppressed to see suppressed findings.`);
    }
  }
  return exitCode;
}
