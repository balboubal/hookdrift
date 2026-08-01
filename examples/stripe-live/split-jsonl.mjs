// Split captured Stripe events into one JSON file per event, which is the
// layout hookdrift's fixtures glob expects. Accepts either format:
//
//   stripe listen --format json > events.jsonl     (one event per line)
//   stripe events list --limit 100 > events.json   (a {"data": [...]} list)
//
//   node split-jsonl.mjs events.jsonl fixtures/stripe
//
// Structure only: this copies payloads verbatim to disk for local inference.
// Nothing is sent anywhere.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [, , input = "events.jsonl", outDir = "fixtures/stripe"] = process.argv;

// Strip a UTF-8 BOM: PowerShell redirects on Windows routinely add one, and
// JSON.parse rejects it.
const raw = readFileSync(input, "utf8").replace(/^\uFEFF/, "");
mkdirSync(outDir, { recursive: true });

const counts = new Map();
let skipped = 0;

/** A whole-file JSON list response, or line-delimited events. */
function readEvents(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.data)) return parsed.data;
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object") return [parsed];
  } catch {
    /* not a single JSON document - fall through to JSONL */
  }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // The CLI interleaves human-readable banners ("Ready! You are using...")
    // with the JSON payloads; ignore anything that is not a JSON object.
    if (!trimmed.startsWith("{")) {
      skipped++;
      continue;
    }
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      skipped++;
    }
  }
  return out;
}

for (const evt of readEvents(raw)) {
  const type = typeof evt.type === "string" ? evt.type : "unknown";
  const n = (counts.get(type) ?? 0) + 1;
  counts.set(type, n);
  const safe = type.replace(/[^a-zA-Z0-9._-]/g, "_");
  writeFileSync(
    join(outDir, `${safe}-${String(n).padStart(3, "0")}.json`),
    JSON.stringify(evt, null, 2) + "\n",
  );
}

const total = [...counts.values()].reduce((a, b) => a + b, 0);
console.log(`Wrote ${total} fixture(s) to ${outDir}`);
for (const [type, n] of [...counts.entries()].sort()) console.log(`  ${type}: ${n}`);
if (skipped) console.log(`Ignored ${skipped} non-JSON line(s).`);
