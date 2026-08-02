import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { HookdriftConfig } from "../types.js";

export const CONFIG_FILE = "hookdrift.config.json";

const FINDING_KINDS = [
  "path_removed",
  "path_moved",
  "type_changed",
  "became_nullable",
  "enum_value_removed",
  "array_scalar_flip",
  "required_became_optional",
  "enum_value_added",
  "format_changed",
  "precision_shift",
  "new_field",
  "presence_shift",
  "uncontracted_event",
] as const;

const ConfigSchema = z
  .object({
    contractsDir: z.string().min(1).default(".hookdrift"),
    providers: z
      .record(
        z.string(),
        z.object({
          fixtures: z.string().min(1),
          eventPath: z.string().min(1),
        }),
      )
      .default({}),
    source: z.array(z.string()).default([]),
    strict: z.boolean().default(false),
    minSamples: z.number().int().positive().default(10),
    ignore: z
      .array(
        z.object({
          path: z.string().min(1),
          kind: z.enum(FINDING_KINDS).optional(),
          reason: z.string().optional(),
        }),
      )
      .default([]),
  })
  .strict();

export const DEFAULT_CONFIG: HookdriftConfig = {
  contractsDir: ".hookdrift",
  providers: {
    stripe: { fixtures: "test/fixtures/stripe/**/*.json", eventPath: "type" },
  },
  source: ["src/**/*.{ts,js,tsx}"],
  strict: false,
  minSamples: 10,
  ignore: [],
};

export function loadConfig(cwd: string): HookdriftConfig {
  const file = join(cwd, CONFIG_FILE);
  if (!existsSync(file)) {
    throw new Error(
      `No ${CONFIG_FILE} found in ${cwd}. Run \`hookdrift init\` first.`,
    );
  }
  let raw: unknown;
  try {
    // Strip a UTF-8 BOM: editors and PowerShell redirection on Windows add one,
    // and JSON.parse rejects it.
    raw = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (e) {
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${(e as Error).message}`);
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => {
      const key = i.path.length ? i.path.join(".") : "(root)";
      return `  ${key}: ${i.message}`;
    });
    throw new Error(`Invalid ${CONFIG_FILE}:\n${lines.join("\n")}`);
  }
  return parsed.data as HookdriftConfig;
}

export function writeDefaultConfig(cwd: string): string {
  const file = join(cwd, CONFIG_FILE);
  if (existsSync(file)) {
    throw new Error(`${CONFIG_FILE} already exists — not overwriting.`);
  }
  writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");
  return file;
}
