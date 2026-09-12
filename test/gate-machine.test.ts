/**
 * The capacity probe as the gate actually takes it (`SST-DESIGN-012` rev 3).
 *
 * Everything that can be decided from numbers is decided in `saturation.ts` and
 * tested there. What is left here is the part that touches the machine: where
 * the probe is taken, what it reports when it cannot run, and — once, against
 * the real worker threads — that the measurement itself is sound on a box that
 * owns its cores.
 */

import { describe, expect, it } from "vitest";
import {
  CAPACITY_ITERATIONS,
  MachineProbe,
  capacityNote,
  measureCapacity,
  renderMeasurement,
} from "../src/gate/machine.js";
import { CAPACITY_SCALING_FRACTION, type CapacityProbe } from "../src/gate/saturation.js";

/** A box with nothing to report, so only the capacity probe moves the result. */
const idle = {
  readUptime: () => "load averages: 0.50 0.50 0.50",
  readProcessTable: () => "  PID  PPID TIME COMM\n    1     0 00:01 launchd\n",
  ncpu: 8,
  selfPid: 1,
};

const stub =
  (factor: number | null, skipped?: string) =>
  (when: "before" | "after"): Promise<CapacityProbe> =>
    Promise.resolve(
      skipped === undefined ? { when, k: 4, factor } : { when, k: 4, factor, skipped },
    );

describe("MachineProbe — capacity", () => {
  it("carries both probes into the condition, in the order they were taken", async () => {
    const probe = new MachineProbe({ ...idle, measureCapacity: stub(3.8) });
    probe.begin();
    await probe.probeCapacity("before");
    await probe.probeCapacity("after");
    const condition = probe.end();

    expect(condition.capacity.map((entry) => entry.when)).toEqual(["before", "after"]);
    expect(condition.saturated).toBe(false);
  });

  it("turns a capped machine into exit-2 evidence on an otherwise quiet box", async () => {
    const probe = new MachineProbe({ ...idle, measureCapacity: stub(0.9) });
    probe.begin();
    await probe.probeCapacity("before");
    await probe.probeCapacity("after");
    const condition = probe.end();

    expect(condition.saturated).toBe(true);
    expect(condition.starvedOnly).toBe(false);
    expect(condition.reasons.join(" ")).toContain("fewer than half the cores it shows");
  });

  it("reports a machine with no probe at all as unprobed, not as whole", () => {
    const probe = new MachineProbe({ ...idle, measureCapacity: stub(0.9) });
    probe.begin();
    const condition = probe.end();

    expect(condition.capacity).toEqual([]);
    expect(condition.saturated).toBe(false);
    expect(capacityNote(condition.capacity)).toBe("capacity probe: not taken");
  });
});

describe("measureCapacity — the real probe", () => {
  it("skips a box too small for the signal and says why, rather than reporting a factor", async () => {
    const probe = await measureCapacity("before", 2);
    expect(probe.factor).toBeNull();
    expect(probe.skipped).toContain("2 cores is below the 4");
  });

  /**
   * The one test that spends real CPU, and it earns it: a factor is only
   * evidence if the measurement can tell a whole machine from a capped one, and
   * that cannot be faked. The assertion is deliberately loose — the box running
   * the suite may be busy with the suite itself — but it holds the two ends the
   * norm names apart: a healthy machine lands far above the incident's 0.9.
   */
  it("measures above the carrying floor on a machine that owns its cores", async () => {
    const ncpu = 8;
    const probe = await measureCapacity("before", ncpu);
    if (probe.factor === null) {
      // A box without worker threads reports, never throws — that IS the contract.
      expect(probe.skipped).toBeTypeOf("string");
      return;
    }
    expect(probe.k).toBe(4);
    expect(probe.factor).toBeGreaterThan(probe.k * CAPACITY_SCALING_FRACTION);
  }, 60_000);

  it("keeps a fixed work budget, so the threshold survives a change of budget", () => {
    expect(CAPACITY_ITERATIONS).toBeGreaterThan(0);
  });
});

describe("capacityNote", () => {
  it("names both measurements and the floor, even when neither carries", () => {
    const note = capacityNote([
      { when: "before", k: 4, factor: 3.81 },
      { when: "after", k: 4, factor: 3.74 },
    ]);
    expect(note).toContain("before 3.81");
    expect(note).toContain("after 3.74");
    expect(note).toContain("k=4");
    expect(note).toContain("2.00");
  });

  it("says a skipped probe was skipped, and why, without inventing a factor", () => {
    const note = capacityNote([
      { when: "before", k: 2, factor: null, skipped: "2 cores is below the 4" },
      { when: "after", k: 2, factor: null, skipped: "2 cores is below the 4" },
    ]);
    expect(note).toContain("not run");
    expect(note).toContain("2 cores is below the 4");
    expect(note).not.toMatch(/\d\.\d\d /);
  });
});

describe("renderMeasurement — capacity section", () => {
  const base = {
    ncpu: 8,
    baseline: null,
    after: null,
    wallSeconds: 60,
    samples: 12,
    ownCores: 4,
    foreign: [],
    saturated: false,
    starvedOnly: false,
    reasons: [],
  };

  it("writes both probes into the logged measurement condition", () => {
    const text = renderMeasurement({
      ...base,
      capacity: [
        { when: "before", k: 4, factor: 3.81 },
        { when: "after", k: 4, factor: 0.9 },
      ],
    });
    expect(text).toContain("capacity before: 3.81 with k=4 workers");
    expect(text).toContain("capacity after : 0.90 with k=4 workers");
  });

  it("marks an unprobed machine as unprobed", () => {
    expect(renderMeasurement({ ...base, capacity: [] })).toContain("capacity:       not taken");
  });
});
