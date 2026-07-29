import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXIT,
  ToolkitError,
  emit,
  formatJson,
  hasEmitted,
  progress,
  renderHuman,
  resetEmitState,
  type Response,
} from "../src/output.js";

function captureStdout() {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  return { chunks, spy };
}

const gatePhases = (names: string[]) =>
  names.map((name) => ({ name, exit: 0, durationMs: 3100, skipped: false }));

const response: Response = {
  command: "gate",
  ok: true,
  exit: EXIT.OK,
  durationMs: 84213,
  logDir: ".spec-sync/logs/2026-07-26T15-04-11Z",
  notes: [],
};

afterEach(() => {
  resetEmitState();
  vi.restoreAllMocks();
});

describe("exit codes (spec §4)", () => {
  it("pins the numeric values callers branch on", () => {
    expect(EXIT).toEqual({ OK: 0, FAILED: 1, UNPROVABLE: 2, AMBIGUOUS: 3, PRECONDITION: 4 });
  });

  it("carries the exit code and the violated field on a ToolkitError", () => {
    const error = new ToolkitError("bad", EXIT.PRECONDITION, { field: "gate.phases[0].cmd" });
    expect(error.exit).toBe(EXIT.PRECONDITION);
    expect(error.field).toBe("gate.phases[0].cmd");
  });
});

describe("stdout contract (spec §3)", () => {
  it("writes exactly one JSON object and nothing else", () => {
    const { chunks } = captureStdout();
    emit(response);
    expect(chunks).toHaveLength(1);
    const text = chunks[0] as string;
    expect(text.endsWith("\n")).toBe(true);
    expect(() => JSON.parse(text)).not.toThrow();
    expect(JSON.parse(text)).toEqual(response);
  });

  it("refuses a second write, so a command cannot break the contract", () => {
    captureStdout();
    emit(response);
    expect(() => emit({ ...response, command: "queue" })).toThrow(/exactly one JSON object/);
    expect(hasEmitted()).toBe(true);
  });

  it("keeps progress off stdout", () => {
    const { chunks } = captureStdout();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    progress("running phase lint");
    expect(chunks).toHaveLength(0);
    expect(stderr).toHaveBeenCalledWith("running phase lint\n");
  });

  it("carries the minimum fields of spec §3", () => {
    const { chunks } = captureStdout();
    emit(response);
    const parsed = JSON.parse(chunks[0] as string) as Record<string, unknown>;
    for (const key of ["command", "ok", "exit", "durationMs", "logDir", "notes"]) {
      expect(parsed).toHaveProperty(key);
    }
  });

  it("grows with the number of values, never with their size (spec §3)", () => {
    const profile = { ...response, phases: gatePhases(["format", "lint", "typecheck", "unit"]) };
    const lines = (note: string) => formatJson({ ...profile, notes: [note] }).split("\n").length;
    expect(lines("boom".repeat(3000))).toBe(lines("boom"));
    // Still valid JSON — the compact form is a formatting choice, not a new shape.
    expect(JSON.parse(formatJson(profile))).toMatchObject({ command: "gate", exit: 0 });
  });

  it("costs one line per phase over an envelope that does not move", () => {
    const { chunks } = captureStdout();
    const names = ["format", "lint", "typecheck", "unit", "audits", "e2e-touched"];
    emit({ ...response, phases: gatePhases(names) });
    // 6 envelope lines + braces + one line per phase. Plain JSON.stringify(…, 2)
    // would spend six lines on each phase alone.
    expect((chunks[0] as string).trimEnd().split("\n")).toHaveLength(4 + names.length + 6);
  });

  it("keeps arrays readable at one element per line", () => {
    const { chunks } = captureStdout();
    emit({ ...response, notes: ["a", "b"] });
    expect(chunks[0]).toContain('  "notes": [\n    "a",\n    "b"\n  ]');
  });
});

describe("--human rendering (spec §3)", () => {
  it("switches stdout to text while the JSON form stays the contract", () => {
    const { chunks } = captureStdout();
    emit({ ...response, phases: [{ name: "lint", exit: 0 }] }, { human: true });
    const text = chunks[0] as string;
    expect(() => JSON.parse(text)).toThrow();
    expect(text).toContain("OK  gate  exit 0");
    expect(text).toContain("logs: .spec-sync/logs/2026-07-26T15-04-11Z");
  });

  it("marks a failure and lists the notes", () => {
    const text = renderHuman({
      ...response,
      ok: false,
      exit: EXIT.UNPROVABLE,
      notes: ["aborted under foreign load"],
    });
    expect(text).toContain("FAIL  gate  exit 2");
    expect(text).toContain("note: aborted under foreign load");
  });
});
