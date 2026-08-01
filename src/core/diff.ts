import type { Contract, FieldSchema, Finding, Observation, PathStats } from "../types.js";
import { pickFormat } from "./formats.js";

/** enum-removal is only BREAKING when the contract was this confident. */
export const ENUM_BREAK_CONFIDENCE = 0.95;
/** ...and at least this many values were observed in the new batch. */
export const ENUM_BREAK_MIN_VALUES = 50;
/** Presence jitter below this is not worth an INFO finding. */
const PRESENCE_SHIFT_MIN = 0.1;

export interface DiffOptions {
  /** Below this many new samples, presence-based findings downgrade to INFO. */
  minSamples?: number;
}

const SEVERITY_ORDER = { BREAKING: 0, WARNING: 1, INFO: 2 } as const;

function leafOf(path: string): string {
  return path.split(".").pop()!;
}

function isDescendant(child: string, parent: string): boolean {
  return child.startsWith(parent + ".") || child.startsWith(parent + "[]");
}

function hasAncestorIn(path: string, roots: Set<string>): boolean {
  for (const r of roots) if (isDescendant(path, r)) return true;
  return false;
}

function sameTypeSignature(a: FieldSchema, b: PathStats): boolean {
  if (a.types.length !== b.types.size) return false;
  return a.types.every((t) => b.types.has(t));
}

/**
 * Expandable-field (Stripe-style) evidence for a string/object type change.
 *
 * "coexist": the NEW batch itself contains both shapes and every string is an
 * ID - coexistence proves both shapes are currently legitimate, so this is
 * informational.
 *
 * "flip": the new batch contains only the shape the contract lacks (e.g. a
 * contract of ID strings checked against all-object samples). The ID evidence
 * (new strings all ID-like, or the contract's own prefixed_id format claim)
 * says this is PROBABLY expansion being toggled - but code reading the old
 * shape breaks either way, so this must never sink below WARNING.
 *
 * null: no ID evidence - treat as an ordinary breaking type change.
 */
function expandableVerdict(
  field: FieldSchema,
  stats: PathStats,
): "coexist" | "flip" | null {
  const union = new Set([...field.types, ...stats.types]);
  if (union.size !== 2 || !union.has("string") || !union.has("object")) return null;
  if (stats.types.has("string") && stats.types.has("object")) {
    return stats.allIdLike ? "coexist" : null;
  }
  const evidence = stats.stringCount > 0 ? stats.allIdLike : field.format === "prefixed_id";
  return evidence ? "flip" : null;
}

/**
 * Diff a committed contract against a fresh observation of new samples.
 * Returns findings sorted by severity, then path. The observation is compared
 * as-is (never merged) - `check` must not mutate the contract.
 */
