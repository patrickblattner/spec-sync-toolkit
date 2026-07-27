/**
 * The reference cases of `production-cockpit/scripts/test-gate.test.mjs`, ported
 * with the logic they hold (spec §7.1, M2 acceptance: "die portierte
 * Sättigungslogik liefert auf den Referenzfällen dieselben Verdikte").
 *
 * Every case is kept for the same reason it exists there: each one is a
 * measurement that once proved an earlier version of this gate wrong. The
 * verdicts are asserted unchanged; only the reason TEXTS are English here, as
 * everything the toolkit says to a caller is.
 *
 * The point of keeping the logic pure is that the gate's own correctness is
 * provable WITHOUT a saturated box — there, the problem could only be observed
 * by accident, twice, at a cost of two hours. Here the saturated box is a
 * fixture.
 */

import { describe, expect, it } from "vitest";
import {
  FOREIGN_SATURATION_FRACTION,
  MIN_HOG_WINDOW_S,
  SATURATED_LOAD_PER_CORE,
  STARVED_OWN_CORES,
  assessSaturation,
  classifyFailures,
  foreignCpuShares,
  isTimeoutFailure,
  isTransientFailure,
  ownCpuCores,
  ownProcessIds,
  parseCpuTime,
  parseProcessTable,
  parseUptime,
  shortComm,
  verdict,
  type CpuSample,
} from "../src/gate/saturation.js";

const sample = (entries: readonly [number, number, string?][]): Map<number, CpuSample> =>
  new Map(entries.map(([pid, cpuSeconds, comm]) => [pid, { cpuSeconds, comm }]));

describe("parseUptime", () => {
  it("reads the macOS form (the real line from the red gate run)", () => {
    expect(
      parseUptime("21:09  up 9 days, 11:14, 10 users, load averages: 7.60 16.80 24.50"),
    ).toEqual({ load1: 7.6, load5: 16.8, load15: 24.5 });
  });

  it("reads the GNU/Linux comma form so a CI box is not silently unmeasured", () => {
    expect(
      parseUptime(" 09:12:01 up 3 days,  2:11,  1 user,  load average: 0.52, 1.10, 2.03"),
    ).toEqual({ load1: 0.52, load5: 1.1, load15: 2.03 });
  });

  it("returns null rather than a fake zero when the probe produced nothing", () => {
    expect(parseUptime("")).toBeNull();
    expect(parseUptime(null)).toBeNull();
    expect(parseUptime("uptime: command not found")).toBeNull();
  });
});

describe("parseCpuTime", () => {
  it("reads the macOS forms, including the one where minutes just keep growing", () => {
    expect(parseCpuTime("0:04.21")).toBeCloseTo(4.21, 5);
    expect(parseCpuTime("278:17.85")).toBeCloseTo(278 * 60 + 17.85, 5);
    expect(parseCpuTime("2356:36.39")).toBeCloseTo(2356 * 60 + 36.39, 5);
    expect(parseCpuTime("1:02:03")).toBe(3723);
    expect(parseCpuTime("2-01:00:00")).toBe(2 * 86400 + 3600);
  });

  it("returns null on anything it cannot read, so a bad row is skipped not guessed", () => {
    expect(parseCpuTime("")).toBeNull();
    expect(parseCpuTime("COMM")).toBeNull();
    expect(parseCpuTime("1:2:3:4")).toBeNull();
  });
});

describe("parseProcessTable", () => {
  const table = [
    "  PID  PPID      TIME COMM",
    "  606     1 1945:28.72 /System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer",
    "81169   900   0:13.80 /Applications/Docker.app/Contents/MacOS/com.docker.backend",
    " 1234     1   2:07.30 /usr/libexec/PackageKit/package_script_service",
  ].join("\n");

  it("parses pid/ppid/cpu-time and keeps a command path containing spaces intact", () => {
    const rows = parseProcessTable(
      `${table}\n 4242     1   0:03.80 /Applications/Wispr Flow.app/Contents/MacOS/Wispr Flow`,
    );
    expect(rows).toHaveLength(4);
    expect(rows[2]).toEqual({
      pid: 1234,
      ppid: 1,
      cpuSeconds: 127.3,
      comm: "/usr/libexec/PackageKit/package_script_service",
    });
    expect(rows[3]?.comm).toBe("/Applications/Wispr Flow.app/Contents/MacOS/Wispr Flow");
  });

  it("survives an empty or unparseable table", () => {
    expect(parseProcessTable("")).toEqual([]);
    expect(parseProcessTable("ps: illegal option")).toEqual([]);
  });
});

