/**
 * The environment a gate run needs (spec §7.1, decision register #67).
 *
 * Two mechanisms with opposite failure directions, and the tests follow that:
 * the wake lock must never break a run that could have gone ahead, and the AC
 * precondition must never let a run start on a machine that can sleep under it.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runGate } from "../src/commands/gate.js";
import { loadConfig, type GatePhase } from "../src/config.js";
import { parseGateMode, parsePowerSource, type Environment } from "../src/gate/environment.js";
import { EXIT, ToolkitError } from "../src/output.js";
import type { CommandContext } from "../src/cli.js";

function makeRepo(phases: GatePhase[]): string {
  const root = mkdtempSync(join(tmpdir(), "spec-sync-env-"));
  const file = join(root, "spec-sync.config.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      project: "under-test",
      gate: { profiles: { local: phases.map((p) => p.name) }, phases },
    }),
  );
  return root;
}

const context = (root: string): CommandContext => ({
  flags: { human: false, dryRun: false },
  args: ["--profile", "local"],
  repoRoot: root,
  config: loadConfig(root),
});

function environment(
  source: "ac" | "battery" | "unknown",
  lock: "held" | "unavailable",
): {
  env: Environment;
  released: () => number;
} {
  let releases = 0;
  return {
    env: {
      readPowerSource: () => source,
      readGateMode: () => "local",
      isCiRunner: () => false,
      holdWakeLock: () => ({
        state: lock,
        release: () => {
          releases += 1;
        },
      }),
    },
    released: () => releases,
  };
}

const greenPhase: GatePhase[] = [{ name: "unit", cmd: "true" }];

describe("power source parsing (pmset -g batt)", () => {
  it("reads mains power", () => {
    expect(parsePowerSource("Now drawing from 'AC Power'\n -InternalBattery-0")).toBe("ac");
  });

  it("reads battery power", () => {
    expect(parsePowerSource("Now drawing from 'Battery Power'\n -InternalBattery-0")).toBe(
      "battery",
    );
  });

  it("calls an unreadable answer unknown rather than guessing", () => {
    expect(parsePowerSource("")).toBe("unknown");
    expect(parsePowerSource("Now drawing from 'Wireless Charger'")).toBe("unknown");
  });
});

describe("the AC precondition (register #67)", () => {
  it("stops on battery with exit 2, before a phase has run", async () => {
    const root = makeRepo(greenPhase);
    const { env } = environment("battery", "unavailable");

    const error = await runGate(context(root), env).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ToolkitError);
    expect((error as ToolkitError).exit).toBe(EXIT.UNPROVABLE);
    expect((error as ToolkitError).message).toContain("battery");
    // Nothing was started: no log directory means no phase ever spawned.
    expect(readdirSync(root)).not.toContain(".spec-sync");
  });

  it("runs normally on mains power", async () => {
    const root = makeRepo(greenPhase);
    const { env } = environment("ac", "unavailable");

    const result = await runGate(context(root), env);

    expect(result.ok).toBe(true);
    expect(result.exit).toBe(EXIT.OK);
  });

  it("does not block when the power source cannot be read", async () => {
    const root = makeRepo(greenPhase);
    const { env } = environment("unknown", "unavailable");

    const result = await runGate(context(root), env);

    // A parser that cannot see the hazard must not turn every run on every
    // platform into exit 2 — that is the expensive direction here.
    expect(result.ok).toBe(true);
  });
});

describe("the wake lock over a run (§7.1)", () => {
  const measurement = (root: string, result: { logDir?: string }): string =>
    readFileSync(join(root, result.logDir as string, "_measurement.log"), "utf8");

  it("holds the lock and releases it when the run ends", async () => {
    const root = makeRepo(greenPhase);
    const { env, released } = environment("ac", "held");

    const result = await runGate(context(root), env);

    expect(measurement(root, result)).toContain("wake lock:      held for the whole run");
    expect(released()).toBe(1);
  });

  it("runs unprotected without failing where no lock exists, and records that", async () => {
    const root = makeRepo(greenPhase);
    const { env } = environment("ac", "unavailable");

    const result = await runGate(context(root), env);

    expect(result.ok).toBe(true);
    expect(measurement(root, result)).toContain("not available on this platform");
  });

  it("keeps the lock out of the answer — it is a condition, not a result", async () => {
    const root = makeRepo(greenPhase);
    const { env } = environment("ac", "unavailable");

    const result = await runGate(context(root), env);

    // Held on darwin, unavailable everywhere else: a constant per platform, and
    // nothing a caller could act on (spec §7.1).
    expect(result.data).not.toHaveProperty("wakeLock");
  });

  it("releases the lock when a phase goes red", async () => {
    const root = makeRepo([{ name: "unit", cmd: "echo 'AssertionError: nope' && false" }]);
    const { env, released } = environment("ac", "held");

    const result = await runGate(context(root), env);

    expect(result.ok).toBe(false);
    expect(released()).toBe(1);
  });
});

describe("parseGateMode", () => {
  it("reads the two known words, trimmed and case-insensitively", () => {
    expect(parseGateMode("remote\n")).toBe("remote");
    expect(parseGateMode("Local")).toBe("local");
  });

  it("is unknown for anything else — and unknown never blocks", () => {
    expect(parseGateMode("")).toBe("unknown");
    expect(parseGateMode(undefined)).toBe("unknown");
    expect(parseGateMode("staging")).toBe("unknown");
  });
});
