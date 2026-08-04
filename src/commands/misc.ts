import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, writeDefaultConfig, CONFIG_FILE } from "../core/config.js";
import { formatFinding, type LastRun } from "./check.js";
import { plain } from "../core/text.js";

export function runInit(cwd: string, log: (l: string) => void = console.log): number {
  const file = writeDefaultConfig(cwd);
  log(`Wrote ${file}`);
  log("Edit the providers block to point at your saved webhook payloads, then run:");
  log("  hookdrift infer");
  return 0;
}

export function runExplain(cwd: string, log: (l: string) => void = console.log): number {
  const config = loadConfig(cwd);
  const file = join(cwd, config.contractsDir, "last-run.json");
  if (!existsSync(file)) {
    log("No previous check found. Run `hookdrift check` first.");
    return 1;
  }
  const run = JSON.parse(readFileSync(file, "utf8")) as LastRun;
  log(`Last check: ${run.ranAt}${run.strict ? " [strict]" : ""} (exit ${run.exitCode})`);
  if (run.findings.length === 0) {
    if (run.exitCode !== 0) {
      // Zero findings with a failing exit means check ran but checked nothing
      // (its globs matched no fixtures). "No drift detected" would launder
      // that failure into health.
      log("The last check exited non-zero without checking anything - no fixtures matched.");
      log("That is not evidence of health. Fix the fixtures globs and re-run `hookdrift check`.");
      return run.exitCode;
    }
    log("No drift detected.");
    return 0;
  }
  let lastEvent = "";
  for (const f of run.findings) {
    const key = f.provider || f.event ? plain(`${f.provider}/${f.event}`) : "(run)";
    if (key !== lastEvent) {
      log(`\n${key}`);
      lastEvent = key;
    }
    log("  " + formatFinding(f, false).split("\n").join("\n  "));
  }
  // Mirror the run being explained, as `impact` already does. Exiting 0 while
  // printing BREAKING drift meant `hookdrift explain && deploy` deployed, and
  // made explain the one command whose exit code disagreed with the others.
  return run.exitCode;
}

export function usage(log: (l: string) => void = console.log): number {
  log(`hookdrift — detect webhook payload drift before it breaks your handler

Usage:
  hookdrift init                    create ${CONFIG_FILE}
  hookdrift infer [fixtures-dir]    build/update contracts from sample payloads
      --rebuild                     replace contracts instead of merging (allows narrowing)
  hookdrift check [fixtures-dir]    diff samples against committed contracts
      --strict                      warnings also cause a non-zero exit
      --json                        machine-readable findings on stdout
      --show-suppressed             include findings silenced by ignore rules
      --fail-on-skipped             fail if a matched fixture could not be parsed
      --fail-on-uncontracted        fail if an event has no committed contract
      --fail-on-unexercised         fail if a committed contract got no fixtures
  hookdrift impact                  map last check's findings to code references
      --strict                      warnings also cause a non-zero exit
  hookdrift explain                 re-print the last check (mirrors its exit code)
  hookdrift --version               print the installed version

The --fail-on flags have config equivalents ("failOnSkipped",
"failOnUncontracted", "failOnUnexercised"). All default to off: a coverage hole
is always reported in the "coverage" block of --json, but only fails the run
when you ask it to. The three together make a green run mean "every fixture
parsed, every event had a contract, every contract was exercised".

Exit codes: 0 = nothing that should fail a build; 1 = drift found, or the run
checked nothing at all; 2 = bad usage or bad config (nothing ran).

Contracts live in .hookdrift/<provider>/<event>.contract.json — commit them.
hookdrift makes no network calls.`);
  return 0;
}
