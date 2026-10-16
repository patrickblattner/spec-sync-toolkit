import { describe, expect, it } from "vitest";
import { loadConfig, type ReviewConfig } from "../src/config.js";
import {
  latestReviewMarker,
  parseReviewMarker,
  renderReviewComment,
  renderSkipLine,
  renderVerdictComment,
} from "../src/review/comment.js";
import { codexArgs } from "../src/review/engine.js";
import {
  assignFindings,
  dedupeKey,
  parseResult,
  partitionFindings,
  reviewKeysOf,
  type RawFinding,
} from "../src/review/findings.js";
import { PROMPT_TEMPLATE, RESULT_SCHEMA, renderPrompt } from "../src/review/prompt.js";
import {
  decide,
  decideAlways,
  newModule,
  parseNumstat,
  sizeOf,
  type NumstatEntry,
} from "../src/review/triage.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function reviewConfig(review: Record<string, unknown> = {}): ReviewConfig {
  const root = mkdtempSync(join(tmpdir(), "spec-sync-review-unit-"));
  writeFileSync(
    join(root, "spec-sync.config.json"),
    JSON.stringify({
      project: "demo",
      gate: { profiles: { local: ["lint"] }, phases: [{ name: "lint", cmd: "true" }] },
      review,
    }),
  );
  return loadConfig(root).review;
}

const files = (count: number, linesEach = 1, prefix = "src/f"): NumstatEntry[] =>
  Array.from({ length: count }, (_, i) => ({
    file: `${prefix}${i}.ts`,
    lines: linesEach,
    binary: false,
  }));

describe("review config (SST-DESIGN-030 §Config)", () => {
  it("applies the defaults when the block is absent", () => {
    const review = reviewConfig();
    expect(review.models).toEqual({ risk: "gpt-6-astra", size: "gpt-5.6-sol" });
    expect(review.size).toEqual({ files: 15, lines: 600 });
    expect(review.marker).toBe("review/last");
    expect(review.label).toBe("review-codex");
    expect(review.securityLabel).toBe("security");
    expect(review.timeoutMs).toBe(900000);
    expect(review.maxDiffBytes).toBe(400000);
    expect(review.riskGlobs).toEqual({});
  });

  it("ignores the legacy keys of the per-repo scripts", () => {
    const review = reviewConfig({
      engine: "codex",
      cmd: "codex exec --sandbox read-only",
      promptTemplate: ".spec-sync/review-prompt.md",
      batchLenses: ["acceptance"],
      uiLens: { lens: "a11y", when: ["client/**"] },
      mark: "review/last",
      timeoutMs: 600000,
      riskGlobs: { auth: ["server/auth/**"] },
    });
    expect(review.timeoutMs).toBe(600000);
    expect(review.riskGlobs).toEqual({ auth: ["server/auth/**"] });
    expect("cmd" in review).toBe(false);
  });
});