// foundation.testing.guideline §Teststufen states it outright: "Ein
// vorgeschalteter Load-Guard muss self-match-sicher sein (der naive Guard zählt
// sich selbst in der Prozessliste)."
describe("ownProcessIds — self-match safety", () => {
  const rows = parseProcessTable(
    [
      "  PID  PPID      TIME COMM",
      "    1     0   0:00.10 /sbin/launchd",
      "  900     1   0:02.00 /Applications/iTerm.app/Contents/MacOS/iTerm2",
      "  950   900   0:01.00 npm",
      "  960   950   0:04.00 node", // <- the gate itself
      "  970   960   1:28.00 vitest", // <- our child
      "  980   970   1:35.00 vitest-worker", // <- our grandchild
      " 1234     1   1:07.30 /usr/libexec/PackageKit/package_script_service",
    ].join("\n"),
  );
  const own = ownProcessIds(rows, 960);

  it("claims the whole subtree below us — busy workers of ours are not foreign load", () => {
    expect(own.has(960)).toBe(true);
    expect(own.has(970)).toBe(true);
    expect(own.has(980)).toBe(true);
  });

  it("claims our ancestors too — npm, the shell and the terminal are ours, not the box's", () => {
    expect(own.has(950)).toBe(true);
    expect(own.has(900)).toBe(true);
    expect(own.has(1)).toBe(true);
  });

  it("leaves genuinely foreign processes foreign", () => {
    expect(own.has(1234)).toBe(false);
  });

  it("terminates on a cyclic/malformed table instead of hanging the gate", () => {
    const cyclic = parseProcessTable(
      ["  PID  PPID      TIME COMM", "   10    11   0:01.00 a", "   11    10   0:01.00 b"].join(
        "\n",
      ),
    );
    expect(ownProcessIds(cyclic, 10)).toEqual(new Set([10, 11]));
  });
});

// This block exists because the FIRST version of this gate was wrong, and only
// a real measurement showed it: reading macOS %CPU and keeping the peak per pid
// reported `launchservicesd 279.5 %` on a box whose load was 3.84.
describe("foreignCpuShares", () => {
  it("reports a sustained foreign consumer at its true share — the PackageKit case", () => {
    const shares = foreignCpuShares({
      first: sample([[1234, 100, "/usr/libexec/PackageKit/package_script_service"]]),
      last: sample([[1234, 100 + 0.7 * 120, "/usr/libexec/PackageKit/package_script_service"]]),
      ownPids: new Set(),
      wallSeconds: 120,
    });
    expect(shares).toHaveLength(1);
    expect(shares[0]?.share).toBeCloseTo(70, 5);
  });

  it("averages a brief spike away instead of letting it stick — the launchservicesd case", () => {
    const shares = foreignCpuShares({
      first: sample([[576, 16697.85, "/System/Library/CoreServices/launchservicesd"]]),
      last: sample([[576, 16698.25, "/System/Library/CoreServices/launchservicesd"]]),
      ownPids: new Set(),
      wallSeconds: 120,
    });
    expect(shares).toEqual([]);
  });

  it("never counts our own workers, however busy they get", () => {
    const shares = foreignCpuShares({
      first: sample([[980, 0, "vitest-worker"]]),
      last: sample([[980, 120, "vitest-worker"]]), // a full core for the whole run — ours, and fine
      ownPids: new Set([980]),
      wallSeconds: 120,
    });
    expect(shares).toEqual([]);
  });

  it("counts a process that only APPEARS mid-run, from its first sighting", () => {
    const shares = foreignCpuShares({
      first: sample([[1234, 0, "installer"]]),
      last: sample([[1234, 60, "installer"]]),
      ownPids: new Set(),
      wallSeconds: 120,
    });
    expect(shares[0]?.share).toBeCloseTo(50, 5); // half of OUR run, not 100 % of its own life
  });

  it("ignores a pid it never saw twice, rather than inventing a baseline of zero", () => {
    const shares = foreignCpuShares({
      first: sample([]),
      last: sample([[1234, 5000, "latecomer"]]),
      ownPids: new Set(),
      wallSeconds: 120,
    });
    expect(shares).toEqual([]);
  });

  // The second lesson from a real run: on a ~3 s run the gate reported
  // launchservicesd at 205.7 % on an IDLE box — real CPU-seconds, but a one-off
  // cost our own spawning induces, made to look permanent by a tiny denominator.
  it("refuses to measure a share over a window too short to mean anything", () => {
    const args = {
      first: sample([[576, 0, "/System/Library/CoreServices/launchservicesd"]]),
      last: sample([[576, 6, "/System/Library/CoreServices/launchservicesd"]]),
      ownPids: new Set<number>(),
    };
    expect(foreignCpuShares({ ...args, wallSeconds: 3 })).toEqual([]);
    expect(foreignCpuShares({ ...args, wallSeconds: 0 })).toEqual([]);
    const overFullRun = foreignCpuShares({ ...args, wallSeconds: 120 });
    expect(overFullRun[0]?.share).toBeCloseTo(5, 5);
    expect(assessSaturation({ baseline: null, ncpu: 16, hogs: overFullRun }).saturated).toBe(false);
  });

  it("still measures once the window reaches the documented minimum", () => {
    const shares = foreignCpuShares({
      first: sample([[1234, 0, "installer"]]),
      last: sample([[1234, MIN_HOG_WINDOW_S * 0.8, "installer"]]),
      ownPids: new Set(),
      wallSeconds: MIN_HOG_WINDOW_S,
    });
    expect(shares[0]?.share).toBeCloseTo(80, 5);
  });
});

