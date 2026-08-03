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
      const obs = observe(samples);
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
    }
  }

  if (wrote === 0 && failed === 0) {
    log("No contracts written — check the fixtures globs in hookdrift.config.json.");
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
