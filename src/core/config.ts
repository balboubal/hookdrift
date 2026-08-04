import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readTextFileSync } from "./read.js";
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
  "invalid_contract",
] as const;

const ConfigSchema = z
  .object({
    contractsDir: z.string().min(1).default(".hookdrift"),
    providers: z
      .record(
        // A provider name becomes a directory under contractsDir. Empty names
        // wedged the tool; names containing separators or `..` wrote contracts
        // outside contractsDir entirely (an untrusted PR editing config could
        // place files anywhere writable).
        z
          .string()
          .min(1, "provider name must not be empty")
          .regex(
            /^[A-Za-z0-9._-]+$/,
            "provider name may only contain letters, numbers, dot, underscore and hyphen",
          )
          .refine((s) => s !== "." && s !== "..", "provider name must not be . or .."),
        // .strict(): a misplaced key inside a provider (e.g. `strict` or a
        // mistyped `eventpath`) used to be silently dropped.
        z
          .object({
            fixtures: z.string().min(1),
            eventPath: z.string().min(1),
          })
          .strict(),
      )
      .default({}),
    source: z.array(z.string()).default([]),
    strict: z.boolean().default(false),
    minSamples: z.number().int().positive().default(10),
    failOnSkipped: z.boolean().default(false),
    failOnUncontracted: z.boolean().default(false),
    ignore: z
      .array(
        // .strict(): a typo'd `kinds` used to be stripped, turning a
        // kind-scoped rule into one that suppressed EVERY kind at that path -
        // including BREAKING findings - with no warning.
        z
          .object({
            path: z.string().min(1),
            kind: z.enum(FINDING_KINDS).optional(),
            reason: z.string().optional(),
          })
          .strict(),
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
  failOnSkipped: false,
  failOnUncontracted: false,
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
    // Encoding-tolerant read: UTF-8/UTF-16 BOMs from Windows tooling.
    raw = JSON.parse(readTextFileSync(file));
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
