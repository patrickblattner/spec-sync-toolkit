/**
 * `gate` end to end (spec §7.1, M2 acceptance).
 *
 * Every test here drives the command exactly as the dispatcher does — a
 * `CommandContext` in, a `CommandResult` out — so what is asserted is what a
 * caller gets.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { gateCommand, parseGateArgs } from "../src/commands/gate.js";
import { loadConfig, type GatePhase } from "../src/config.js";
import { latestGate, readLedger, ticketMetrics } from "../src/ledger.js";
import { EXIT, ToolkitError, formatJson, type Response } from "../src/output.js";
import type { CommandContext, CommandResult } from "../src/cli.js";

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content, "utf8");
}

/** A repo whose config carries exactly the phases a test needs. */
function makeRepo(phases: GatePhase[], profile = "local"): string {
  const root = mkdtempSync(join(tmpdir(), "spec-sync-gate-"));
  write(
    root,
    "spec-sync.config.json",
    JSON.stringify({
      project: "under-test",
      gate: { profiles: { [profile]: phases.map((p) => p.name) }, phases },
    }),
  );
  return root;
}

function context(root: string, args: string[]): CommandContext {
  return {
    flags: { human: false, dryRun: false },
    args,
    repoRoot: root,
    config: loadConfig(root),
  };
}

const runGate = (root: string, args: string[] = ["--profile", "local"]): Promise<CommandResult> =>
  Promise.resolve(gateCommand.run(context(root, args)));

/** The response as the dispatcher assembles it (`src/cli.ts`). */
function envelope(result: CommandResult): Response {
  const response: Response = {
    command: "gate",
    ok: result.ok,
    exit: result.exit ?? EXIT.OK,
    durationMs: 84213,
    notes: result.notes ?? [],
    ...(result.data ?? {}),
  };
  if (result.logDir !== undefined) response.logDir = result.logDir;
  return response;
}

