import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandContext } from "../src/cli.js";
import { localDay, tagsOfDay } from "../src/cadence.js";
import { runCadence } from "../src/commands/cadence.js";
import { loadConfig } from "../src/config.js";
import { EXIT, ToolkitError } from "../src/output.js";
import type { RunResult, Tools } from "../src/pack/exec.js";

/** `cadence tag` (train 2026-11-15, Fable C4): at most `tagsPerDay` release tags a day. */

const NOW = new Date(2026, 10, 15, 14, 30); // local 2026-11-15 14:30
const at = (day: number, hour: number): number =>
  Math.floor(new Date(2026, 10, day, hour, 0).getTime() / 1000);

function context(cadence?: Record<string, unknown>, args: string[] = ["tag"]): CommandContext {
  const root = mkdtempSync(join(tmpdir(), "spec-sync-cadence-"));
  writeFileSync(
    join(root, "spec-sync.config.json"),
    JSON.stringify({
      project: "suite-ui",
      gate: { profiles: { local: ["lint"] }, phases: [{ name: "lint", cmd: "true" }] },
      ...(cadence === undefined ? {} : { cadence }),
    }),
  );
  return { flags: { human: false, dryRun: false }, args, repoRoot: root, config: loadConfig(root) };
}

function fakeTools(tags: [string, number][], calls: string[][] = []): Tools {
  return {
    run(file, args): RunResult {
      calls.push([file, ...args]);
      expect(file).toBe("git");
      const stdout = tags.map(([name, seconds]) => `${name}\t${seconds}`).join("\n");
      return { ok: true, code: 0, stdout, stderr: "" };
    },
    spec: () => {
      throw new Error("cadence never calls the spec server");
    },
  };
}

function thrown(fn: () => unknown): ToolkitError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ToolkitError) return error;
    throw error;
  }
  throw new Error("expected a ToolkitError");
}

describe("cadence tag", () => {
  it("allows the first tag of the day and counts only tags of the pattern's day", () => {
    const calls: string[][] = [];
    const result = runCadence(context({ tagsPerDay: 1 }), {
      tools: fakeTools([["v1.0.0", at(14, 23)]], calls),
      now: () => NOW,
    });
    expect(result.exit).toBe(EXIT.OK);
    expect(result.data).toMatchObject({ day: "2026-11-15", allowed: true, today: [] });
    expect(calls[0]).toEqual([
      "git",
      "for-each-ref",
      "--format=%(refname:short)%09%(creatordate:unix)",
      "refs/tags/v*",
    ]);
  });

  it("refuses a second tag on the same day with exit 4, naming today's tag", () => {
    const error = thrown(() =>
      runCadence(context({ tagsPerDay: 1 }), {
        tools: fakeTools([
          ["v1.0.0", at(14, 23)],
          ["v1.1.0", at(15, 9)],
        ]),
        now: () => NOW,
      }),
    );
    expect(error.exit).toBe(EXIT.PRECONDITION);
    expect(error.field).toBe("cadence.tagsPerDay");
    expect(error.message).toMatch(/v1\.1\.0 already tagged today \(2026-11-15\)/);
  });

  it("takes the pattern and limit from the config", () => {
    const calls: string[][] = [];
    const result = runCadence(context({ tagsPerDay: 2, tagPattern: "release-*" }), {
      tools: fakeTools([["release-1", at(15, 8)]], calls),
      now: () => NOW,
    });
    expect(result.data).toMatchObject({ allowed: true, today: ["release-1"], tagsPerDay: 2 });
    expect(calls[0]?.at(-1)).toBe("refs/tags/release-*");
  });

  it("without cadence.tagsPerDay there is no limit and git is not asked", () => {
    const calls: string[][] = [];
    const result = runCadence(context(), { tools: fakeTools([], calls), now: () => NOW });
    expect(result.data).toMatchObject({ allowed: true, tagsPerDay: null });
    expect(calls).toEqual([]);
  });

  it("refuses a missing or unknown subcommand", () => {
    const deps = { tools: fakeTools([]), now: () => NOW };
    expect(thrown(() => runCadence(context({}, []), deps)).field).toBe("subcommand");
    expect(thrown(() => runCadence(context({}, ["release"]), deps)).field).toBe("subcommand");
  });
});

describe("cadence helpers", () => {
  it("localDay is the local calendar day; tagsOfDay skips malformed lines", () => {
    expect(localDay(NOW)).toBe("2026-11-15");
    expect(
      tagsOfDay(`v1\t${at(15, 0)}\nbroken\n\nv2\t${at(15, 23)}\nv0\t${at(16, 0)}`, "2026-11-15"),
    ).toEqual(["v1", "v2"]);
  });
});