describe("triage (acceptance 1)", () => {
  const review = reviewConfig({ riskGlobs: { auth: ["server/auth/**"] }, modulesRoot: "pkg" });

  it("14 files is not triaged, 15 files is size", () => {
    expect(decide(files(14), false, review).triaged).toBe(false);
    expect(decide(files(15), false, review)).toMatchObject({
      triaged: true,
      model: "gpt-5.6-sol",
      trigger: "size",
    });
  });

  it("599 lines is not triaged, 600 lines is size", () => {
    expect(decide(files(1, 599), false, review).triaged).toBe(false);
    expect(decide(files(1, 600), false, review)).toMatchObject({ trigger: "size" });
  });

  it("risk takes precedence over size", () => {
    const entries = [...files(20, 100), { file: "server/auth/login.ts", lines: 1, binary: false }];
    expect(decide(entries, true, review)).toMatchObject({
      model: "gpt-6-astra",
      trigger: "risk:auth",
      areas: ["auth"],
    });
  });

  it("a new module triggers size even when small", () => {
    expect(decide(files(1), true, review)).toMatchObject({ trigger: "size" });
  });

  it("detects a new package and a new directory under modulesRoot", () => {
    expect(newModule(["tools/x/package.json"], undefined, new Set())).toBe(true);
    expect(newModule(["package.json"], undefined, new Set())).toBe(true);
    expect(newModule(["pkg/new/index.ts"], "pkg", new Set(["old"]))).toBe(true);
    expect(newModule(["pkg/old/more.ts"], "pkg", new Set(["old"]))).toBe(false);
    expect(newModule(["pkg/readme.ts"], "pkg", new Set())).toBe(false);
    expect(newModule(["src/a.ts"], undefined, new Set())).toBe(false);
  });

  it("binary files count as 0 lines and text files not at all", () => {
    const entries = parseNumstat(
      [
        "-\t-\tassets/logo.png",
        "700\t0\tdocs/guide.md",
        "650\t0\tlocales/de.json",
        "3\t2\tsrc/a.ts",
      ].join("\n"),
    );
    expect(entries[0]).toEqual({ file: "assets/logo.png", lines: 0, binary: true });
    expect(sizeOf(entries, ["locales/**"])).toEqual({ files: 2, lines: 5 });
    const withText = reviewConfig({ textGlobs: ["locales/**"] });
    expect(decide(entries, false, withText).triaged).toBe(false);
    // 15 Markdown files do not reach the file threshold.
    expect(
      decide(
        files(15, 1, "docs/page").map((e) => ({ ...e, file: `${e.file}.md` })),
        false,
        review,
      ).triaged,
    ).toBe(false);
  });

  it("batch and tag always pick a model", () => {
    expect(decideAlways(["src/a.ts"], review)).toEqual({
      model: "gpt-5.6-sol",
      trigger: "size",
      areas: [],
    });
    expect(decideAlways(["server/auth/a.ts"], review)).toMatchObject({ model: "gpt-6-astra" });
  });
});

const finding = (over: Partial<RawFinding> = {}): RawFinding => ({
  area: "code",
  severity: "high",
  file: "src/a.ts",
  line: 3,
  claim: "Adds instead of subtracting",
  scenario: "sub(5, 3) returns 8",
  evidence: "line 3 uses +",
  fix: "use -",
  ...over,
});

describe("strict parse, downgrade, ids (acceptance 2)", () => {
  it("accepts the schema shape and one code fence", () => {
    const raw = JSON.stringify({ findings: [finding()], recheck: [] });
    expect(parseResult(raw)).toMatchObject({ ok: true, findings: [finding()] });
    expect(parseResult("```json\n" + raw + "\n```")).toMatchObject({ ok: true });
    expect(parseResult('{"findings":[],"recheck":[]}')).toEqual({
      ok: true,
      findings: [],
      recheck: [],
    });
  });

  it.each([
    ["", "empty output"],
    ["prose before {}", "not valid JSON"],
    ["[]", "root is not an object"],
    ['{"findings":[]}', "`recheck` is not an array"],
    ['{"findings":[],"recheck":[],"extra":1}', "unknown root field extra"],
    [
      JSON.stringify({ findings: [finding({ severity: "major" as never })], recheck: [] }),
      "unknown severity",
    ],
    [
      JSON.stringify({ findings: [finding({ area: "style" as never })], recheck: [] }),
      "unknown area",
    ],
    [JSON.stringify({ findings: [finding({ line: 1.5 })], recheck: [] }), "`line`"],
    [
      JSON.stringify({ findings: [finding({ evidence: " " })], recheck: [] }),
      "`evidence` is empty",
    ],
    [
      JSON.stringify({ findings: [{ ...finding(), extra: "x" }], recheck: [] }),
      "unknown field extra",
    ],
    [
      JSON.stringify({ findings: [], recheck: [{ id: "CX1", resolved: "yes", note: "" }] }),
      "`resolved`",
    ],
  ])("rejects %j", (raw, reason) => {
    const result = parseResult(raw);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain(reason);
  });

  it("assigns CX ids and downgrades critical/high without line or scenario", () => {
    const { findings, downgraded } = assignFindings([
      finding(),
      finding({ severity: "critical", line: 0 }),
      finding({ severity: "high", scenario: "" }),
      finding({ severity: "low", line: 0, scenario: "" }),
    ]);
    expect(findings.map((f) => `${f.id}:${f.severity}`)).toEqual([
      "CX1:high",
      "CX2:medium",
      "CX3:medium",
      "CX4:low",
    ]);
    expect(downgraded).toEqual(["CX2", "CX3"]);
    expect(assignFindings([finding()], 5).findings[0]?.id).toBe("CX5");
  });

  it("dedupes by file and normalised claim, also within one run", () => {
    const a = finding({ claim: "Adds  instead\nof subtracting" });
    const key = dedupeKey(finding());
    expect(dedupeKey(a)).toBe(key);
    expect(reviewKeysOf([`body\n<!-- review-key: ${key} -->`])).toEqual([key]);
    const other = finding({ claim: "Something else" });
    const parts = partitionFindings([a, other, other], [key]);
    expect(parts.fresh).toEqual([other]);
    expect(parts.duplicates).toHaveLength(2);
    expect(dedupeKey(finding({ claim: "a --> b" }))).not.toContain("-->");
  });
});

