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
import { parseGateArgs, runGate as runGateWith } from "../src/commands/gate.js";
import type { Environment } from "../src/gate/environment.js";
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

/**
 * A machine on mains power with no wake lock available — the environment every
 * test here wants, so that none of them depends on how the box running the
 * suite happens to be plugged in. The environment itself is tested in
 * `gate-environment.test.ts`.
 */
const onMains: Environment = {
  readPowerSource: () => "ac",
  holdWakeLock: () => ({ state: "unavailable", release: () => {} }),
};

const runGate = (root: string, args: string[] = ["--profile", "local"]): Promise<CommandResult> =>
  Promise.resolve(runGateWith(context(root, args), onMains));

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

  /**
   * PROC-REL-015 rev 4 (#11): the two exit-2 cases are counted differently, and
   * the exit code alone cannot tell them apart.
   */
  it("does not count an abort before the first phase — no event, no retry", async () => {
    const root = makeRepo([{ name: "unit", cmd: "true" }], "merge");
    const onBattery: Environment = {
      readPowerSource: () => "battery",
      holdWakeLock: () => ({ state: "unavailable", release: () => {} }),
    };

    const error = await runGateWith(
      context(root, ["--profile", "merge", "--issue", "42"]),
      onBattery,
    ).catch((e: unknown) => e);

    expect((error as ToolkitError).exit).toBe(EXIT.UNPROVABLE);
    expect((error as ToolkitError).reason).toBe("no-run");
    expect(readLedger(root).events).toEqual([]);
    expect(ticketMetrics(readLedger(root).events)).toEqual([]);
  });

  it("counts an unprovable run that took place — it is a run, not a non-run", async () => {
    const root = makeRepo(
      [{ name: "unit", cmd: "echo 'Error: read ECONNRESET'; exit 1" }],
      "merge",
    );
    await runGate(root, ["--profile", "merge", "--issue", "42"]);

    const event = latestGate(readLedger(root).events, 42, "merge");
    expect(event?.exit).toBe(EXIT.UNPROVABLE);
    expect(ticketMetrics(readLedger(root).events)[0]).toMatchObject({ gateRuns: 1, retries: 1 });
  });

  it("writes nothing without --issue — a run without a ticket belongs to none", async () => {
    const root = makeRepo([{ name: "unit", cmd: "true" }]);
    await runGate(root, ["--profile", "local"]);

    expect(readLedger(root).events).toEqual([]);
    expect(existsSync(join(root, ".spec-sync", "ledger.jsonl"))).toBe(false);
  });
});

/**
 * #13: the case the preflight exists for — a working tree that was never
 * installed — used to die wherever the first phase looked for its tool. In
 * `wt-489` that was `npx`, which went to the registry and returned E404 on
 * `spec-sync`: a message about nothing, and no log to look at.
 */
describe("gate — a working tree without its own install (#13)", () => {
  it("ends in the preflight with exit 2, naming the cause and the way out", async () => {
    const root = makeRepo([{ name: "unit", cmd: "true" }], "merge");
    write(root, "package.json", JSON.stringify({ name: "under-test" }));

    const error = await runGate(root, ["--profile", "merge", "--issue", "42"]).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ToolkitError);
    expect((error as ToolkitError).exit).toBe(EXIT.UNPROVABLE);
    expect((error as ToolkitError).message).toContain("not a gate-capable working tree");
    expect((error as ToolkitError).message).toContain("node_modules");
    expect((error as ToolkitError).message).toContain("npm install");
    // Nothing was started, and by #11 nothing is counted against the ticket.
    expect((error as ToolkitError).reason).toBe("no-run");
    expect(existsSync(join(root, ".spec-sync"))).toBe(false);
    expect(readLedger(root).events).toEqual([]);
  });

  it("runs once the working tree carries its own node_modules", async () => {
    const root = makeRepo([{ name: "unit", cmd: "true" }]);
    write(root, "package.json", JSON.stringify({ name: "under-test" }));
    mkdirSync(join(root, "node_modules"), { recursive: true });

    expect((await runGate(root)).ok).toBe(true);
  });

  it("leaves a repo without a package.json alone — not every gate is a Node repo", async () => {
    const root = makeRepo([{ name: "unit", cmd: "true" }]);
    expect((await runGate(root)).ok).toBe(true);
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
    // (foundation.testing.guideline §load-dependent measurements).
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
    // No verdict list in this output, so the answer is a log line — and says so
    // rather than passing itself off as the runner's verdict (#10).
    expect(result.notes?.join("\n")).toContain("no failing test in the output");
  });

  it("carries the failing test the runner reported, not the first error line (#10)", async () => {
    const root = makeRepo([
      {
        name: "unit",
        cmd:
          "echo '[error] general.public_base_url is not set'; " +
          "echo ' FAIL  src/webinarSync.test.ts > syncs the roster'; " +
          "echo 'AssertionError: expected 0 to be 3'; exit 1",
      },
    ]);
    const result = await runGate(root);

    expect(result.data?.firstError).toBe(
      "FAIL  src/webinarSync.test.ts > syncs the roster\nAssertionError: expected 0 to be 3",
    );
    expect(result.notes?.join("\n")).not.toContain("no failing test");
  });

  // #17: the same run, but the runner coloured it — which is the normal case,
  // because a phase writes to a pipe only in OUR capture and many suites force
  // colour on. The note denied the verdict and sent an audit at the `[error]`
  // line of a test that passed (community-platform Q&A #692).
  it("does not deny a verdict just because the runner coloured it (#17)", async () => {
    // `\033` in a printf FORMAT is the escape byte itself — the phase really
    // writes colour, exactly as vitest does.
    const root = makeRepo([
      {
        name: "unit",
        cmd:
          "printf '[error] general.public_base_url is not set\\n'; " +
          "printf '\\033[41m\\033[1m FAIL \\033[22m\\033[49m src/webinarSync.test.ts > syncs the roster\\n'; " +
          "printf '\\033[31mAssertionError: expected 0 to be 3\\033[39m\\n'; exit 1",
      },
    ]);
    const result = await runGate(root);

    expect(result.data?.firstError).toBe(
      "FAIL  src/webinarSync.test.ts > syncs the roster\nAssertionError: expected 0 to be 3",
    );
    expect(result.notes?.join("\n")).not.toContain("no failing test");
  });

  it("grows with the number of phases, never with the size of their output (spec §3)", async () => {
    /** Formatted lines of the response for `names`, each phase printing `chatter` lines. */
    const lines = async (names: string[], chatter: number): Promise<number> => {
      const root = makeRepo(names.map((name) => ({ name, cmd: `seq ${chatter}` })));
      return formatJson(envelope(await runGate(root))).split("\n").length;
    };
    const four = ["format", "lint", "typecheck", "unit"];

    // A phase that says three lines and one that says three thousand cost the same.
    const quiet = await lines(four, 3);
    expect(await lines(four, 3000)).toBe(quiet);

    // A fifth phase costs exactly one line — the only thing that grows.
    expect(await lines([...four, "audits"], 3)).toBe(quiet + 1);
  });

  it("holds that bound when a phase fails, however loud it failed (spec §3)", async () => {
    const red = async (chatter: number): Promise<number> => {
      const root = makeRepo([
        { name: "format", cmd: "true" },
        { name: "lint", cmd: `echo 'Error: boom'; seq ${chatter}; exit 1` },
        { name: "unit", cmd: "true" },
      ]);
      return formatJson(envelope(await runGate(root))).split("\n").length;
    };
    expect(await red(3000)).toBe(await red(3));
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
