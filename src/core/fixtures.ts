import { basename, dirname, resolve, sep } from "node:path";
import { globSync } from "tinyglobby";
import { readTextFileSync } from "./read.js";

export interface EventBatch {
  /** event name → parsed payloads */
  events: Map<string, unknown[]>;
  /** files that could not be parsed or had no event field */
  skipped: { file: string; reason: string }[];
  fileCount: number;
}

/**
 * Load a provider's fixtures and group them by event.
 *
 * `eventPath` is a dotted path into each payload (e.g. Stripe's "type").
 * The special value "@dirname" uses the fixture file's parent directory name
 * instead — for providers like GitHub whose payloads carry the event name in a
 * header, not the body, so fixtures are conventionally saved per-event-folder.
 */
export function loadFixtures(
  cwd: string,
  pattern: string,
  eventPath: string,
  onlyUnder?: string,
): EventBatch {
  let files = globSync(pattern, { cwd, absolute: true });
  if (onlyUnder) {
    const root = resolve(cwd, onlyUnder) + sep;
    files = files.filter((f) => resolve(f).startsWith(root));
  }
  files.sort();

  const events = new Map<string, unknown[]>();
  const skipped: { file: string; reason: string }[] = [];
  for (const file of files) {
    let payload: unknown;
    try {
      // BOM/encoding-tolerant read: PowerShell redirection produces UTF-16LE
      // files and editors add UTF-8 BOMs - see readTextFileSync.
      payload = JSON.parse(readTextFileSync(file));
    } catch (e) {
      skipped.push({ file, reason: parseFailure(e as Error) });
      continue;
    }
    const event =
      eventPath === "@dirname"
        ? basename(dirname(file))
        : extractEvent(payload, eventPath);
    if (typeof event !== "string" || event.length === 0) {
      skipped.push({ file, reason: `no event name at "${eventPath}"` });
      continue;
    }
    const list = events.get(event);
    if (list) list.push(payload);
    else events.set(event, [payload]);
  }
  return { events, skipped, fileCount: files.length };
}

/**
 * Describe a JSON parse failure without quoting the payload.
 *
 * Node's JSON.parse messages embed a slice of the source: a fixture containing
 * `{"token":sk_live_SECRET123}` produced `Unexpected token 's',
 * "{"token":sk_live_SE"... is not valid JSON`, and that string is stored in
 * coverage.skipped, printed to the console and posted to CI logs. Keep the
 * position, which is what actually helps fix the file; drop the excerpt.
 */
export function parseFailure(e: Error): string {
  const lineCol = /line (\d+) column (\d+)/.exec(e.message);
  if (lineCol) return `invalid JSON at line ${lineCol[1]} column ${lineCol[2]}`;
  const pos = /position (\d+)/.exec(e.message);
  if (pos) return `invalid JSON at position ${pos[1]}`;
  // Node reports no position for these two, and the "unexpected token" text is
  // exactly the variant that quotes the file, so it is replaced rather than
  // trimmed. Both categories are still enough to act on.
  if (/Unexpected end of JSON input/.test(e.message)) {
    return "invalid JSON: unexpected end of input (truncated file?)";
  }
  if (/Unexpected token/.test(e.message)) {
    return "invalid JSON: unexpected token (excerpt withheld - the parser quotes file contents)";
  }
  return "invalid JSON";
}

function extractEvent(payload: unknown, path: string): unknown {
  let cur: unknown = payload;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}
