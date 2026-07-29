import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_FILENAME, loadConfig, phasesOfProfile } from "../src/config.js";
import { DEFAULT_LOG_RETENTION } from "../src/logs.js";
import { DEFAULT_CONTEXT_BUDGET } from "../src/budget.js";
import { EXIT, ToolkitError } from "../src/output.js";

const valid = {
  project: "community-platform",
  gate: {
    profiles: { local: ["lint", "unit"], merge: ["lint", "unit", "e2e-touched"] },
    phases: [
      { name: "lint", cmd: "npm run lint" },
      { name: "unit", cmd: "npm test" },
      { name: "e2e-touched", cmd: "npm run test:e2e:feature", when: ["client/**"] },
    ],
  },
};

function repoWith(config: unknown, name = CONFIG_FILENAME): string {
  const root = mkdtempSync(join(tmpdir(), "spec-sync-config-"));
  writeFileSync(join(root, name), typeof config === "string" ? config : JSON.stringify(config));
  return root;
}

function expectPrecondition(fn: () => unknown): ToolkitError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ToolkitError);
    const toolkitError = error as ToolkitError;
    expect(toolkitError.exit).toBe(EXIT.PRECONDITION);
    return toolkitError;
  }
  throw new Error("expected the call to throw");
}

describe("loadConfig (spec §5)", () => {
  it("accepts the documented shape and defaults the optional blocks", () => {
    const config = loadConfig(repoWith(valid));
    expect(config.project).toBe("community-platform");
    expect(config.gate.phases[2]?.when).toEqual(["client/**"]);
    // Labels fall back to the foundation norms (spec §6) instead of being required.
    expect(config.labels).toEqual({
      build: "spec-sync",
      audit: "auto-audit",
      bug: "type: bug",
      hold: "owner-hold",
      started: "status: in-progress",
    });
    expect(config.lenses).toEqual({});
  });

  it("defaults logRetention to 20 when the config does not name it", () => {
    expect(loadConfig(repoWith(valid)).logRetention).toBe(DEFAULT_LOG_RETENTION);
    expect(DEFAULT_LOG_RETENTION).toBe(20);
  });

  it("takes a logRetention the config does name", () => {
    expect(loadConfig(repoWith({ ...valid, logRetention: 5 })).logRetention).toBe(5);
  });

  it("defaults contextBudget to 800000 when the config does not name it", () => {
    expect(loadConfig(repoWith(valid)).contextBudget).toBe(DEFAULT_CONTEXT_BUDGET);
    expect(DEFAULT_CONTEXT_BUDGET).toBe(800_000);
  });

  it("takes a contextBudget the config does name", () => {
    expect(loadConfig(repoWith({ ...valid, contextBudget: 500_000 })).contextBudget).toBe(500_000);
  });

  it("reads a config from an explicit --config path", () => {
    const root = repoWith(valid, "other.json");
    expect(loadConfig(root, "other.json").project).toBe("community-platform");
  });

  it("keeps the phase order of the profile as configured", () => {
    const config = loadConfig(repoWith(valid));
    expect(phasesOfProfile(config, "merge").map((phase) => phase.name)).toEqual([
      "lint",
      "unit",
      "e2e-touched",
    ]);
  });
});

describe("invalid config → exit 4 naming the field (spec §5)", () => {
  it("reports a missing file", () => {
    const root = mkdtempSync(join(tmpdir(), "spec-sync-empty-"));
    const error = expectPrecondition(() => loadConfig(root));
    expect(error.field).toBe(CONFIG_FILENAME);
    expect(error.message).toContain("config not found");
  });

  it("reports broken JSON", () => {
    const error = expectPrecondition(() => loadConfig(repoWith("{ nope")));
    expect(error.field).toBe(CONFIG_FILENAME);
    expect(error.message).toContain("not valid JSON");
  });

  it("names a missing top-level field", () => {
    const { project: _project, ...withoutProject } = valid;
    const error = expectPrecondition(() => loadConfig(repoWith(withoutProject)));
    expect(error.field).toBe("project");
  });

  it("names a nested field with its array index", () => {
    const broken = {
      ...valid,
      gate: { ...valid.gate, phases: [{ name: "lint", cmd: "npm run lint" }, { name: "unit" }] },
    };
    const error = expectPrecondition(() => loadConfig(repoWith(broken)));
    expect(error.field).toBe("gate.phases[1].cmd");
    expect(error.message).toContain("gate.phases[1].cmd");
  });

  it("names a wrong type", () => {
    const broken = { ...valid, project: 42 };
    const error = expectPrecondition(() => loadConfig(repoWith(broken)));
    expect(error.field).toBe("project");
  });

  it("names a profile entry that no phase defines", () => {
    const broken = {
      ...valid,
      gate: { ...valid.gate, profiles: { local: ["lint", "typecheck"] } },
    };
    const error = expectPrecondition(() => loadConfig(repoWith(broken)));
    expect(error.field).toBe("gate.profiles.local[1]");
    expect(error.message).toContain('unknown phase "typecheck"');
  });

  it.each([
    ["zero", 0],
    ["negative", -3],
    ["fractional", 2.5],
    ["a string", "20"],
  ])("names logRetention when it is %s", (_label, logRetention) => {
    const error = expectPrecondition(() => loadConfig(repoWith({ ...valid, logRetention })));
    expect(error.field).toBe("logRetention");
    expect(error.message).toContain("logRetention");
  });

  it("rejects an unknown profile at use time", () => {
    const config = loadConfig(repoWith(valid));
    const error = expectPrecondition(() => phasesOfProfile(config, "nightly"));
    expect(error.field).toBe("gate.profiles.nightly");
  });
});

describe("the shipped example config", () => {
  it("validates against the schema", () => {
    const config = loadConfig(process.cwd(), "spec-sync.config.json.example");
    expect(config.project).toBe("community-platform");
    expect(Object.keys(config.gate.profiles)).toEqual(["local", "merge", "nightly"]);
    expect(config.nightlyWorkflow).toBe("nightly.yml");
  });
});
