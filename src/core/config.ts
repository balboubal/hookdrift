import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HookdriftConfig } from "../types.js";

export const CONFIG_FILE = "hookdrift.config.json";

export const DEFAULT_CONFIG: HookdriftConfig = {
  contractsDir: ".hookdrift",
  providers: {
    stripe: { fixtures: "test/fixtures/stripe/**/*.json", eventPath: "type" },
  },
  source: ["src/**/*.{ts,js,tsx}"],
  strict: false,
};

export function loadConfig(cwd: string): HookdriftConfig {
  const file = join(cwd, CONFIG_FILE);
  if (!existsSync(file)) {
    throw new Error(
      `No ${CONFIG_FILE} found in ${cwd}. Run \`hookdrift init\` first.`,
    );
  }
  const raw = JSON.parse(readFileSync(file, "utf8"));
  return { ...DEFAULT_CONFIG, ...raw };
}

export function writeDefaultConfig(cwd: string): string {
  const file = join(cwd, CONFIG_FILE);
  if (existsSync(file)) {
    throw new Error(`${CONFIG_FILE} already exists — not overwriting.`);
  }
  writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");
  return file;
}
