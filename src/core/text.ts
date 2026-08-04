/**
 * Strip control and bidi characters from a payload-derived string that is about
 * to be printed to a human channel.
 *
 * Event names, paths and enum values come from the provider, and terminals and
 * CI log viewers act on these bytes rather than showing them: ESC sequences
 * recolour, clear or rewrite the screen, and the bidi overrides let a path be
 * displayed in an order other than the one that ran. An event named
 * "e\x1b[31mRED" reached stdout byte-for-byte.
 *
 * JSON output is deliberately left raw: the serializer escapes it, and a
 * machine consumer needs the real value to apply its own policy.
 */
export function plain(s: string): string {
  // C0 (including newline and tab), DEL, C1, zero-width and bidi controls.
  return s.replace(
    /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g,
    "",
  );
}