describe("prompt, schema, engine arguments", () => {
  it("fills every placeholder once", () => {
    for (const key of ["REPO", "MODE", "RANGE", "AREAS", "FILES", "DIFF", "PRIOR"]) {
      expect(PROMPT_TEMPLATE).toContain(`{{${key}}}`);
    }
    const prompt = renderPrompt({
      REPO: "demo",
      MODE: "pr",
      RANGE: "a...b",
      AREAS: "none",
      FILES: "x.ts",
      DIFF: "+ {{PRIOR}}",
      PRIOR: "none",
    });
    expect(prompt).not.toMatch(/\{\{(REPO|MODE|RANGE|AREAS|FILES|DIFF)\}\}/);
    expect(prompt).toContain("+ {{PRIOR}}");
  });

  it("schema requires every field", () => {
    expect(RESULT_SCHEMA.required).toEqual(["findings", "recheck"]);
    expect(RESULT_SCHEMA.properties.findings.items.required).toHaveLength(8);
  });

  it("hard-codes the read-only sandbox, the model and stdin", () => {
    expect(codexArgs("gpt-5.6-sol", "s.json", "o.json", "/r")).toEqual([
      "exec",
      "--sandbox",
      "read-only",
      "-m",
      "gpt-5.6-sol",
      "--ephemeral",
      "--output-schema",
      "s.json",
      "-o",
      "o.json",
      "-C",
      "/r",
      "-",
    ]);
  });
});

describe("comment markers (acceptance 4)", () => {
  it("round-trips the review marker, even with a claim that would close the comment", () => {
    const { findings } = assignFindings([finding({ claim: "x --> y <b>" })]);
    const body = renderReviewComment({
      pr: 7,
      head: "abc",
      model: "gpt-6-astra",
      trigger: "risk:auth",
      round: 1,
      range: "origin/main...HEAD",
      files: 1,
      lines: 2,
      durationMs: 1234,
      findings,
      downgraded: [],
    });
    expect(body.split("-->")[0]).toContain("spec-sync-review");
    expect(body).toContain("Codex review · gpt-6-astra · risk:auth");
    const marker = parseReviewMarker(body);
    expect(marker).toMatchObject({ v: 1, pr: 7, head: "abc", model: "gpt-6-astra", round: 1 });
    expect(marker?.findings[0]).toMatchObject({ id: "CX1", claim: "x --> y <b>" });
    expect(latestReviewMarker(["plain", body, renderSkipLine("limit", "m")])?.model).toBe(
      "gpt-6-astra",
    );
  });

  it("renders the skip line exactly", () => {
    expect(renderSkipLine("timeout", "gpt-5.6-sol")).toBe(
      "Codex review skipped — timeout (gpt-5.6-sol). No Claude fallback; nightly batch catches up.\n",
    );
  });

  it("renders a verdict marker", () => {
    const body = renderVerdictComment({
      target: "pr",
      number: 4,
      finding: "CX2",
      source: "claude:security",
      verdict: { verdict: "rejected", reason: "guarded upstream" },
    });
    expect(body).toMatch(/^<!-- review-verdict \{.*"verdict":"rejected".*\} -->/);
    expect(body).toContain("claude:security");
  });
});
