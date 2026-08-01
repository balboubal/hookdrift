import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, writeDefaultConfig, CONFIG_FILE } from "../core/config.js";
import { formatFinding, type LastRun } from "./check.js";

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
    log("No drift detected.");
    return 0;
  }
  let lastEvent = "";
  for (const f of run.findings) {
    const key = `${f.provider}/${f.event}`;
    if (key !== lastEvent) {
      log(`\n${key}`);
      lastEvent = key;
    }
    log("  " + formatFinding(f, false).split("\n").join("\n  "));
  }
  return 0;
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
  hookdrift impact                  map last check's findings to code references
  hookdrift explain                 human-readable report of the last check

Contracts live in .hookdrift/<provider>/<event>.contract.json — commit them.
hookdrift makes no network calls.`);
  return 0;
}