export function diffContract(
  contract: Contract,
  obs: Observation,
  options: DiffOptions = {},
): Finding[] {
  const { provider, event } = contract;
  const minSamples = options.minSamples ?? 10;
  const findings: Finding[] = [];
  const N = obs.totalSamples;
  const C = contract.samplesObserved;
  const fewSamples = N < minSamples;
  const add = (f: Omit<Finding, "provider" | "event">) =>
    findings.push({ provider, event, ...f });

  const removed = Object.keys(contract.fields).filter((p) => !obs.paths.has(p));
  const addedAll = [...obs.paths.keys()].filter((p) => !(p in contract.fields));

  // ---- Move detection: same leaf name reappearing under a different parent,
  // with an identical type signature, is a move - not a delete plus an add.
  const movedTo = new Map<string, string>();
  const consumedAdds = new Set<string>();
  for (const gone of removed) {
    const leaf = leafOf(gone);
    const candidates = addedAll.filter(
      (a) =>
        !consumedAdds.has(a) &&
        leafOf(a) === leaf &&
        sameTypeSignature(contract.fields[gone]!, obs.paths.get(a)!),
    );
    if (candidates.length === 1) {
      movedTo.set(gone, candidates[0]!);
      consumedAdds.add(candidates[0]!);
    }
  }

  // ---- Structural roots whose descendants should be suppressed (one finding
  // for the subtree, not one per leaf). Note that paths lost because a parent
  // object collapsed to a scalar are NOT suppressed here - that is real data
  // loss and each vanished path breaks the code that reads it.
  const removedRoots = new Set(removed.filter((p) => !hasAncestorIn(p, new Set(removed))));
  const typeChangeRoots = new Set<string>();

  for (const path of removed) {
    if (hasAncestorIn(path, removedRoots) && !removedRoots.has(path)) continue;
    const field = contract.fields[path]!;
    const contain = Math.round(field.presence * C);
    const to = movedTo.get(path);
    if (to) {
      add({
        path,
        severity: "BREAKING",
        kind: "path_moved",
        movedTo: to,
        message: `moved to ${to} (was at ${path} in ${contain}/${C} contract samples; new location seen in ${obs.paths.get(to)!.containCount}/${N} new samples)`,
      });
    } else {
      add({
        path,
        severity: "BREAKING",
        kind: "path_removed",
        message: `removed (was present in ${contain}/${C} contract samples; absent from all ${N} new samples)`,
      });
    }
  }

  // ---- Paths present in both: type, nullability, enum, presence, format.
  for (const [path, field] of Object.entries(contract.fields)) {
    const stats = obs.paths.get(path);
    if (!stats) continue;
    let pathBroke = false;

    // Type compatibility: any new type absent from the contract set is breaking
    // - unless the field is polymorphic (annotated or heuristically detected).
    const extra = [...stats.types].filter((t) => !field.types.includes(t));
    const typeSpan = `contract [${field.types.join(", ")}] -> observed [${[...stats.types].join(", ")}] in ${stats.containCount}/${N} new samples`;
    if (extra.length > 0) {
      const verdict = expandableVerdict(field, stats);
      if (field.polymorphic) {
        add({
          path,
          severity: "INFO",
          kind: "type_changed",
          message: `type union widened on polymorphic field: ${typeSpan}`,
        });
        typeChangeRoots.add(path);
      } else if (verdict === "coexist") {
        add({
          path,
          severity: "INFO",
          kind: "type_changed",
          message: `type changed (${typeSpan}) but both shapes coexist in the new batch and string values are provider IDs - this is an expandable field. Re-run \`hookdrift infer\` to record it as polymorphic, or set "polymorphic": true in the contract`,
        });
        typeChangeRoots.add(path);
      } else if (verdict === "flip") {
        const oldShape = field.types.includes("string") ? "ID string" : "object";
        const newShape = oldShape === "ID string" ? "object" : "ID string";
        add({
          path,
          severity: "WARNING",
          kind: "type_changed",
          message: `shape changed completely: every value in the new batch is an ${newShape} where the contract recorded ${oldShape}s (${typeSpan}). Either expansion was toggled on the provider request, or the provider genuinely replaced the field - code reading the ${oldShape} form will break. Verify which before re-running \`hookdrift infer\``,
        });
        typeChangeRoots.add(path);
      } else {
        const flip = field.types.includes("array") !== stats.types.has("array");
        add({
          path,
          severity: "BREAKING",
          kind: flip ? "array_scalar_flip" : "type_changed",
          message: `type changed: ${typeSpan}`,
        });
        typeChangeRoots.add(path);
        pathBroke = true;
      }
    } else if (field.polymorphic && stats.types.size < field.types.length) {
      // Narrowing on a polymorphic field: a previously-seen shape vanished.
      add({
        path,
        severity: "WARNING",
        kind: "type_changed",
        message: `type union narrowed on polymorphic field: ${typeSpan}`,
      });
    }

    // Nullability: a non-nullable path going null even once is breaking.
    if (!field.nullable && stats.nullable) {
      add({
        path,
        severity: "BREAKING",
        kind: "became_nullable",
        message: `null observed (${stats.nullCount} null value(s) in ${N} new samples; never null in ${C} contract samples)`,
      });
      pathBroke = true;
    }

    // Enum drift. Removal is only BREAKING with high confidence AND enough
    // new observations to make "no longer appears" meaningful evidence.
    if (field.enum) {
      const conf = field.enumConfidence ?? 0;
      if (stats.distinct === null) {
        add({
          path,
          severity: "WARNING",
          kind: "enum_value_added",
          message: `no longer looks like an enum: contract had ${field.enum.length} values [${field.enum.join(", ")}], new samples contain more than 12 distinct values`,
        });
      } else {
        const fresh = stats.distinct;
        const gone = field.enum.filter((v) => !fresh.has(v));
        const novel = [...fresh].filter((v) => !field.enum!.includes(v)).sort();
        if (gone.length > 0) {
          const strongEvidence =
            conf >= ENUM_BREAK_CONFIDENCE && stats.stringCount >= ENUM_BREAK_MIN_VALUES;
          add({
            path,
            severity: strongEvidence ? "BREAKING" : "WARNING",
            kind: "enum_value_removed",
            message:
              `enum value(s) no longer observed: [${gone.join(", ")}] (enumConfidence ${conf}; ${stats.stringCount} values in ${N} new samples)` +
              (strongEvidence
                ? ""
                : ` - warning only: needs enumConfidence >= ${ENUM_BREAK_CONFIDENCE} and >= ${ENUM_BREAK_MIN_VALUES} observed values to be breaking`),
          });
        }
        if (novel.length > 0) {
          add({
            path,
            severity: "WARNING",
            kind: "enum_value_added",
            message: `new enum value(s): [${novel.join(", ")}] - exhaustive switch/match statements over this field will miss them (${stats.stringCount} values in ${N} new samples)`,
          });
        }
      }
    }

    if (pathBroke) continue; // breaking findings supersede warnings/info on the same path

    // Required became optional. With too few new samples, one missing payload
    // is not evidence - downgrade to INFO and say so.
    const freshPresence = stats.containCount / N;
    if (field.presence === 1 && freshPresence < 1) {
      add({
        path,
        severity: fewSamples ? "INFO" : "WARNING",
        kind: "required_became_optional",
        message:
          `required -> optional: present in ${C}/${C} contract samples but only ${stats.containCount}/${N} new samples` +
          (fewSamples ? ` (only ${N} new sample(s), below minSamples=${minSamples} - informational)` : ""),
      });
    } else if (
      field.presence < 1 &&
      freshPresence < 1 &&
      Math.abs(freshPresence - field.presence) >= PRESENCE_SHIFT_MIN
    ) {
      add({
        path,
        severity: "INFO",
        kind: "presence_shift",
        message:
          `presence moved ${field.presence} -> ${Math.round(freshPresence * 10000) / 10000} (${stats.containCount}/${N} new samples), still optional` +
          (fewSamples ? ` (only ${N} new sample(s), below minSamples=${minSamples})` : ""),
      });
    }

    // Format drift (only meaningful when values were observed). Skipped when
    // the type union itself changed or the field is polymorphic - a format
    // "change" there is just the shape change again, already reported.
    if (field.format && stats.valueCount > 0 && extra.length === 0 && !field.polymorphic) {
      const freshFormat = pickFormat(stats.formatCandidates) ?? "none";
      if (freshFormat !== field.format) {
        add({
          path,
          severity: "WARNING",
          kind: "format_changed",
          message: `format changed: ${field.format} -> ${freshFormat} (${stats.valueCount} values in ${N} new samples)`,
        });
      }
    }

    // Numeric precision: integers only -> floats appearing.
    if (field.intOnly === true && stats.sawNumber && !stats.intOnly) {
      add({
        path,
        severity: "WARNING",
        kind: "precision_shift",
        message: `numeric precision shift: contract observed integers only across ${C} samples, floats appear in new samples`,
      });
    }
  }

  // ---- New optional fields (one finding per subtree root, moves excluded).
  const genuinelyAdded = addedAll.filter((p) => !consumedAdds.has(p));
  const addedSet = new Set(genuinelyAdded);
  for (const path of genuinelyAdded) {
    if (hasAncestorIn(path, addedSet)) continue;
    if (hasAncestorIn(path, typeChangeRoots)) continue; // subtree already reported as a type change
    const stats = obs.paths.get(path)!;
    add({
      path,
      severity: "INFO",
      kind: "new_field",
      message: `new field appeared in ${stats.containCount}/${N} new samples (not in contract of ${C} samples)`,
    });
  }

  findings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.path.localeCompare(b.path),
  );
  return findings;
}
