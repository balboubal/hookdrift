import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Contract, FieldSchema, JsonType, Observation, PathStats } from "../types.js";
import { pickFormat } from "./formats.js";
import { ENUM_MAX_DISTINCT, ENUM_MIN_SAMPLES } from "./observe.js";

const TYPE_ORDER: JsonType[] = ["string", "number", "boolean", "object", "array"];

/**
 * Contract fields are keyed by payload paths, and payloads can legally contain
 * keys like "__proto__", "constructor" or "toString". On a plain object those
 * collide with Object.prototype: assigning fields["__proto__"] hits the
 * prototype setter and silently drops the field, and `"toString" in fields` is
 * always true. Null-prototype objects make every key an ordinary key.
 */
function nullProtoRecord<T>(src?: Record<string, T>): Record<string, T> {
  const out = Object.create(null) as Record<string, T>;
  if (src) for (const k of Object.keys(src)) out[k] = src[k]!;
  return out;
}

function sortTypes(types: Iterable<JsonType>): JsonType[] {
  return [...types].sort((a, b) => TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b));
}

/** Both shapes observed and every string is an ID → an expandable field. */
function looksPolymorphic(stats: PathStats): boolean {
  return (
    stats.types.has("string") &&
    stats.types.has("object") &&
    stats.stringCount > 0 &&
    stats.allIdLike
  );
}

function fieldFromStats(stats: PathStats, totalSamples: number): FieldSchema {
  const field: FieldSchema = {
    types: sortTypes(stats.types),
    presence: round(stats.containCount / totalSamples),
  };
  if (stats.nullable) field.nullable = true;
  if (looksPolymorphic(stats)) field.polymorphic = true;
  const format = pickFormat(stats.formatCandidates);
  if (format) field.format = format;
  if (stats.sawNumber) field.intOnly = stats.intOnly;
  if (
    stats.distinct &&
    stats.distinct.size > 0 &&
    stats.distinct.size <= ENUM_MAX_DISTINCT &&
    stats.stringCount >= ENUM_MIN_SAMPLES &&
    stats.types.size === 1 &&
    stats.types.has("string")
  ) {
    field.enum = [...stats.distinct].sort();
    field.enumConfidence = enumConfidence(stats.distinct.size, stats.stringCount);
  }
  return field;
}

