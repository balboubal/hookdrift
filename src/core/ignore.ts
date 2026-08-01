import type { Finding, IgnoreRule } from "../types.js";

/**
 * Pattern grammar (deliberately small): exact dotted path, a trailing `*`
 * matching exactly one segment, or a trailing `**` matching one or more.
 * Segments compare literally, so `refunds[]` is a single segment.
 */
export function pathMatches(pattern: string, path: string): boolean {
  if (pattern === path) return true;
  const pSegs = pattern.split(".");
  const segs = path.split(".");
  const last = pSegs[pSegs.length - 1];
  if (last !== "*" && last !== "**") return false;
  const prefix = pSegs.slice(0, -1);
  if (!prefix.every((s, i) => s === segs[i])) return false;
  if (last === "*") return segs.length === prefix.length + 1;
  return segs.length >= prefix.length + 1;
}

/** First matching rule wins; kind-less rules match every kind at the path. */
export function matchIgnore(rules: IgnoreRule[], finding: Finding): IgnoreRule | undefined {
  if (!finding.path) return undefined; // e.g. uncontracted_event has no path
  return rules.find(
    (r) => pathMatches(r.path, finding.path) && (!r.kind || r.kind === finding.kind),
  );
}
