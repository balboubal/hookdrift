import { randomUUID } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { globSync } from "tinyglobby";
import type { Finding } from "../types.js";
import { loadConfig } from "../core/config.js";
import { loadFixtures } from "../core/fixtures.js";
import { observe } from "../core/observe.js";
import { contractPath, ensureContractsDir, loadContract, writeFileAtomic } from "../core/contract.js";
import { diffContract } from "../core/diff.js";
import { matchIgnore } from "../core/ignore.js";
import { plain } from "../core/text.js";

export interface CheckOptions {
  cwd: string;
  fixturesDir?: string;
  strict?: boolean;
  showSuppressed?: boolean;
  json?: boolean;
  /** Fail the run if any matched fixture could not be used. */
  failOnSkipped?: boolean;
  /** Fail the run if fixtures contained an event with no committed contract. */
  failOnUncontracted?: boolean;
  /** Fail the run if a committed contract received no fixtures. */
  failOnUnexercised?: boolean;
  log?: (line: string) => void;
  now?: () => string;
}

/**
 * What the run actually inspected. Findings alone cannot prove coverage: a run
 * that parsed nothing, skipped the one drifted fixture, or exercised no
 * committed contract produces an empty findings array that reads as health.
 */
export interface Coverage {
  /** True when a directory argument narrowed the run to a subset. */
  partial: boolean;
  filesMatched: number;
  filesParsed: number;
  /** Files matched by a glob but not usable, with the reason. */
  skipped: { file: string; reason: string }[];
  eventsObserved: number;
  contractsChecked: number;
  /** Committed contracts that received no fixtures this run. */
  contractsUnexercised: string[];
  /** Events present in fixtures with no committed contract. */
  eventsUncontracted: string[];
}

export interface LastRun {
  /**
   * Identifies this specific report. `impact` re-reads the file before writing
   * its references back and refuses to write if the id changed, so a check that
   * landed while impact was scanning is not overwritten by the older run.
   */
  runId: string;
  ranAt: string;
  strict: boolean;
  exitCode: number;
  coverage: Coverage;
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
    ? `  [suppressed${f.suppressReason ? `: ${plain(f.suppressReason)}` : ""}]`
    : "";
  // Paths and messages carry provider-controlled text. Terminals act on control
  // and bidi bytes, so they are stripped from every human channel; --json keeps
  // the raw values.
  const lines = [`${sev.padEnd(pad)} ${plain(f.path)}  ${plain(f.message)}${note}`];
  if (f.refs?.length) {
    lines.push("          referenced in:");
    for (const r of f.refs) lines.push(`            ${plain(r.file)}:${r.line}`);
  }
  return lines.join("\n");
}

/**
 * The nothing-matched message used to blame the fixtures globs without ever
 * mentioning the directory argument - and narrowing to a directory the globs do
 * not cover is the README's headline upgrade workflow. `infer` names both.
 */
function nothingMatchedMessage(
  config: { providers: Record<string, { fixtures: string }> },
  fixturesDir?: string,
): string {
  const globs = Object.values(config.providers).map((pc) => pc.fixtures).join(", ");
  return (
    `No contracts checked and no fixtures matched.\n` +
    `hookdrift looked for JSON files matching: ${globs || "(no providers configured)"}` +
    (fixturesDir
      ? `\n...restricted to "${fixturesDir}" by the directory argument, which filters those ` +
        `globs rather than widening them - a directory they do not cover matches nothing.`
      : "") +
    `\nFix the "fixtures" glob(s) in hookdrift.config.json` +
    (fixturesDir ? ` so they cover "${fixturesDir}", or drop the directory argument.` : ".")
  );
}

