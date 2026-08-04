import { mkdirSync, writeFileSync, existsSync, renameSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import { readTextFileSync } from "./read.js";
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
    containCount: stats.containCount,
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
      const oldContain = prev.containCount ?? Math.round(prev.presence * old.samplesObserved);
      fields[path] = { ...prev, presence: round(oldContain / total), containCount: oldContain };
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
    // Prefer the exact stored count; reconstructing it from rounded presence
    // accumulates error across every merge.
    const oldContain = p.containCount ?? Math.round(p.presence * old.samplesObserved);
    const mergedContain = oldContain + s.containCount;
    const merged: FieldSchema = {
      types: sortTypes(new Set<JsonType>([...p.types, ...s.types])),
      presence: round(mergedContain / total),
      containCount: mergedContain,
    };
    if (p.nullable || s.nullable) merged.nullable = true;
    if (p.enumAuthoritative) merged.enumAuthoritative = true;

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

/**
 * Windows reserves these device names, with or without an extension, so
 * `CON.contract.json` is not a writable file there.
 * https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file
 */
const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
/** Readable prefix kept ahead of the digest, and the cap on a plain name. */
const NAME_PREFIX_MAX = 64;
/**
 * Longest provider/event identity we will accept at all. Event names come from
 * the payload, so without a bound a webhook can name a file of arbitrary
 * length; a 300-character event aborted the entire run with a bare filesystem
 * errno.
 */
export const IDENTITY_MAX = 200;

/**
 * Storage identity for an event.
 *
 * A name keeps its plain readable form only when it is unambiguous on every
 * filesystem hookdrift supports: filename-safe ASCII, already lowercase
 * (Windows and macOS compare case-insensitively, so `Event` and `event` would
 * otherwise share one file), bounded in length, not a Windows device name and
 * not dot-only. Everything else gets a bounded prefix plus 64 bits of SHA-256.
 *
 * The previous 32-bit polynomial hash was collidable by hand rather than by
 * search - "/̀" and "?Đ" both sanitized to `__` and both hashed to
 * `1pt`, so two unrelated events silently merged into one plausible-looking
 * contract. Real provider events (Stripe, Shopify, GitHub) are lowercase and
 * short, so they keep the plain filename they have today.
 */
export function eventFileName(event: string): string {
  const plain =
    /^[a-z0-9._-]+$/.test(event) &&
    event.length <= NAME_PREFIX_MAX &&
    !WIN_RESERVED.test(event) &&
    !/^\.+$/.test(event) &&
    !event.endsWith(".");
  if (plain) return `${event}.contract.json`;
  const prefix = event.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, NAME_PREFIX_MAX) || "event";
  const digest = createHash("sha256").update(event, "utf8").digest("hex").slice(0, 16);
  return `${prefix}~${digest}.contract.json`;
}

/** realpath, or null when the path does not exist yet. */
function realOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

