import { join } from "node:path";
import { loadConfig } from "../core/config.js";
import { loadFixtures } from "../core/fixtures.js";
import { observe } from "../core/observe.js";
import {
  buildContract,
  contractPath,
  loadContract,
  mergeContract,
  saveContract,
} from "../core/contract.js";

/**
 * Path segments that look like payload data rather than a schema field:
 * an email, a provider secret/token prefix, a UUID, or a long opaque blob.
 * Deliberately narrow - a false warning is cheap, a missed committed secret
 * is not.
 */
const SENSITIVE_SEGMENT =
  /@|^(sk|pk|rk|whsec|shpat|shpss|ghp|gho|xox[baprs])_|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^[A-Za-z0-9+/_-]{32,}$/i;

export interface InferOptions {
  cwd: string;
  fixturesDir?: string;
  rebuild?: boolean;
  log?: (line: string) => void;
  now?: () => string;
}

export function runInfer(opts: InferOptions): number {
  const { cwd, fixturesDir, rebuild = false } = opts;
  const log = opts.log ?? console.log;
  const now = opts.now ?? (() => new Date().toISOString());
  const config = loadConfig(cwd);
  const contractsDir = join(cwd, config.contractsDir);
  let wrote = 0;
  let failed = 0;

  for (const [provider, pc] of Object.entries(config.providers)) {
    const batch = loadFixtures(cwd, pc.fixtures, pc.eventPath, fixturesDir);
    for (const s of batch.skipped) log(`  skipped ${s.file}: ${s.reason}`);
    if (batch.events.size === 0) {
      log(`${provider}: no fixtures matched ${pc.fixtures}${fixturesDir ? ` under ${fixturesDir}` : ""}`);
      continue;
    }
    for (const [event, samples] of [...batch.events.entries()].sort()) {
      // A payload past the depth limit must not abort inference for every
      // other event, matching how check isolates one bad contract.
      let obs;
      try {
        obs = observe(samples);
      } catch (e) {
        log(`${provider}/${event}: SKIPPED - ${(e as Error).message}`);
        failed += 1;
        continue;
      }
      const file = contractPath(contractsDir, provider, event);
      // An unreadable existing contract must not abort inference for every
      // other event. Report it, skip this one, and keep going; --rebuild
      // regenerates it from scratch without reading the broken file.
      let existing;
      try {
        existing = rebuild ? null : loadContract(file);
      } catch (e) {
        log(`${provider}/${event}: SKIPPED - ${(e as Error).message.split("\n").join(" ")}`);
        failed += 1;
        continue;
      }
      const stamp = now();
      const contract = existing
        ? mergeContract(existing, obs, stamp)
        : buildContract(provider, event, obs, stamp);
      saveContract(file, contract);
      wrote += 1;
      const verb = existing ? "updated" : rebuild ? "rebuilt" : "created";
      log(
        `${provider}/${event}: ${verb} (${samples.length} new sample(s), ${contract.samplesObserved} total, ${Object.keys(contract.fields).length} paths)`,
      );
      // Surface heuristic decisions - the user should see every inference made.
      for (const [path, field] of Object.entries(contract.fields)) {
        if (field.polymorphic && !existing?.fields[path]?.polymorphic) {
          log(
            `  note: ${path} marked polymorphic (observed as both ID string and object - expandable field)`,
          );
        }
      }
      // Object keys become path segments, so a map keyed by data writes that
      // data into a file you are about to commit. Warn at the moment it
      // happens rather than only in SECURITY.md.
      const sensitive = Object.keys(contract.fields).filter((p) =>
        p.split(".").some((seg) => SENSITIVE_SEGMENT.test(seg)),
      );
      if (sensitive.length > 0) {
        log(
          `  WARNING: ${sensitive.length} contract path(s) look like data rather than structure, e.g. ${sensitive
            .slice(0, 3)
            .join(", ")}${sensitive.length > 3 ? ", ..." : ""}`,
        );
        log(
          `           Object keys become path segments. Review this contract before committing it - see SECURITY.md.`,
        );
      }
    }
  }

  if (wrote === 0 && failed === 0) {
    // The default config ships a placeholder glob (test/fixtures/stripe/...),
    // so this is the first message many newcomers see. Tell them exactly what
    // to change and what the tool was looking for.
    const globs = Object.values(config.providers).map((pc) => pc.fixtures);
    log(
      `No payloads found, so no contracts were written.\n` +
        `hookdrift looked for JSON files matching: ${globs.join(", ") || "(no providers configured)"}\n` +
        `Point the "fixtures" glob(s) in hookdrift.config.json at your saved webhook payloads (one JSON file per event), then run \`hookdrift infer\` again.`,
    );
    return 1;
  }
  if (wrote > 0) {
    log(`\n${wrote} contract(s) in ${config.contractsDir}/ — commit them to git.`);
  }
  if (failed > 0) {
    log(
      `${failed} contract(s) skipped as unreadable. Fix the edit, or regenerate with \`hookdrift infer --rebuild\`.`,
    );
    return 1;
  }
  return 0;
}
