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

/**
 * Flags each command accepts. Anything else is rejected rather than ignored:
 * a safety flag that fails open on a typo (`--strcit` silently running
 * non-strict) is worse than no flag at all.
 */
const ALLOWED_FLAGS: Record<string, readonly string[]> = {
  init: [],
  infer: ["--rebuild"],
  check: ["--strict", "--json", "--show-suppressed", "--fail-on-skipped", "--fail-on-uncontracted", "--fail-on-unexercised"],
  impact: ["--strict"],
  explain: [],
  // The aliases too, or `hookdrift --version --bogus` exits 0 and a user
  // believes a flag was accepted that was never read.
  "--version": [],
  "-v": [],
  version: [],
  help: [],
  "--help": [],
  "-h": [],
};
const MAX_POSITIONAL: Record<string, number> = {
  init: 0,
  infer: 1,
  check: 1,
  impact: 0,
  explain: 0,
  "--version": 0,
  "-v": 0,
  version: 0,
  help: 0,
  "--help": 0,
  "-h": 0,
};

export function main(argv: string[], cwd: string): number {
  const [command, ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith("-")));
  const positional = rest.filter((a) => !a.startsWith("-"));
  const dir = positional[0];

  const allowed = ALLOWED_FLAGS[command ?? ""];
  if (allowed) {
    const unknown = [...flags].filter((f) => !allowed.includes(f));
    if (unknown.length > 0) {
      console.error(
        `hookdrift: unknown flag${unknown.length > 1 ? "s" : ""} for \`${command}\`: ${unknown.join(", ")}\n` +
          `Accepted: ${allowed.length ? allowed.join(", ") : "(none)"}\n` +
          `Refusing to run: a mistyped flag would silently change what this command enforces.`,
      );
      return 2;
    }
    const maxPos = MAX_POSITIONAL[command!] ?? 0;
    if (positional.length > maxPos) {
      console.error(
        `hookdrift: \`${command}\` takes ${maxPos} positional argument(s), got ${positional.length}: ${positional.join(", ")}`,
      );
      return 2;
    }
  }

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
          failOnSkipped: flags.has("--fail-on-skipped") ? true : undefined,
          failOnUncontracted: flags.has("--fail-on-uncontracted") ? true : undefined,
          failOnUnexercised: flags.has("--fail-on-unexercised") ? true : undefined,
        });
      case "impact":
        return runImpact(cwd, undefined, flags.has("--strict") ? true : undefined);
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
