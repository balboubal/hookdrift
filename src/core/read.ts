import { readFileSync } from "node:fs";

/**
 * Read a text file tolerating the encodings Windows tooling actually produces.
 *
 * PowerShell 5.1's `>` redirection (Out-File default: Unicode) writes UTF-16LE
 * with a BOM - so the README's own `stripe listen --format json > current.jsonl`
 * instruction yields UTF-16 files for those users, which a plain utf8 read
 * turns into mojibake and a misleading "invalid JSON" error per file. Editors
 * add UTF-8 BOMs. Everything else is treated as UTF-8.
 */
export function readTextFileSync(file: string): string {
  const buf = readFileSync(file);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString("utf16le");
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16BE: swap byte pairs, then decode as LE. A truncated final byte
    // (malformed file) is dropped; the JSON parse error downstream names the file.
    let body = Buffer.from(buf.subarray(2));
    if (body.length % 2 === 1) body = body.subarray(0, body.length - 1);
    body.swap16();
    return body.toString("utf16le");
  }
  return buf.toString("utf8").replace(/^\uFEFF/, "");
}