export function runCheck(opts: CheckOptions): number {
  const { cwd, fixturesDir } = opts;
  const json = opts.json ?? false;
  // In --json mode stdout is the report; route incidental notes to stderr.
  const log = opts.log ?? (json ? (l: string) => console.error(l) : console.log);
  const now = opts.now ?? (() => new Date().toISOString());
  const config = loadConfig(cwd);
  const strict = opts.strict ?? config.strict;
  const failOnSkipped = opts.failOnSkipped ?? config.failOnSkipped;
  const failOnUncontracted = opts.failOnUncontracted ?? config.failOnUncontracted;
  const failOnUnexercised = opts.failOnUnexercised ?? config.failOnUnexercised;
  const contractsDir = join(cwd, config.contractsDir);
  const findings: Finding[] = [];
  const exercised = new Set<string>();
  let checked = 0;
  const coverage: Coverage = {
    partial: Boolean(fixturesDir),
    filesMatched: 0,
    filesParsed: 0,
    skipped: [],
    eventsObserved: 0,
    contractsChecked: 0,
    contractsUnexercised: [],
    eventsUncontracted: [],
  };

  for (const [provider, pc] of Object.entries(config.providers)) {
    const batch = loadFixtures(cwd, pc.fixtures, pc.eventPath, fixturesDir);
    coverage.filesMatched += batch.fileCount;
    coverage.skipped.push(
      ...batch.skipped.map((s) => ({ file: relative(cwd, s.file).replace(/\\/g, "/"), reason: s.reason })),
    );
    coverage.eventsObserved += batch.events.size;
    for (const [, s] of batch.events) coverage.filesParsed += s.length;
    for (const s of batch.skipped) {
      log(`  skipped ${plain(relative(cwd, s.file).replace(/\\/g, "/"))}: ${s.reason}`);
    }
    for (const [event, samples] of [...batch.events.entries()].sort()) {
      // One unreadable contract must not abort the run: it used to throw out of
      // runCheck, losing every finding from every other contract - including
      // genuine BREAKING drift elsewhere - and leaving last-run.json stale so
      // explain/impact then reported the previous run as current health.
      // It is reported as its own BREAKING finding and the run continues.
      // Resolving the path can itself throw (over-long or escaping identity),
      // so it is inside the guard too.
      let contract;
      try {
        const file = contractPath(contractsDir, provider, event);
        exercised.add(resolve(file));
        contract = loadContract(file, { provider, event });
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
        coverage.eventsUncontracted.push(`${provider}/${event}`);
        findings.push({
          provider,
          event,
          path: "",
          severity: failOnUncontracted ? "BREAKING" : "INFO",
          kind: "uncontracted_event",
          message:
            `${samples.length} sample(s) observed but no committed contract - run \`hookdrift infer\` to create one` +
            (failOnUncontracted ? " [--fail-on-uncontracted]" : ""),
        });
        continue;
      }
      try {
        const results = diffContract(contract, observe(samples), {
          minSamples: config.minSamples,
        });
        // Counted only once the comparison actually succeeded. Incrementing
        // before the diff let a contract that threw still be reported as
        // "checked", which is the one number a CI wrapper reads to decide
        // whether coverage was real.
        checked += 1;
        findings.push(...results);
      } catch (e) {
        // e.g. a payload nested past MAX_DEPTH. Name the event instead of dying
        // with an unattributed stack overflow, and fail the run.
        findings.push({
          provider,
          event,
          path: "",
          severity: "BREAKING",
          kind: "invalid_contract",
          message: `could not compare ${samples.length} sample(s): ${(e as Error).message}`,
        });
      }
    }
  }

  // A committed contract whose event produced no fixtures this run is not
  // checked - and silence about that is how coverage decays invisibly (a
  // capture pipeline that stops emitting one event type keeps CI green
  // forever). Say so. A note rather than a failure, because partial runs
  // against a fixtures subdirectory are legitimate.
  const onDisk = globSync("*/*.contract.json", { cwd: contractsDir, absolute: true });
  const unexercised = onDisk.filter((f) => !exercised.has(resolve(f)));
  coverage.contractsChecked = checked;
  coverage.contractsUnexercised = unexercised
    .map((f) => relative(contractsDir, f).replace(/\\/g, "/"))
    .sort();
  if (unexercised.length > 0) {
    const names = coverage.contractsUnexercised.slice(0, 5).join(", ");
    const tail = `${names}${unexercised.length > 5 ? ", ..." : ""}`;
    if (failOnUnexercised) {
      // The gate that makes a green run mean "every committed contract was
      // actually compared" - without it, a capture pipeline that quietly stops
      // emitting one event type keeps CI green forever.
      findings.push({
        provider: "",
        event: "",
        path: "",
        severity: "BREAKING",
        kind: "unexercised_contract",
        message:
          `${unexercised.length} committed contract(s) received no fixtures this run [--fail-on-unexercised]: ${tail}` +
          (coverage.partial
            ? ` - the directory argument narrowed this run, so either widen it or drop --fail-on-unexercised for partial runs`
            : ""),
      });
    } else {
      log(
        `note: ${unexercised.length} committed contract(s) not exercised by this run (no matching fixtures): ${tail}`,
      );
    }
  }

  // A fixture that could not be parsed or had no event is a hole in coverage:
  // the very file carrying the breaking shape may be the one that was skipped.
  // Visible always; fatal under --fail-on-skipped.
  if (coverage.skipped.length > 0 && failOnSkipped) {
    findings.push({
      provider: "",
      event: "",
      path: "",
      severity: "BREAKING",
      kind: "skipped_fixture",
      message: `${coverage.skipped.length} matched fixture(s) could not be used, so their contents went unchecked [--fail-on-skipped]: ${coverage.skipped
        .slice(0, 5)
        .map((s) => s.file)
        .join(", ")}${coverage.skipped.length > 5 ? ", ..." : ""}`,
    });
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
  // "OK, no drift" over a corpus that mostly failed to parse is exactly the
  // silent success this tool exists to prevent: 9 of 10 unreadable fixtures
  // still printed a clean OK line. Every summary now carries the hole.
  const skippedNote =
    coverage.skipped.length > 0
      ? ` (${coverage.skipped.length} of ${coverage.filesMatched} matched fixture(s) could not be read` +
        `${failOnSkipped ? "" : "; --fail-on-skipped to fail on that"})`
      : "";
  const nothingMatched = checked === 0 && findings.length === 0;
  const exitCode = nothingMatched || breaking > 0 || (strict && warning > 0) ? 1 : 0;

  // Persist for `explain` and `impact`.
  ensureContractsDir(contractsDir);
  const report: LastRun = { runId: randomUUID(), ranAt: now(), strict, exitCode, coverage, findings };
  writeFileAtomic(join(contractsDir, "last-run.json"), JSON.stringify(report, null, 2) + "\n");

  if (json) {
    // The nothing-matched failure has no finding to carry it, so in --json mode
    // it would otherwise reach CI as exit 1 with an empty findings array and no
    // explanation anywhere. Diagnose on stderr, keeping stdout pure JSON.
    if (nothingMatched) {
      log(nothingMatchedMessage(config, fixturesDir));
    }
    (opts.log ?? console.log)(JSON.stringify(report, null, 2));
    return exitCode;
  }

  const color = useColor();
  const toShow = opts.showSuppressed ? findings : active;
  if (nothingMatched) {
    log(nothingMatchedMessage(config, fixturesDir));
  } else if (toShow.length === 0) {
    const supNote = suppressed > 0 ? ` (${suppressed} suppressed)` : "";
    log(`OK ${checked} contract(s) checked - no unsuppressed drift${supNote}.${skippedNote}`);
  } else {
    let lastEvent = "";
    for (const f of toShow) {
      // Run-level findings (a skipped-fixture failure) have no provider or
      // event, and rendered under a bare "/" heading.
      const key = f.provider || f.event ? plain(`${f.provider}/${f.event}`) : "(run)";
      if (key !== lastEvent) {
        log(`\n${key}`);
        lastEvent = key;
      }
      log("  " + formatFinding(f, color).split("\n").join("\n  "));
    }
    const supNote = suppressed > 0 ? ` (${suppressed} suppressed)` : "";
    log(
      `\n${breaking} breaking, ${warning} warning(s), ${info} info${supNote} across ${checked} contract(s)${strict ? " [strict]" : ""}${skippedNote}`,
    );
    if (suppressed > 0 && !opts.showSuppressed) {
      log(`Run with --show-suppressed to see suppressed findings.`);
    }
  }
  return exitCode;
}