describe("parseGateArgs", () => {
  it("reads the flags of spec §7.1", () => {
    expect(parseGateArgs(["--profile", "merge"])).toEqual({ profile: "merge", changed: false });
    expect(parseGateArgs(["--profile", "local", "--changed"])).toEqual({
      profile: "local",
      changed: true,
    });
  });

  it("takes the profile attached or separate — both forms mean the same thing", () => {
    expect(parseGateArgs(["--profile=merge"])).toEqual({ profile: "merge", changed: false });
    expect(parseGateArgs(["--profile=local", "--changed"])).toEqual({
      profile: "local",
      changed: true,
    });
    expect(parseGateArgs(["--changed", "--profile=nightly"])).toEqual({
      profile: "nightly",
      changed: true,
    });
  });

  it("names the violated field on a missing or unusable profile (exit 4)", () => {
    for (const args of [
      [],
      ["--changed"],
      ["--profile"],
      ["--profile", "--changed"],
      ["--profile="],
    ]) {
      const error = (() => {
        try {
          parseGateArgs(args);
          return undefined;
        } catch (e) {
          return e;
        }
      })();
      expect(error).toBeInstanceOf(ToolkitError);
      expect((error as ToolkitError).exit).toBe(EXIT.PRECONDITION);
      expect((error as ToolkitError).field).toBe("--profile");
    }
  });

  // The dispatcher hands unknown options through, so catching a typo is this
  // command's job — a silently ignored `--chnged` would run the full gate and
  // call it a `--changed` run.
  it.each([
    ["--profile", "local", "--turbo"],
    ["--profle", "local"],
    ["--profile", "local", "--chnged"],
  ])("refuses an argument it does not know instead of ignoring it: %s", (...args) => {
    const typo = args.find((arg) => /^--(?:turbo|profle|chnged)$/.test(arg));
    const error = (() => {
      try {
        parseGateArgs(args);
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(ToolkitError);
    expect((error as ToolkitError).exit).toBe(EXIT.PRECONDITION);
    expect((error as ToolkitError).field).toBe(typo);
  });

  it("reports an unknown profile as exit 4 naming the config field", async () => {
    const root = makeRepo([{ name: "unit", cmd: "true" }]);
    const error = await runGate(root, ["--profile", "nightly"]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolkitError);
    expect((error as ToolkitError).exit).toBe(EXIT.PRECONDITION);
    expect((error as ToolkitError).field).toBe("gate.profiles.nightly");
  });
});

describe("parseGateArgs — the ledger flags (spec §8)", () => {
  it("reads --issue and --run, attached or separate", () => {
    expect(parseGateArgs(["--profile", "merge", "--issue", "42", "--run", "run-1"])).toEqual({
      profile: "merge",
      changed: false,
      issue: 42,
      run: "run-1",
    });
    expect(parseGateArgs(["--profile=merge", "--issue=42", "--run=run-1"])).toEqual({
      profile: "merge",
      changed: false,
      issue: 42,
      run: "run-1",
    });
    expect(parseGateArgs(["--profile", "merge", "--issue", "#42"]).issue).toBe(42);
  });

  it("leaves both undefined when they are not given", () => {
    expect(parseGateArgs(["--profile", "local"])).toEqual({
      profile: "local",
      changed: false,
      issue: undefined,
      run: undefined,
    });
  });

  it.each([
    [["--profile", "local", "--issue"], "--issue"],
    [["--profile", "local", "--issue="], "--issue"],
    [["--profile", "local", "--issue", "--changed"], "--issue"],
    [["--profile", "local", "--issue", "latest"], "--issue"],
    [["--profile", "local", "--run"], "--run"],
    [["--profile", "local", "--isue", "42"], "--isue"],
  ])("refuses %s with exit 4 naming the field", (args, field) => {
    const error = (() => {
      try {
        parseGateArgs(args);
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(ToolkitError);
    expect((error as ToolkitError).exit).toBe(EXIT.PRECONDITION);
    expect((error as ToolkitError).field).toBe(field);
  });
});

/**
 * Nobody but `gate` can honestly write this event, and `merge` refuses without
 * it (§7.4 `gate-evidence-green`). As long as `gate` wrote nothing, the merge
 * precondition was unfulfillable by the toolkit itself, and the `gateRuns` and
 * `retries` of §8 stayed 0 forever.
 */
describe("gate records its run in the ledger (spec §8)", () => {
  it("appends a gate event carrying profile, verdict, exit and duration", async () => {
    const root = makeRepo([{ name: "unit", cmd: "true" }], "merge");
    await runGate(root, ["--profile", "merge", "--issue", "42", "--run", "run-1"]);

    const events = readLedger(root).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "gate",
      issue: 42,
      run: "run-1",
      profile: "merge",
      ok: true,
      exit: EXIT.OK,
    });
    expect(typeof events[0]?.durationMs).toBe("number");
  });

  it("writes the evidence merge reads as its precondition", async () => {
    const root = makeRepo([{ name: "unit", cmd: "true" }], "merge");
    await runGate(root, ["--profile", "merge", "--issue", "42"]);

    expect(latestGate(readLedger(root).events, 42, "merge")?.ok).toBe(true);
  });

  it("records a red run as red, so it counts as a retry and blocks a merge", async () => {
    const root = makeRepo([{ name: "unit", cmd: "echo 'Error: boom'; exit 1" }], "merge");
    await runGate(root, ["--profile", "merge", "--issue", "42"]);

    const event = latestGate(readLedger(root).events, 42, "merge");
    expect(event?.ok).toBe(false);
    expect(event?.exit).toBe(EXIT.FAILED);
    expect(ticketMetrics(readLedger(root).events)[0]).toMatchObject({ gateRuns: 1, retries: 1 });
  });

  it("writes nothing without --issue — a run without a ticket belongs to none", async () => {
    const root = makeRepo([{ name: "unit", cmd: "true" }]);
    await runGate(root, ["--profile", "local"]);

    expect(readLedger(root).events).toEqual([]);
    expect(existsSync(join(root, ".spec-sync", "ledger.jsonl"))).toBe(false);
  });
});

describe("gate — phase order and the first red", () => {
  it("runs the phases in CONFIG order", async () => {
    const root = makeRepo([
      { name: "format", cmd: "echo format >> order.txt" },
      { name: "lint", cmd: "echo lint >> order.txt" },
      { name: "typecheck", cmd: "echo typecheck >> order.txt" },
    ]);
    const result = await runGate(root);

    expect(result.ok).toBe(true);
    expect(result.exit).toBe(EXIT.OK);
    expect(readFileSync(join(root, "order.txt"), "utf8").split("\n").filter(Boolean)).toEqual([
      "format",
      "lint",
      "typecheck",
    ]);
    expect(result.data?.phases).toEqual([
      { name: "format", skipped: false, exit: 0, durationMs: expect.any(Number) },
      { name: "lint", skipped: false, exit: 0, durationMs: expect.any(Number) },
      { name: "typecheck", skipped: false, exit: 0, durationMs: expect.any(Number) },
    ]);
  });

  it("stops at the first red — the expensive phases behind it never run", async () => {
    const root = makeRepo([
      { name: "format", cmd: "echo format >> order.txt" },
      { name: "lint", cmd: "echo 'AssertionError: expected 1 to be 2' >&2; exit 1" },
      { name: "e2e", cmd: "echo e2e >> order.txt" },
    ]);
    const result = await runGate(root);

    expect(result.ok).toBe(false);
    expect(result.exit).toBe(EXIT.FAILED);
    expect(readFileSync(join(root, "order.txt"), "utf8")).not.toContain("e2e");
    const phases = result.data?.phases as { name: string; exit?: number }[];
    expect(phases.map((p) => p.name)).toEqual(["format", "lint"]);
    expect(phases[1]?.exit).toBe(1);
  });
});

describe("gate — logs never reach stdout (spec §3)", () => {
  it("writes one full log per phase and returns only the directory", async () => {
    const root = makeRepo([
      { name: "format", cmd: "echo checked 120 files" },
      { name: "lint", cmd: "echo 'Error: no-unused-vars'; exit 1" },
    ]);
    const result = await runGate(root);

    expect(result.logDir).toMatch(/^\.spec-sync\/logs\//);
    expect(readFileSync(join(root, result.logDir ?? "", "format.log"), "utf8")).toContain(
      "checked 120 files",
    );
    expect(readFileSync(join(root, result.logDir ?? "", "lint.log"), "utf8")).toContain(
      "no-unused-vars",
    );
    // The measurement condition is evidence, so it is logged too
    // (foundation.testing.guideline §Lastabhängige Messungen).
    const measurement = readFileSync(join(root, result.logDir ?? "", "_measurement.log"), "utf8");
    expect(measurement).toMatch(/load before:/);
    expect(measurement).toMatch(/load after:/);
  });

  it("carries the first error, at most three lines, and no command output", async () => {
    const root = makeRepo([
      {
        name: "unit",
        cmd: "echo noise; echo 'Error: expected 1 to be 2'; echo ' at a.ts:1'; echo ' at b.ts:2'; echo ' at c.ts:3'; exit 1",
      },
    ]);
    const result = await runGate(root);
    const firstError = result.data?.firstError as string;

    expect(firstError).toMatch(/^Error: expected 1 to be 2/);
    expect(firstError.split("\n").filter((line) => line !== "…").length).toBeLessThanOrEqual(3);
    expect(firstError).not.toContain("noise");
  });

  it("keeps the whole response under 15 formatted lines (spec §3)", async () => {
    const root = makeRepo([
      { name: "format", cmd: "true" },
      { name: "lint", cmd: "true" },
      { name: "typecheck", cmd: "true" },
      { name: "unit", cmd: "true" },
    ]);
    const green = formatJson(envelope(await runGate(root)));
    expect(green.split("\n").length).toBeLessThan(15);

    const redRoot = makeRepo([
      { name: "format", cmd: "true" },
      { name: "lint", cmd: "echo 'Error: boom'; exit 1" },
      { name: "unit", cmd: "true" },
    ]);
    const red = formatJson(envelope(await runGate(redRoot)));
    expect(red.split("\n").length).toBeLessThan(15);
  });
});

describe("gate --changed (spec §7.1, §5 `when`)", () => {
  function gitRepo(phases: GatePhase[]): string {
    const root = makeRepo(phases);
    const git = (...args: string[]): void => {
      execFileSync("git", args, { cwd: root, stdio: "ignore" });
    };
    git("init", "-b", "main");
    git("config", "user.email", "gate@example.test");
    git("config", "user.name", "gate");
    git("add", "spec-sync.config.json");
    git("commit", "-m", "base");
    git("checkout", "-b", "feature");
    write(root, "server/db.ts", "export const db = 1;\n");
    return root;
  }

  it("skips a phase the diff does not touch and says so in notes", async () => {
    const root = gitRepo([
      { name: "unit", cmd: "echo unit >> order.txt" },
      { name: "e2e", cmd: "echo e2e >> order.txt", when: ["client/**", "e2e/**"] },
    ]);
    const result = await runGate(root, ["--profile", "local", "--changed"]);

    expect(result.ok).toBe(true);
    expect(result.data?.phases).toEqual([
      { name: "unit", skipped: false, exit: 0, durationMs: expect.any(Number) },
      { name: "e2e", skipped: true },
    ]);
    expect(readFileSync(join(root, "order.txt"), "utf8")).not.toContain("e2e");
    expect((result.notes ?? []).join(" ")).toMatch(/phase e2e skipped/);
    expect((result.notes ?? []).join(" ")).toMatch(/client\/\*\*/);
  });

  it("runs the phase once the diff does touch it", async () => {
    const root = gitRepo([{ name: "e2e", cmd: "echo e2e >> order.txt", when: ["client/**"] }]);
    write(root, "client/app.tsx", "export const App = () => null;\n");

    const result = await runGate(root, ["--profile", "local", "--changed"]);
    expect(result.data?.phases).toEqual([
      { name: "e2e", skipped: false, exit: 0, durationMs: expect.any(Number) },
    ]);
    expect(result.notes).toEqual([]);
    expect(existsSync(join(root, "order.txt"))).toBe(true);
  });

  it("runs every phase without --changed, however narrow its `when`", async () => {
    const root = gitRepo([{ name: "e2e", cmd: "echo e2e >> order.txt", when: ["client/**"] }]);
    const result = await runGate(root);
    expect(result.data?.phases).toEqual([
      { name: "e2e", skipped: false, exit: 0, durationMs: expect.any(Number) },
    ]);
  });
});

describe("gate — the mutex serialises runs on the machine (spec §7.1)", () => {
  it("two concurrent gates never overlap, and the waiting one says so", async () => {
    // Each phase brackets itself in a shared file; an overlap would interleave
    // the markers instead of nesting them.
    const root = makeRepo([
      { name: "unit", cmd: "echo start >> trace.txt; sleep 0.4; echo end >> trace.txt" },
    ]);

    const [first, second] = await Promise.all([runGate(root), runGate(root)]);

    expect(readFileSync(join(root, "trace.txt"), "utf8").split("\n").filter(Boolean)).toEqual([
      "start",
      "end",
      "start",
      "end",
    ]);
    expect(first.ok && second.ok).toBe(true);
    // Exactly one of the two queued, and reports the wait for the model to read.
    const queued = [...(first.notes ?? []), ...(second.notes ?? [])].filter((note) =>
      /^queued /.test(note),
    );
    expect(queued).toHaveLength(1);
    expect(existsSync(join(root, ".spec-sync", "gate.lock"))).toBe(false);
  });
});
