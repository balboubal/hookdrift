/**
 * Conservative format detection. A format is only ever claimed for a path when
 * EVERY observed value matched it — callers intersect the candidate sets that
 * these functions return.
 */

const ISO8601 =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const NUMERIC_STRING = /^-?\d+(\.\d+)?$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** Provider object IDs like ch_3Abc…, txn_1Xyz… — the shape Stripe et al. use. */
export const ID_LIKE = /^[a-z]{2,6}_[A-Za-z0-9]{8,}$/;

/** Priority order used when more than one candidate survives intersection. */
export const STRING_FORMAT_PRIORITY = [
  "iso8601",
  "uuid",
  "email",
  "url",
  "prefixed_id",
  "numeric_string",
  "base64",
] as const;

export function stringFormatCandidates(value: string): Set<string> {
  const out = new Set<string>();
  if (ISO8601.test(value) && !Number.isNaN(Date.parse(value))) out.add("iso8601");
  if (UUID.test(value)) out.add("uuid");
  if (EMAIL.test(value)) out.add("email");
  if (/^https?:\/\//.test(value)) {
    try {
      new URL(value);
      out.add("url");
    } catch {
      /* not a url */
    }
  }
  if (ID_LIKE.test(value)) out.add("prefixed_id");
  if (NUMERIC_STRING.test(value)) out.add("numeric_string");
  // Base64 charset matches far too many ordinary strings; require padding or
  // the +/ characters plus realistic length before claiming.
  if (
    value.length >= 16 &&
    value.length % 4 === 0 &&
    BASE64.test(value) &&
    /[+/=]/.test(value)
  ) {
    out.add("base64");
  }
  return out;
}

// Unix seconds: ~2001-09 (1e9) through ~2033-05 (2e9), the plausible window for
// live webhook timestamps. Millis is the same window scaled by 1000.
export function numberFormatCandidates(value: number): Set<string> {
  const out = new Set<string>();
  if (Number.isInteger(value)) {
    if (value >= 1_000_000_000 && value < 2_000_000_000) out.add("unix_seconds");
    if (value >= 1_000_000_000_000 && value < 2_000_000_000_000) out.add("unix_millis");
  }
  return out;
}

/** Pick the highest-priority surviving candidate, or undefined if none. */
export function pickFormat(candidates: Set<string> | null): string | undefined {
  if (!candidates || candidates.size === 0) return undefined;
  for (const f of STRING_FORMAT_PRIORITY) if (candidates.has(f)) return f;
  for (const f of ["unix_seconds", "unix_millis"]) if (candidates.has(f)) return f;
  return undefined;
}
