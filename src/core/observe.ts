import type { JsonType, Observation, PathStats } from "../types.js";
import { ID_LIKE, numberFormatCandidates, stringFormatCandidates } from "./formats.js";

/** Above this many distinct values a path can no longer be an enum. */
export const ENUM_MAX_DISTINCT = 12;
/** Below this many observed values we never claim an enum. */
export const ENUM_MIN_SAMPLES = 30;

interface Occurrence {
  type: JsonType | "null";
  value: unknown;
}

/**
 * Flatten one payload into dotted paths. Arrays contribute an "array"-typed
 * occurrence at their own path plus per-element occurrences at `path[]`.
 * Intermediate objects get their own "object"-typed occurrence, so every level
 * of the structure is contract-visible.
 */
export function flattenSample(payload: unknown): Map<string, Occurrence[]> {
  const out = new Map<string, Occurrence[]>();
  const push = (path: string, occ: Occurrence) => {
    const list = out.get(path);
    if (list) list.push(occ);
    else out.set(path, [occ]);
  };
  const visit = (value: unknown, path: string): void => {
    if (value === null) {
      push(path, { type: "null", value: null });
    } else if (Array.isArray(value)) {
      push(path, { type: "array", value });
      for (const el of value) visit(el, `${path}[]`);
    } else if (typeof value === "object") {
      if (path !== "") push(path, { type: "object", value });
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        visit(v, path === "" ? k : `${path}.${k}`);
      }
    } else {
      const t = typeof value;
      if (t === "string" || t === "number" || t === "boolean") {
        push(path, { type: t, value });
      }
      // undefined / function / symbol cannot appear in parsed JSON; ignored.
    }
  };
  visit(payload, "");
  return out;
}

function newStats(): PathStats {
  return {
    types: new Set(),
    nullable: false,
    nullCount: 0,
    containCount: 0,
    valueCount: 0,
    stringCount: 0,
    distinct: new Set(),
    formatCandidates: null,
    allIdLike: true,
    intOnly: true,
    sawNumber: false,
  };
}

/** Fold a batch of parsed payloads into a structural observation. */
export function observe(samples: unknown[]): Observation {
  const paths = new Map<string, PathStats>();
  for (const sample of samples) {
    for (const [path, occs] of flattenSample(sample)) {
      let stats = paths.get(path);
      if (!stats) {
        stats = newStats();
        paths.set(path, stats);
      }
      stats.containCount += 1;
      for (const occ of occs) {
        if (occ.type === "null") {
          stats.nullable = true;
          stats.nullCount += 1;
          continue;
        }
        stats.types.add(occ.type);
        stats.valueCount += 1;
        let candidates: Set<string> | null = null;
        if (occ.type === "string") {
          const v = occ.value as string;
          stats.stringCount += 1;
          if (!ID_LIKE.test(v)) stats.allIdLike = false;
          if (stats.distinct) {
            stats.distinct.add(v);
            if (stats.distinct.size > ENUM_MAX_DISTINCT) stats.distinct = null;
          }
          candidates = stringFormatCandidates(v);
        } else if (occ.type === "number") {
          const v = occ.value as number;
          stats.sawNumber = true;
          if (!Number.isInteger(v)) stats.intOnly = false;
          candidates = numberFormatCandidates(v);
        } else {
          candidates = new Set();
        }
        if (stats.formatCandidates === null) {
          stats.formatCandidates = candidates;
        } else {
          for (const f of stats.formatCandidates) {
            if (!candidates.has(f)) stats.formatCandidates.delete(f);
          }
        }
      }
    }
  }
  return { totalSamples: samples.length, paths };
}