describe("assessSaturation", () => {
  const ncpu = 16;

  it("calls the measured QUIET box quiet — the run that went 295 files / 3562 tests green", () => {
    const result = assessSaturation({
      baseline: { load1: 2.21, load5: 4.86, load15: 12.48 },
      ncpu,
      hogs: [],
    });
    expect(result.saturated).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  it("calls the measured RED gate box saturated — 1-min looked harmless at 7.6, 5/15-min did not", () => {
    const result = assessSaturation({
      baseline: { load1: 7.6, load5: 16.8, load15: 24.5 },
      ncpu,
      hogs: [],
    });
    expect(result.saturated).toBe(true);
    expect(result.reasons[0]).toMatch(/baseline load before the run 24\.50/);
  });

  it("catches foreign load that only STARTS mid-run, which the baseline cannot see", () => {
    const result = assessSaturation({
      baseline: { load1: 2.2, load5: 3.0, load15: 4.0 },
      ncpu,
      hogs: [
        { pid: 1234, share: 320, comm: "/usr/libexec/PackageKit/package_script_service" },
        { pid: 2115, share: 82, comm: "installd" },
      ],
    });
    expect(result.saturated).toBe(true);
    expect(result.reasons[0]).toMatch(/4\.0 of 16 cores/);
    expect(result.reasons[0]).toMatch(/package_script_service/);
  });

  it("does not mistake the quiet box's normal background for saturation", () => {
    const result = assessSaturation({
      baseline: { load1: 2.21, load5: 4.86, load15: 12.48 },
      ncpu,
      hogs: [
        { pid: 606, share: 14.4, comm: "WindowServer" },
        { pid: 81169, share: 13.8, comm: "com.docker.backend" },
      ],
    });
    expect(result.saturated).toBe(false);
  });

  it("reports nothing when the probe produced no evidence, rather than inventing it", () => {
    expect(assessSaturation({ baseline: null, ncpu, hogs: [] })).toEqual({
      saturated: false,
      reasons: [],
      starvedOnly: false,
    });
  });

  // The correction a real measurement forced: `installd` at 82 % of ONE core is
  // the genuine installer from the incident — and still only 0.05 of a 16-core
  // box, with fifteen cores free.
  it("does not call the box saturated because ONE neighbour is busy", () => {
    const result = assessSaturation({
      baseline: { load1: 3.0, load5: 3.05, load15: 6.82 },
      ncpu,
      hogs: [
        { pid: 2115, share: 81.9, comm: "installd" },
        { pid: 96654, share: 99.8, comm: "node" },
      ],
    });
    expect(result.saturated).toBe(false);
  });

  it("holds the documented thresholds", () => {
    expect(SATURATED_LOAD_PER_CORE).toBe(1.0);
    expect(FOREIGN_SATURATION_FRACTION).toBe(0.25);
  });
});

describe("isTimeoutFailure", () => {
  it.each([
    "Test timed out in 10000ms.\nIf this is a long-running test, pass a timeout value",
    "Hook timed out in 60000ms.",
    "Timed out in 5000ms.",
    "Timeout calling onTaskUpdate",
    "Vitest worker terminated unexpectedly",
    "Terminating worker thread",
  ])("recognises the runner giving up: %s", (message) => {
    expect(isTimeoutFailure(message)).toBe(true);
  });

  it.each([
    "expected 1 to be 2 // Object.is equality",
    "AssertionError: expected undefined to be defined",
    "TypeError: Cannot read properties of null (reading 'id')",
    // A test that ASSERTS ON a timeout value is content, not an abort.
    "expected timeout config to be 10000",
  ])("does not mistake a content failure for an abort: %s", (message) => {
    expect(isTimeoutFailure(message)).toBe(false);
  });
});

describe("isTransientFailure", () => {
  it.each([
    "Error: read ECONNRESET",
    "Error: write EPIPE",
    "Error: connect ETIMEDOUT 10.1.0.4:443",
    "FetchError: request to http://localhost:4100/api failed, reason: socket hang up",
  ])("recognises the network naming itself: %s", (message) => {
    expect(isTransientFailure(message)).toBe(true);
  });

  // This rule turns a reported cause into an excuse, so its failure direction is
  // the REVERSE of every other rule here: too wide is what costs a defect. These
  // are the cases that must stay red.
  it.each([
    "AssertionError: expected 'ECONNRESET' to be 'ok'",
    "expected error.code to be ETIMEDOUT",
    "assert.strictEqual(err.code, 'EPIPE')",
    "TypeError: Cannot read properties of null (reading 'id')",
    "Test timed out in 10000ms.",
  ])("does not excuse a test that ASSERTS on the signature: %s", (message) => {
    expect(isTransientFailure(message)).toBe(false);
  });

  it("judges each line on its own — a distant 'expected' must not disarm the guard", () => {
    // Joined into one blob, the `expected` below would suppress the signature
    // above it and turn an infrastructure abort into a defect (and, the other
    // way round, a stray signature would excuse a real assertion).
    expect(isTransientFailure(["Error: read ECONNRESET", "expected 1 to be 2"])).toBe(true);
  });
});

describe("classifyFailures", () => {
  const timeoutFail = { file: "a.test.ts", messages: ["Test timed out in 10000ms."] };
  const contentFail = { file: "b.test.ts", messages: ["expected 1 to be 2"] };

  it("separates the two states instead of flattening them into 'N failed'", () => {
    const { timeout, content } = classifyFailures([timeoutFail, contentFail]);
    expect(timeout).toEqual([timeoutFail]);
    expect(content).toEqual([contentFail]);
  });

  it("counts a failure carrying BOTH as content — a real defect is never explained away by load", () => {
    const both = {
      file: "c.test.ts",
      messages: ["Test timed out in 10000ms.", "expected 1 to be 2"],
    };
    expect(classifyFailures([both]).content).toEqual([both]);
    expect(classifyFailures([both]).timeout).toEqual([]);
  });

  it("treats a failure with no message at all as content — unexplained is not excusable", () => {
    const bare = { file: "d.test.ts", messages: [] };
    expect(classifyFailures([bare]).content).toEqual([bare]);
  });

  it("puts a signature-only failure in its own bucket, not with the timeouts", () => {
    const infra = { file: "e.test.ts", messages: ["Error: read ECONNRESET"] };
    const { transient, timeout, content } = classifyFailures([infra]);
    expect(transient).toEqual([infra]);
    expect(timeout).toEqual([]);
    expect(content).toEqual([]);
  });

  it("counts a signature BESIDE a real cause as content — the expensive direction", () => {
    const both = {
      file: "f.test.ts",
      messages: ["Error: read ECONNRESET", "expected 1 to be 2"],
    };
    expect(classifyFailures([both]).content).toEqual([both]);
    expect(classifyFailures([both]).transient).toEqual([]);
  });

  it("lets transient win over timeout when a failure carries both", () => {
    // The two reach exit 2 by different routes and only the timeout route asks
    // about the load. A reset that also produced a timeout is still the network.
    const both = {
      file: "g.test.ts",
      messages: ["Test timed out in 10000ms.", "Error: read ECONNRESET"],
    };
    expect(classifyFailures([both]).transient).toEqual([both]);
    expect(classifyFailures([both]).timeout).toEqual([]);
  });
});

describe("verdict — three classes, deliberately not two", () => {
  it("0: nothing failed", () => {
    expect(verdict({})).toBe(0);
  });

  // A busy box slows everything; it does not pick one file and hang it. So the
  // distribution of the timeouts separates the two signatures that CPU numbers
  // cannot — see `SCATTERED_MIN_FILES`.
  it("1: timeouts confined to ONE file are a hang, however loaded the box was", () => {
    expect(verdict({ timeoutFailures: 6, saturated: true, failingFiles: 1 })).toBe(1);
  });

  it("2: the same timeouts scattered across files are the box", () => {
    expect(verdict({ timeoutFailures: 6, saturated: true, failingFiles: 3 })).toBe(2);
  });

  it("2: an unnamed distribution falls back to the saturation signal alone", () => {
    // Not every runner names files. Absent evidence must not silently flip a
    // verdict — it leaves the previous behaviour in place.
    expect(verdict({ timeoutFailures: 6, saturated: true })).toBe(2);
  });

  it("1: one file and a quiet box stays a defect — both guards agree", () => {
    expect(verdict({ timeoutFailures: 6, saturated: false, failingFiles: 1 })).toBe(1);
  });

  it("1: a content failure is RED even on a saturated box — load never excuses a defect", () => {
    expect(verdict({ contentFailures: 1, timeoutFailures: 9, saturated: true })).toBe(1);
  });

  it("1: timeouts on a QUIET box are a real finding (a hang or a flake)", () => {
    expect(verdict({ timeoutFailures: 3, saturated: false })).toBe(1);
  });

  it("2: a transient signature is unprovable on a QUIET box — load was never the claim", () => {
    expect(verdict({ transientFailures: 1, saturated: false })).toBe(2);
  });

  it("2: and it does not need the files to be scattered either", () => {
    // The scatter guard separates a hang from load. It says nothing about a
    // network that named itself, and one file may well be the only one doing I/O.
    expect(verdict({ transientFailures: 4, saturated: false, failingFiles: 1 })).toBe(2);
  });

  it("1: a content failure outranks a transient signature — a defect is never excused", () => {
    expect(verdict({ contentFailures: 1, transientFailures: 9, saturated: false })).toBe(1);
  });

  it("2: timeouts on a SATURATED box are unprovable — the 2026-07-19 case", () => {
    expect(verdict({ timeoutFailures: 3, saturated: true })).toBe(2);
  });

  it("2 is not a pass — it stays non-zero and keeps stopping the merge", () => {
    expect(verdict({ timeoutFailures: 3, saturated: true })).not.toBe(0);
  });

  it("saturation alone never turns a red into a green", () => {
    expect(verdict({ saturated: true })).toBe(0);
    expect(verdict({ contentFailures: 1, saturated: true })).toBe(1);
  });

  it("classifies a runner that died without any reported failure by the same rule", () => {
    expect(verdict({ runnerFailed: true, saturated: false })).toBe(1);
    expect(verdict({ runnerFailed: true, saturated: true })).toBe(2);
  });
});

describe("shortComm", () => {
  it("shortens a path to the binary name for readable output", () => {
    expect(shortComm("/usr/libexec/PackageKit/package_script_service")).toBe(
      "package_script_service",
    );
    expect(shortComm("node")).toBe("node");
  });
});

// The starvation signal. Both other signals ask "who else is eating the box";
// this one asks whether WE got to compute at all. It exists because a machine
// that stops delivering starves the run without any process showing up as a hog.
describe("ownCpuCores", () => {
  const win = 100;

  it("sums only OUR pids, as cores over the run window", () => {
    const first = sample([
      [1, 0],
      [2, 10],
      [9, 0],
    ]);
    const last = sample([
      [1, 400],
      [2, 410],
      [9, 900], // foreign: must not count
    ]);
    expect(ownCpuCores({ first, last, ownPids: new Set([1, 2]), wallSeconds: win })).toBeCloseTo(
      8,
      5,
    );
  });

  it("counts a worker that lived entirely between two samples in full", () => {
    expect(
      ownCpuCores({
        first: new Map(),
        last: sample([[1, 50]]),
        ownPids: new Set([1]),
        wallSeconds: win,
      }),
    ).toBeCloseTo(0.5, 5);
  });

  it("is 0 for a zero-length window rather than dividing by zero", () => {
    expect(
      ownCpuCores({ first: new Map(), last: new Map(), ownPids: new Set(), wallSeconds: 0 }),
    ).toBe(0);
  });
});

describe("assessSaturation — starvation", () => {
  const quiet = { load1: 2, load5: 2, load15: 2 };

  // Owner decision 2026-07-27, replacing the earlier reading of this same case.
  // The measured run — 0.08 cores over 355 s on 16 cores, foreign load 4 % — used
  // to be called unprovable on that evidence alone. It no longer is: low own-CPU
  // has two causes that CPU numbers cannot separate (pushed aside vs. waiting on
  // I/O), and an I/O-bound merge profile hits the threshold routinely on a
  // completely idle box. Reported by the owner: 16 cores at ~5 % total load, and
  // the gate still printed SATURATED.
  //
  // The observation is kept — it just no longer carries the verdict on its own.
  it("reports the starved run but does not call it saturated without corroboration", () => {
    const { saturated, reasons, starvedOnly } = assessSaturation({
      baseline: quiet,
      ncpu: 16,
      hogs: [],
      ownCores: 0.08,
      wallSeconds: 355,
    });
    expect(saturated).toBe(false);
    expect(starvedOnly).toBe(true);
    // The log must still say what was seen, or a later reader cannot tell a quiet
    // box from an unexamined one.
    expect(reasons.join(" ")).toContain("barely computed");
  });

  it("counts starvation once another signal establishes the box was busy", () => {
    const busy = { load1: 20, load5: 20, load15: 20 };
    const { saturated, starvedOnly, reasons } = assessSaturation({
      baseline: busy,
      ncpu: 16,
      hogs: [],
      ownCores: 0.08,
      wallSeconds: 355,
    });
    expect(saturated).toBe(true);
    expect(starvedOnly).toBe(false);
    expect(reasons.join(" ")).toContain("barely computed");
  });

  it("counts starvation when foreign processes are the corroboration", () => {
    const hogs = [{ pid: 1, comm: "vm", share: 500 }];
    expect(
      assessSaturation({ baseline: quiet, ncpu: 16, hogs, ownCores: 0.08, wallSeconds: 355 })
        .saturated,
    ).toBe(true);
  });

  it("leaves a healthy run alone — 8 cores of own work is not starvation", () => {
    expect(
      assessSaturation({ baseline: quiet, ncpu: 16, hogs: [], ownCores: 8, wallSeconds: 55 })
        .saturated,
    ).toBe(false);
  });

  it("does not fire below the hog window, where our own start-up cost dominates", () => {
    expect(
      assessSaturation({ baseline: quiet, ncpu: 16, hogs: [], ownCores: 0.1, wallSeconds: 5 })
        .saturated,
    ).toBe(false);
  });

  it("does not fire on a small box, where under one core is normal parallelism", () => {
    // A load of 2 is quiet on 16 cores but FULL on 2 — so this case needs its
    // own baseline, otherwise the first signal fires and the assertion would
    // pass for the wrong reason.
    const quietForTwo = { load1: 0.4, load5: 0.4, load15: 0.4 };
    expect(
      assessSaturation({
        baseline: quietForTwo,
        ncpu: 2,
        hogs: [],
        ownCores: 0.4,
        wallSeconds: 300,
      }).saturated,
    ).toBe(false);
  });

  it("stays silent when ownCores was not measured at all", () => {
    expect(
      assessSaturation({ baseline: quiet, ncpu: 16, hogs: [], wallSeconds: 300 }).saturated,
    ).toBe(false);
  });

  it("sits between the measured populations: over suspended, under healthy", () => {
    expect(STARVED_OWN_CORES).toBeGreaterThan(0.08 * 2); // 3x over the suspended run
    expect(STARVED_OWN_CORES).toBeLessThan(0.5 / 1.5); // 2x under the healthy runs
  });
});
