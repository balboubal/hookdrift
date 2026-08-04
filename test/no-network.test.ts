import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInfer } from "../src/commands/infer.js";
import { runCheck } from "../src/commands/check.js";
import { runImpact } from "../src/commands/impact.js";
import { runExplain, runInit } from "../src/commands/misc.js";

/**
 * Acceptance criterion: hookdrift makes zero network calls. Every mechanism
 * Node offers for opening a connection is booby-trapped; running the full
 * command surface must not trip any of them.
 */
describe("no network calls, ever", () => {
  let cwd: string;
  const quiet = () => {};
  const boom = (name: string) => () => {
    throw new Error(`NETWORK CALL DETECTED: ${name}`);
  };

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "hookdrift-net-"));
    vi.stubGlobal("fetch", boom("fetch"));
    vi.spyOn(http, "request").mockImplementation(boom("http.request") as never);
    vi.spyOn(http, "get").mockImplementation(boom("http.get") as never);
    vi.spyOn(https, "request").mockImplementation(boom("https.request") as never);
    vi.spyOn(https, "get").mockImplementation(boom("https.get") as never);
    vi.spyOn(net, "connect").mockImplementation(boom("net.connect") as never);
    vi.spyOn(net.Socket.prototype, "connect").mockImplementation(
      boom("net.Socket.connect") as never,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    rmSync(cwd, { recursive: true, force: true });
  });

  it("init → infer → check → check(drift) → impact → explain completes offline", () => {
    runInit(cwd, quiet);
    // Point the default config at local fixtures.
    writeFileSync(
      join(cwd, "hookdrift.config.json"),
      JSON.stringify({
        contractsDir: ".hookdrift",
        providers: { stripe: { fixtures: "fx/**/*.json", eventPath: "type" } },
        source: ["src/**/*.ts"],
        strict: false,
      }),
    );
    const fx = join(cwd, "fx");
    mkdirSync(fx, { recursive: true });
    for (let i = 0; i < 5; i++) {
      writeFileSync(
        join(fx, `${i}.json`),
        JSON.stringify({ type: "charge.succeeded", amount: 100 + i, currency: "usd" }),
      );
    }
    expect(runInfer({ cwd, log: quiet })).toBe(0);
    expect(runCheck({ cwd, log: quiet })).toBe(0);
    writeFileSync(
      join(fx, "drift.json"),
      JSON.stringify({ type: "charge.succeeded", amount: "broken", currency: "usd" }),
    );
    expect(runCheck({ cwd, log: quiet })).toBe(1);
    // impact reads source files off disk and re-writes the report - the README
    // and SECURITY.md both say the guarantee covers every command, so it has to
    // actually be exercised here.
    expect(runImpact(cwd, quiet)).toBe(1);
    expect(runExplain(cwd, quiet)).toBe(1);
  });
});