export function contractPath(contractsDir: string, provider: string, event: string): string {
  if (provider.length > IDENTITY_MAX || event.length > IDENTITY_MAX) {
    throw new Error(
      `provider/event identity longer than ${IDENTITY_MAX} characters is refused ` +
        `(provider ${provider.length}, event ${event.length}) - a payload must not be able to ` +
        `name a file of unbounded length`,
    );
  }
  const file = join(contractsDir, provider, eventFileName(event));
  // Defence in depth: config validation already restricts provider names, but
  // a contract path must never escape contractsDir regardless of how it got
  // here - an untrusted config edit could otherwise write anywhere writable.
  const root = resolve(contractsDir);
  const target = resolve(file);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(
      `refusing to use a contract path outside ${contractsDir}: provider "${provider}" resolves to ${target}`,
    );
  }
  // resolve() is lexical: it normalises `..` but does not follow symlinks, so a
  // symlinked provider directory passed the check above and then wrote outside
  // the tree entirely. Compare real path to real path where both already exist.
  const realRoot = realOrNull(root);
  const realParent = realOrNull(dirname(target));
  if (
    realRoot &&
    realParent &&
    realParent !== realRoot &&
    !realParent.startsWith(realRoot + sep)
  ) {
    throw new Error(
      `refusing to use a contract path outside ${contractsDir}: "${provider}" is a link to ${realParent}`,
    );
  }
  return file;
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
  containCount: z.number().int().min(0).optional(),
  enumAuthoritative: z.boolean().optional(),
  nullable: z.boolean().optional(),
  format: z.string().optional(),
  intOnly: z.boolean().optional(),
  enum: z.array(z.string()).optional(),
  enumConfidence: z.number().min(0).max(1).optional(),
  polymorphic: z.boolean().optional(),
});
const ContractZ = z
  .looseObject({
    version: z.literal(1),
    provider: z.string().min(1),
    event: z.string().min(1),
    samplesObserved: z.number().int().min(1),
    firstSeen: z.string(),
    lastUpdated: z.string(),
    fields: z.record(z.string(), FieldZ),
  })
  // Primitive types alone let a hand-edit or a merge conflict produce a
  // contract that is individually valid and jointly nonsense. The reproduced
  // case: presence 0 with containCount 100 of 100 samples was accepted, and
  // the complete disappearance of that required field came out as INFO with
  // exit 0 - a false green from a file that passed validation.
  .superRefine((c, ctx) => {
    const bad = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    for (const [name, f] of Object.entries(c.fields)) {
      const at = ["fields", name];
      if (f.types.length !== new Set(f.types).size) bad([...at, "types"], "duplicate type entries");
      if (f.containCount !== undefined) {
        if (f.containCount > c.samplesObserved) {
          bad(
            [...at, "containCount"],
            `containCount ${f.containCount} exceeds samplesObserved ${c.samplesObserved}`,
          );
        } else {
          // presence is the 4dp rounding of containCount/samplesObserved.
          const expected = Math.round((f.containCount / c.samplesObserved) * 10000) / 10000;
          if (Math.abs(expected - f.presence) > 0.0001) {
            bad(
              [...at, "presence"],
              `presence ${f.presence} contradicts containCount ${f.containCount}/${c.samplesObserved} (expected ${expected})`,
            );
          }
        }
      }
      if (f.enum) {
        if (f.enum.length === 0) bad([...at, "enum"], "enum must not be empty");
        if (f.enum.length !== new Set(f.enum).size) bad([...at, "enum"], "duplicate enum values");
        if (!f.types.includes("string")) {
          bad([...at, "enum"], `enum on a field typed [${f.types.join(", ")}] - enums are string-only`);
        }
      } else if (f.enumAuthoritative) {
        bad([...at, "enumAuthoritative"], "enumAuthoritative set on a field with no enum");
      }
      if (f.polymorphic && f.types.some((t) => t !== "string" && t !== "object")) {
        bad(
          [...at, "polymorphic"],
          `polymorphic marks the string/object expandable pair, but types are [${f.types.join(", ")}]`,
        );
      }
    }
    for (const k of ["firstSeen", "lastUpdated"] as const) {
      if (Number.isNaN(Date.parse(c[k]))) bad([k], `not a parseable timestamp: ${c[k]}`);
    }
  });

export function loadContract(
  file: string,
  expect?: { provider: string; event: string },
): Contract | null {
  if (!existsSync(file)) return null;
  // Encoding-tolerant read - a committed contract may have been re-saved by an
  // editor with a UTF-8 BOM or piped through PowerShell as UTF-16.
  let parsed: unknown;
  try {
    parsed = JSON.parse(readTextFileSync(file));
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
  // The file name is derived from the identity, so a file that holds a
  // different identity than the caller asked for means the mapping broke -
  // a hash collision, a case-insensitive filesystem, or a hand-rename. Merging
  // it would fold two events into one plausible-looking contract, so fail loudly
  // even though the digest makes this astronomically unlikely.
  if (expect && (contract.provider !== expect.provider || contract.event !== expect.event)) {
    throw new Error(
      `${file} holds the contract for "${contract.provider}/${contract.event}", ` +
        `but was opened as "${expect.provider}/${expect.event}". Refusing to merge two identities ` +
        `into one file. Rename or regenerate with \`hookdrift infer --rebuild\`.`,
    );
  }
  // JSON.parse creates own properties (even for "__proto__"), but downstream
  // code does `path in fields` and `fields[path] =` - re-key onto a
  // null-prototype record so prototype members can never shadow real paths.
  contract.fields = nullProtoRecord(contract.fields);
  return contract;
}

/**
 * Write via a temp file in the same directory, then rename. A direct write
 * that is interrupted (crash, full disk, concurrent run) leaves a truncated
 * file that the next run rejects as corrupt; rename is atomic on both POSIX
 * and Windows for same-directory moves.
 */
export function writeFileAtomic(file: string, data: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data, "utf8");
  renameSync(tmp, file);
}

export function saveContract(file: string, contract: Contract): void {
  writeFileAtomic(file, JSON.stringify(contract, null, 2) + "\n");
}

/**
 * Create the contracts directory, and seed it with a .gitignore for
 * last-run.json the first time.
 *
 * The README tells you to `git add .hookdrift` - contracts are meant to be
 * committed - but that directory also holds the transient report of whoever ran
 * `check` last, which then reappears as a dirty file after every subsequent
 * run. Shipping the rule beside the files it applies to means the documented
 * command does the right thing without the user having to know this.
 * An existing .gitignore is never overwritten.
 */
export function ensureContractsDir(contractsDir: string): void {
  mkdirSync(contractsDir, { recursive: true });
  const ignore = join(contractsDir, ".gitignore");
  if (existsSync(ignore)) return;
  writeFileSync(
    ignore,
    "# Contracts are meant to be committed. last-run.json is not: it is the\n" +
      "# transient report of whichever `hookdrift check` ran most recently.\n" +
      "last-run.json\n",
    "utf8",
  );
}
