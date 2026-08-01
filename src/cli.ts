#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInfer } from "./commands/infer.js";
import { runCheck } from "./commands/check.js";
import { runImpact } from "./commands/impact.js";
import { runInit, runExplain, usage } from "./commands/misc.js";

/** Read from package.json so the CLI and the published package never disagree. */
export function readVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function main(argv: string[], cwd: string): number {
  const [command, ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  const positional = rest.filter((a) => !a.startsWith("--"));
  const dir = positional[0];

  try {
    switch (command) {
      case "init":
        return runInit(cwd);
      case "infer":
        return runInfer({ cwd, fixturesDir: dir, rebuild: flags.has("--rebuild") });
      case "check":
        return runCheck({
          cwd,
          fixturesDir: dir,
          strict: flags.has("--strict") ? true : undefined,
          showSuppressed: flags.has("--show-suppressed"),
          json: flags.has("--json"),
        });
      case "impact":
        return runImpact(cwd);
      case "explain":
        return runExplain(cwd);
      case "--version":
      case "-v":
      case "version":
        console.log(readVersion());
        return 0;
      case undefined:
      case "help":
      case "--help":
      case "-h":
        return usage();
      default:
        console.error(`Unknown command: ${command}\n`);
        usage(console.error);
        return 2;
    }
  } catch (e) {
    console.error(`hookdrift: ${(e as Error).message}`);
    return 2;
  }
}

process.exitCode = main(process.argv.slice(2), process.cwd());
