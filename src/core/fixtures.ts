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
      skipped.push({ file, reason: `invalid JSON (${(e as Error).message})` });
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

function extractEvent(payload: unknown, path: string): unknown {
  let cur: unknown = payload;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}
