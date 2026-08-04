import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { globSync } from "tinyglobby";
import type { Finding } from "../types.js";
import { loadConfig } from "../core/config.js";
import { writeFileAtomic } from "../core/contract.js";
import { formatFinding, type LastRun } from "./check.js";
import { plain } from "../core/text.js";

const MAX_REFS_PER_FINDING = 10;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Dotted path -> searchable segments ("data.object.refunds[].id" -> [data, object, refunds, id]). */
function segmentsOf(path: string): string[] {
  return path
    .split(".")
    .map((s) => s.replace(/\[\]$/, ""))
    .filter(Boolean);
}

interface Matcher {
  regex: RegExp;
  score: number;
}

/**
 * Longest-suffix textual matchers for one path. `a?.b.c` and `a.b.c` both
 * count as a full-chain match; a lone leaf via property access scores 1/n and
 * a bare identifier (destructuring, local variable) scores 0.5/n.
 */
function buildMatchers(segs: string[]): Matcher[] {
  const n = segs.length;
  // Some legitimate paths reduce to zero searchable segments - an array-root
  // payload's "[]" element path, or a literal key made of dots. Nothing
  // textual can be searched for; the finding is still printed, just with no
  // code references, instead of crashing on segs[-1].
  if (n === 0) return [];
  const out: Matcher[] = [];
  for (let k = n; k >= 2; k--) {
    const chain = segs.slice(-k).map(esc).join("\\??\\.");
    out.push({ regex: new RegExp(chain + "\\b"), score: k / n });
  }
  const leaf = esc(segs[n - 1]!);
  out.push({ regex: new RegExp(`(?:\\.|\\?\\.|\\[["'])${leaf}\\b`), score: 1 / n });
  out.push({ regex: new RegExp(`\\b${leaf}\\b`), score: 0.5 / n });
  return out;
}

export function runImpact(
  cwd: string,
  log: (l: string) => void = console.log,
  strict?: boolean,
): number {
  const config = loadConfig(cwd);
  // Same resolution as check: explicit flag wins, config default otherwise.
  const strictEff = strict ?? config.strict;
  const runFile = join(cwd, config.contractsDir, "last-run.json");
  if (!existsSync(runFile)) {
    log("No previous check found. Run `hookdrift check` first.");
    return 1;
  }
  // Empty source globs used to return 1 unconditionally here, which after the
  // exit-semantics change masqueraded as the strict gate firing. Mapping is
  // impossible without globs, but the findings and the findings-based exit
  // code are still meaningful - fall through with a note instead.
  const canSearch = config.source.length > 0;
  if (!canSearch) {
    log(`No "source" globs configured in hookdrift.config.json - findings shown without code references.`);
  }
  const run = JSON.parse(readFileSync(runFile, "utf8")) as LastRun;
  // Exit semantics are computed over ALL unsuppressed findings, including the
  // pathless ones impact cannot map (root-level type changes, invalid
  // contracts). Mapping nothing is not the same as finding nothing, and impact
  // must never report health that contradicts the check it read.
  const unmappable = run.findings.filter((f) => !f.suppressed);
  const exitFor = (strictOn: boolean) =>
    unmappable.some((f) => f.severity === "BREAKING") ||
    (strictOn && unmappable.some((f) => f.severity === "WARNING"))
      ? 1
      : 0;

  const targets = run.findings.filter((f) => f.path && !f.suppressed);
  if (targets.length === 0) {
    if (run.exitCode !== 0 && run.findings.length === 0) {
      // check failed without producing findings: it checked nothing. Mirror
      // that failure instead of reporting "nothing to map" with exit 0.
      log("The last check exited non-zero without checking anything - no fixtures matched.");
      return run.exitCode;
    }
    if (unmappable.length > 0) {
      log(
        `Last check produced ${unmappable.length} finding(s), none with a searchable path (root-level or contract-level) - nothing to map.`,
      );
      for (const f of unmappable) {
        log("  " + formatFinding(f, false).split("\n").join("\n  "));
      }
      return exitFor(strictEff);
    }
    log("Last check produced no unsuppressed findings - nothing to map.");
    return 0;
  }

  // Findings loaded from last-run.json may already carry refs from a previous
  // impact run; the file is rewritten below, so without this reset every rerun
  // appended duplicates until the ref cap evicted genuine references.
  for (const f of targets) delete f.refs;

  const files = canSearch
    ? [...new Set(config.source.flatMap((g) => globSync(g, { cwd, absolute: true })))].sort()
    : [];
  const matchers = targets.map((f) => buildMatchers(segmentsOf(f.path)));

  for (const file of files) {
    const rel = relative(cwd, file).replace(/\\/g, "/");
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, idx) => {
      targets.forEach((finding, ti) => {
        let best = 0;
        for (const m of matchers[ti]!) {
          if (m.score <= best) break; // matchers are ordered by descending score
          if (m.regex.test(line)) best = m.score;
        }
        if (best > 0) {
          (finding.refs ??= []).push({ file: rel, line: idx + 1, score: Math.round(best * 100) / 100 });
        }
      });
    });
  }

  const droppedRefs = new Map<Finding, number>();
  for (const f of targets) {
    if (f.refs) {
      f.refs.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line);
      if (f.refs.length > MAX_REFS_PER_FINDING) {
        droppedRefs.set(f, f.refs.length - MAX_REFS_PER_FINDING);
        f.refs = f.refs.slice(0, MAX_REFS_PER_FINDING);
      }
    }
  }

  // Compare-and-swap. impact reads the report, spends real time scanning
  // source, then writes it back - so a `check` that finished in between was
  // silently reverted, restoring an old failing report over a newer clean one
  // (and vice versa). Re-read and only write if this is still the same run.
  let current: LastRun | null = null;
  try {
    current = JSON.parse(readFileSync(runFile, "utf8")) as LastRun;
  } catch {
    current = null;
  }
  if (!current || current.runId !== run.runId) {
    log(
      `\nA newer \`hookdrift check\` finished while this scan was running, so the code ` +
        `references below were not saved to last-run.json - the run they describe is no ` +
        `longer current. Re-run \`hookdrift impact\`.`,
    );
  } else {
    writeFileAtomic(runFile, JSON.stringify(run, null, 2) + "\n");
  }

  let lastEvent = "";
  for (const f of targets) {
    const key = plain(`${f.provider}/${f.event}`);
    if (key !== lastEvent) {
      log(`\n${key}`);
      lastEvent = key;
    }
    log("  " + formatFinding(f, false).split("\n").join("\n  "));
    if (!f.refs?.length) log("          (no references found in configured source globs)");
    const dropped = droppedRefs.get(f);
    if (dropped) log(`            ... ${dropped} lower-ranked match(es) not shown`);
  }
  log(
    `\nSearched ${files.length} file(s). Note: this is textual matching, not AST analysis - ` +
      `it will miss dynamic access (payload[key]) and may flag unrelated uses of common field names.` +
      (strictEff ? " [strict]" : ""),
  );

  // Exit semantics identical to check, over every unsuppressed finding in the
  // run - not only the mappable ones.
  return exitFor(strictEff);
}
