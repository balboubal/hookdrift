import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { globSync } from "tinyglobby";
import type { Finding } from "../types.js";
import { loadConfig } from "../core/config.js";
import { formatFinding, type LastRun } from "./check.js";

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

export function runImpact(cwd: string, log: (l: string) => void = console.log): number {
  const config = loadConfig(cwd);
  const runFile = join(cwd, config.contractsDir, "last-run.json");
  if (!existsSync(runFile)) {
    log("No previous check found. Run `hookdrift check` first.");
    return 1;
  }
  if (config.source.length === 0) {
    log(`No "source" globs configured in hookdrift.config.json - nothing to search.`);
    return 1;
  }
  const run = JSON.parse(readFileSync(runFile, "utf8")) as LastRun;
  const targets = run.findings.filter((f) => f.path && !f.suppressed);
  if (targets.length === 0) {
    log("Last check produced no unsuppressed findings - nothing to map.");
    return 0;
  }

  const files = [...new Set(config.source.flatMap((g) => globSync(g, { cwd, absolute: true })))].sort();
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

  writeFileSync(runFile, JSON.stringify(run, null, 2) + "\n", "utf8");

  let lastEvent = "";
  for (const f of targets) {
    const key = `${f.provider}/${f.event}`;
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
      `it will miss dynamic access (payload[key]) and may flag unrelated uses of common field names.`,
  );
  return 0;
}