function enumConfidence(distinct: number, observed: number): number {
  return round(Math.min(0.99, 1 - distinct / observed));
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function buildContract(
  provider: string,
  event: string,
  obs: Observation,
  now: string,
): Contract {
  const fields = nullProtoRecord<FieldSchema>();
  for (const path of [...obs.paths.keys()].sort()) {
    fields[path] = fieldFromStats(obs.paths.get(path)!, obs.totalSamples);
  }
  return {
    version: 1,
    provider,
    event,
    samplesObserved: obs.totalSamples,
    firstSeen: now,
    lastUpdated: now,
    fields,
  };
}

/**
 * Merge new observations into an existing contract. Merging only ever WIDENS:
 * types and enum value sets grow, formats and enum claims can be dropped when
 * contradicted, presence is recomputed over the combined sample total.
 * Narrowing (removing types, shrinking enums, adding claims to existing paths)
 * never happens here — that requires an explicit --rebuild.
 */
export function mergeContract(old: Contract, obs: Observation, now: string): Contract {
  const total = old.samplesObserved + obs.totalSamples;
  const fields = nullProtoRecord<FieldSchema>();
  const allPaths = new Set([...Object.keys(old.fields), ...obs.paths.keys()]);

  for (const path of [...allPaths].sort()) {
    const prev = old.fields[path];
    const stats = obs.paths.get(path);

    if (prev && !stats) {
      // Path unseen in the new batch: keep every claim, dilute presence.
      const oldContain = Math.round(prev.presence * old.samplesObserved);
      fields[path] = { ...prev, presence: round(oldContain / total) };
      continue;
    }
    if (!prev && stats) {
      // Brand-new path: infer fresh, but presence is over the combined total —
      // the old samples did not contain it.
      const field = fieldFromStats(stats, obs.totalSamples);
      field.presence = round(stats.containCount / total);
      fields[path] = field;
      continue;
    }

    const p = prev!;
    const s = stats!;
    const oldContain = Math.round(p.presence * old.samplesObserved);
    const merged: FieldSchema = {
      types: sortTypes(new Set<JsonType>([...p.types, ...s.types])),
      presence: round((oldContain + s.containCount) / total),
    };
    if (p.nullable || s.nullable) merged.nullable = true;

    // Format: keep the old claim only if every new value still matches it.
    if (p.format && s.formatCandidates?.has(p.format)) merged.format = p.format;

    // Polymorphic is sticky once set; it can also be newly detected when the
    // union shows both shapes and the ID-string evidence is there (from the
    // new batch, or from the old contract's own format claim).
    if (
      p.polymorphic ||
      (merged.types.includes("string") &&
        merged.types.includes("object") &&
        ((s.stringCount > 0 && s.allIdLike) || p.format === "prefixed_id"))
    ) {
      merged.polymorphic = true;
    }

    // intOnly: floats anywhere mean floats forever (widening).
    if (p.intOnly !== undefined || s.sawNumber) {
      merged.intOnly = (p.intOnly ?? true) && (!s.sawNumber || s.intOnly);
    }

    // Enum: only paths that already claimed one can keep it (adding a claim to
    // an existing path would narrow). Union the value sets; drop the claim if
    // the union outgrows the cap or new values were too diverse to track.
    if (p.enum) {
      if (s.distinct !== null && merged.types.length === 1 && merged.types[0] === "string") {
        const union = new Set([...p.enum, ...s.distinct]);
        if (union.size <= ENUM_MAX_DISTINCT) {
          // Old per-value observation count is approximated from presence —
          // the contract file stores structure, not raw tallies.
          const observed = oldContain + s.stringCount;
          if (observed >= ENUM_MIN_SAMPLES) {
            merged.enum = [...union].sort();
            merged.enumConfidence = enumConfidence(union.size, observed);
          }
        }
      }
    }

    fields[path] = merged;
  }

  return {
    version: 1,
    provider: old.provider,
    event: old.event,
    samplesObserved: total,
    firstSeen: old.firstSeen,
    lastUpdated: now,
    fields,
  };
}

export function contractPath(contractsDir: string, provider: string, event: string): string {
  // Event names like "charge.succeeded" are safe as filenames; guard the rest.
  const safe = event.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(contractsDir, provider, `${safe}.contract.json`);
}

// Contracts are committed files the README invites users to hand-edit
// (polymorphic: true), and they survive merge conflicts. Unvalidated, a broken
// edit either silently changed severities (a truthy string for polymorphic) or
// poisoned the contract on the next merge (missing samplesObserved arithmetic
// produced presence: null on every field, written back with exit 0). Loose
// objects: unknown keys pass through for forward compatibility; known keys
// must have sane types and ranges.
const FieldZ = z.looseObject({
  types: z.array(z.enum(["string", "number", "boolean", "object", "array"])),
  presence: z.number().min(0).max(1),
  nullable: z.boolean().optional(),
  format: z.string().optional(),
  intOnly: z.boolean().optional(),
  enum: z.array(z.string()).optional(),
  enumConfidence: z.number().min(0).max(1).optional(),
  polymorphic: z.boolean().optional(),
});
const ContractZ = z.looseObject({
  version: z.literal(1),
  provider: z.string().min(1),
  event: z.string().min(1),
  samplesObserved: z.number().int().min(1),
  firstSeen: z.string(),
  lastUpdated: z.string(),
  fields: z.record(z.string(), FieldZ),
});

export function loadContract(file: string): Contract | null {
  if (!existsSync(file)) return null;
  // Strip a UTF-8 BOM - a committed contract may have been touched by an editor
  // that adds one.
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${(e as Error).message}`);
  }
  const v = ContractZ.safeParse(parsed);
  if (!v.success) {
    const lines = v.error.issues.map(
      (i) => `  ${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`,
    );
    throw new Error(
      `${file} is not a valid contract:\n${lines.join("\n")}\n` +
        `Fix the edit, or regenerate with \`hookdrift infer --rebuild\`.`,
    );
  }
  const contract = parsed as Contract;
  // JSON.parse creates own properties (even for "__proto__"), but downstream
  // code does `path in fields` and `fields[path] =` - re-key onto a
  // null-prototype record so prototype members can never shadow real paths.
  contract.fields = nullProtoRecord(contract.fields);
  return contract;
}

export function saveContract(file: string, contract: Contract): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(contract, null, 2) + "\n", "utf8");
}
