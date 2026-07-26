import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandContext } from "../src/cli.js";
import { parseEffortTable, runDoctor, type DoctorDeps } from "../src/commands/doctor.js";
import { PINNED_NORM_SECTION } from "../src/norms.js";
import { EXIT, ToolkitError } from "../src/output.js";
import type { RunResult, Tools } from "../src/pack/exec.js";
import { introducedMarkers, ticketOfBranch } from "../src/pack/orphans.js";

/**
 * Everything `doctor` inspects is built in a temporary $HOME and a temporary
 * repo: agent definitions, the skill, the lock, the labels. The known mismatch
 * of the ADR (`docs` missing from the skill table) is reproduced artificially —
 * the real environment has been repaired, and a test that depends on a repaired
 * environment tests nothing.
 */

const AGENTS: Record<string, string> = {
  "impl-fast": "low",
  impl: "medium",
  "impl-deep": "high",
  investigate: "xhigh",
  review: "high",
  docs: "medium",
};

const effortTable = (rows: Record<string, string> = AGENTS): string =>
  [
    "| Auslöser (beobachtbar, nicht gefühlt) | Agent | effort |",
    "|---|---|---|",
    "| kein Gate-Lauf, keine offene Suche | **Worker selbst** | — |",
    ...Object.entries(rows).map(([agent, effort]) => `| Auslöser | \`${agent}\` | ${effort} |`),
  ].join("\n");

const normSection = (rows?: Record<string, string>): string =>
  ["## Worker-Loop (/spec-sync)", "", "Choreografie …", "", effortTable(rows), ""].join("\n");

interface Env {
  agents?: Record<string, string>;
  agentWithoutFrontmatter?: string;
  skillRows?: Record<string, string>;
  omitSkill?: boolean;
}

function fakeHome(env: Env = {}): string {
  const home = mkdtempSync(join(tmpdir(), "spec-sync-home-"));
  const agentsDir = join(home, ".claude", "agents");
  const skillDir = join(home, ".claude", "skills", "spec-sync");
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(skillDir, { recursive: true });

  for (const [agent, effort] of Object.entries(env.agents ?? AGENTS)) {
    const body =
      agent === env.agentWithoutFrontmatter
        ? `# ${agent}\n\nA role prompt someone forgot the frontmatter on.\n`
        : `---\nname: ${agent}\nmodel: opus\neffort: ${effort}\n---\n\n# ${agent}\n`;
    writeFileSync(join(agentsDir, `${agent}.md`), body);
  }

  if (env.omitSkill !== true) {
    writeFileSync(
      join(skillDir, "SKILL.md"),
      ["---", "name: spec-sync", "---", "", "# spec-sync", "", effortTable(env.skillRows), ""].join(
        "\n",
      ),
    );
  }
  return home;
}

interface RepoOptions {
  lockSchema?: string | null;
  paused?: boolean;
  omitConfig?: boolean;
  /** Ledger lines, written verbatim to `.spec-sync/ledger.jsonl`. */
  ledger?: unknown[];
}

const config = {
  project: "spec-sync-toolkit",
  gate: { profiles: { local: ["lint"] }, phases: [{ name: "lint", cmd: "npm run lint" }] },
  labels: { build: "spec-sync", audit: "auto-audit", bug: "type: bug", hold: "owner-hold" },
};

function fakeRepo(options: RepoOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), "spec-sync-doctor-"));
  if (options.omitConfig !== true) {
    writeFileSync(join(root, "spec-sync.config.json"), JSON.stringify(config));
  }
  if (options.lockSchema !== null) {
    writeFileSync(
      join(root, "spec.lock.json"),
      JSON.stringify({ schema: options.lockSchema ?? "spec.lock/v3", entries: [] }),
    );
  }
  if (options.paused === true) writeFileSync(join(root, ".spec-sync-pause"), "");
  if (options.ledger !== undefined) {
    mkdirSync(join(root, ".spec-sync"), { recursive: true });
    writeFileSync(
      join(root, ".spec-sync", "ledger.jsonl"),
      `${options.ledger.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
  }
  return root;
}

interface SpecFakes {
  section?: string;
  sectionFails?: boolean;
  currentHash?: string;
  labels?: string[];
  labelsFail?: boolean;
  /** Leftover checks (§7.7). Absent means: no worktrees, no branches, nothing to find. */
  git?: GitModel;
  openIssues?: number[];
}

/** Just enough git to drive the leftover checks — no repository is created. */
interface GitModel {
  worktrees?: string;
  commonDir?: string;
  branches?: string[];
  current?: string;
  /** Commits a branch has that `main` does not. */
  ahead?: Record<string, number>;
  /** `git diff main...<branch>` output per branch. */
  diffs?: Record<string, string>;
  /** Markers that `git grep` finds on `main`. */
  onMain?: string[];
  noMain?: boolean;
}

function fakeTools(fakes: SpecFakes = {}): Tools {
  const ok = (stdout: string): RunResult => ({ ok: true, code: 0, stdout, stderr: "" });
  const fail = (stderr = ""): RunResult => ({ ok: false, code: 1, stdout: "", stderr });
  const git = fakes.git ?? {};

  return {
    run(file, args) {
      if (file === "git") {
        const [command] = args;
        if (command === "worktree") return ok(git.worktrees ?? "");
        if (command === "rev-parse" && args[1] === "--path-format=absolute") {
          return git.commonDir === undefined ? fail() : ok(`${git.commonDir}\n`);
        }
        if (command === "rev-parse") return git.noMain === true ? fail() : ok("");
        if (command === "for-each-ref") return ok((git.branches ?? []).join("\n"));
        if (command === "branch") return ok(`${git.current ?? ""}\n`);
        if (command === "rev-list") {
          const branch = (args[2] ?? "").split("..")[1] ?? "";
          return ok(`${git.ahead?.[branch] ?? 0}\n`);
        }
        if (command === "diff") {
          const branch = (args[1] ?? "").split("...")[1] ?? "";
          return ok(git.diffs?.[branch] ?? "");
        }
        if (command === "grep") {
          // git grep -q -F -- <marker> main
          const marker = args[4] ?? "";
          return (git.onMain ?? []).includes(marker) ? ok("") : fail();
        }
        throw new Error(`unexpected git call: ${args.join(" ")}`);
      }

      expect(file).toBe("gh");
      if (args[0] === "issue") {
        if (fakes.labelsFail === true) return fail("no default remote repository");
        return ok(JSON.stringify((fakes.openIssues ?? []).map((number) => ({ number }))));
      }
      expect(args[0]).toBe("label");
      if (fakes.labelsFail === true) {
        return { ok: false, code: 1, stdout: "", stderr: "no default remote repository" };
      }
      const labels = fakes.labels ?? Object.values(config.labels);
      return ok(JSON.stringify(labels.map((name) => ({ name }))));
    },
    async spec<T>(tool: string, args: Record<string, unknown>): Promise<T> {
      if (tool === "get_section") {
        if (fakes.sectionFails === true)
          throw new Error("spec-mcp unreachable at http://localhost:8787");
        expect(args.id).toBe(PINNED_NORM_SECTION.unit);
        return { content: fakes.section ?? normSection() } as T;
      }
      if (tool === "get_manifest") {
        return {
          snapshot: {
            entries: [
              {
                id: PINNED_NORM_SECTION.unit,
                version: PINNED_NORM_SECTION.version,
                sections: {
                  [PINNED_NORM_SECTION.section]: fakes.currentHash ?? PINNED_NORM_SECTION.hash,
                },
              },
            ],
          },
        } as T;
      }
      throw new Error(`unexpected spec tool: ${tool}`);
    },
  };
}

function context(root: string): CommandContext {
  return { flags: { human: false, dryRun: false }, args: [], repoRoot: root, config: undefined };
}

function deps(home: string, tools: Tools): DoctorDeps {
  return { home, tools };
}

const findingsOf = (data: Record<string, unknown> | undefined): string[] =>
  (data?.findings ?? []) as string[];

describe("doctor (spec §7.7)", () => {
  it("passes a sound environment with exit 0 and no findings", async () => {
    const result = await runDoctor(context(fakeRepo()), deps(fakeHome(), fakeTools()));
    expect(findingsOf(result.data)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.exit).toBe(EXIT.OK);
    expect(result.logDir).toBeUndefined();
  });

  it("catches a table mismatch between the skill and the spec", async () => {
    const withoutDocs = { ...AGENTS };
    delete withoutDocs.docs;

    const result = await runDoctor(
      context(fakeRepo()),
      deps(fakeHome({ skillRows: withoutDocs }), fakeTools()),
    );

    expect(result.exit).toBe(EXIT.FAILED);
    expect(findingsOf(result.data)).toContain(
      "skill-table: docs is in the spec table, not in the skill",
    );
  });

  it("catches an effort that drifted between the tables", async () => {
    const result = await runDoctor(
      context(fakeRepo()),
      deps(fakeHome({ skillRows: { ...AGENTS, investigate: "high" } }), fakeTools()),
    );
    expect(findingsOf(result.data)).toContain(
      "skill-table: investigate: high in the skill, xhigh in the spec",
    );
  });

  it("catches an agent type the skill invented", async () => {
    const result = await runDoctor(
      context(fakeRepo()),
      deps(fakeHome({ skillRows: { ...AGENTS, refactor: "medium" } }), fakeTools()),
    );
    expect(findingsOf(result.data)).toContain(
      "skill-table: refactor is in the skill table, not in the spec",
    );
  });

  it("treats a definition without frontmatter as no agent type at all", async () => {
    const result = await runDoctor(
      context(fakeRepo()),
      deps(fakeHome({ agentWithoutFrontmatter: "review" }), fakeTools()),
    );
    expect(findingsOf(result.data).join(" ")).toContain(
      "review: ~/.claude/agents/review.md has no frontmatter",
    );
  });

  it("reports a missing agent definition and an effort that contradicts the spec", async () => {
    const withoutDocs = { ...AGENTS };
    delete withoutDocs.docs;

    const result = await runDoctor(
      context(fakeRepo()),
      deps(fakeHome({ agents: { ...withoutDocs, impl: "low" } }), fakeTools()),
    );
    const findings = findingsOf(result.data).join(" ");
    expect(findings).toContain("docs: no ~/.claude/agents/docs.md");
    expect(findings).toContain("impl: effort low in the definition, medium in the spec");
  });

  it("reports labels the repo does not know", async () => {
    const result = await runDoctor(
      context(fakeRepo()),
      deps(fakeHome(), fakeTools({ labels: ["spec-sync", "auto-audit"] })),
    );
    const findings = findingsOf(result.data).join(" ");
    expect(findings).toContain('bug label "type: bug" does not exist here');
    expect(findings).toContain('hold label "owner-hold" does not exist here');
  });

  it("reports a missing lock, an old schema and the pause flag", async () => {
    const missing = await runDoctor(
      context(fakeRepo({ lockSchema: null })),
      deps(fakeHome(), fakeTools()),
    );
    expect(findingsOf(missing.data).join(" ")).toContain("lock: no spec.lock.json");

    const old = await runDoctor(
      context(fakeRepo({ lockSchema: "spec.lock/v2", paused: true })),
      deps(fakeHome(), fakeTools()),
    );
    const findings = findingsOf(old.data).join(" ");
    expect(findings).toContain("spec.lock.json is spec.lock/v2, not spec.lock/v3");
    expect(findings).toContain(".spec-sync-pause exists");
  });

  it("reports a moved norm hash instead of adjusting the defaults", async () => {
    const result = await runDoctor(
      context(fakeRepo()),
      deps(fakeHome(), fakeTools({ currentHash: "a".repeat(64) })),
    );
    expect(findingsOf(result.data).join(" ")).toContain("§Worker-Loop moved to aaaaaaaaaaaa…");
  });

  it("reports an unreachable spec server and skips what depends on it", async () => {
    const result = await runDoctor(
      context(fakeRepo()),
      deps(fakeHome(), fakeTools({ sectionFails: true })),
    );
    const findings = findingsOf(result.data).join(" ");
    expect(findings).toContain("spec-mcp: spec-mcp unreachable");
    expect(findings).not.toContain("agent-type");
    expect(result.notes?.join(" ")).toContain("were skipped");
  });

  it("writes the full report to the log directory and returns its path (spec §3)", async () => {
    const root = fakeRepo({ paused: true });
    const result = await runDoctor(context(root), deps(fakeHome(), fakeTools()));

    expect(result.logDir).toMatch(/^\.spec-sync\/logs\//u);
    const report = readFileSync(join(root, result.logDir as string, "doctor.log"), "utf8");
    expect(report).toContain("[pause] .spec-sync-pause exists");
  });

  it("reports a missing config instead of failing on it", async () => {
    const result = await runDoctor(
      context(fakeRepo({ omitConfig: true })),
      deps(fakeHome(), fakeTools()),
    );
    expect(findingsOf(result.data).join(" ")).toContain("config: config not found");
  });
});

/**
 * Leftovers of aborted runs. The interesting case is the one the spec calls out:
 * under squash merges a landed branch still looks unmerged to git, so the
 * verdict has to come from content, never from ancestry.
 */
describe("doctor — leftovers of aborted runs (spec §7.7)", () => {
  /** A worktree on disk with a controllable age. */
  function worktreeAged(days: number): string {
    const path = mkdtempSync(join(tmpdir(), "spec-sync-wt-"));
    const gitFile = join(path, ".git");
    writeFileSync(gitFile, "gitdir: /elsewhere\n");
    const when = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    utimesSync(gitFile, when, when);
    return path;
  }

  const porcelain = (entries: { path: string; branch?: string }[]): string =>
    entries
      .map(
        (entry) =>
          `worktree ${entry.path}\nHEAD abc123\n${entry.branch === undefined ? "detached" : `branch refs/heads/${entry.branch}`}\n`,
      )
      .join("\n");

  const addedLine = (code: string): string => `diff --git a/x.ts b/x.ts\n+++ b/x.ts\n+${code}\n`;

  it("reports a worktree that has been lying around for days", async () => {
    const stale = worktreeAged(3);
    const result = await runDoctor(
      context(fakeRepo()),
      deps(
        fakeHome(),
        fakeTools({ git: { worktrees: porcelain([{ path: stale, branch: "142-x" }]) } }),
      ),
    );
    expect(findingsOf(result.data).join(" ")).toContain(`orphan-worktree: ${stale} (3d old`);
  });

  it("reports a fresh worktree whose ticket is already closed", async () => {
    const fresh = worktreeAged(0);
    const result = await runDoctor(
      context(fakeRepo()),
      deps(
        fakeHome(),
        fakeTools({
          openIssues: [999],
          git: { worktrees: porcelain([{ path: fresh, branch: "feat/142-x" }]) },
        }),
      ),
    );
    expect(findingsOf(result.data).join(" ")).toContain("ticket #142 is closed");
  });

  it("leaves the main checkout and the worktree it runs in alone", async () => {
    const root = fakeRepo();
    const mainCheckout = worktreeAged(90);
    const result = await runDoctor(
      context(root),
      deps(
        fakeHome(),
        fakeTools({
          git: {
            commonDir: join(mainCheckout, ".git"),
            worktrees: porcelain([
              { path: mainCheckout, branch: "main" },
              { path: root, branch: "m4-pack" },
            ]),
          },
        }),
      ),
    );
    expect(findingsOf(result.data)).toEqual([]);
  });

  it("summarises branches whose ticket is closed instead of listing 250 of them", async () => {
    const result = await runDoctor(
      context(fakeRepo()),
      deps(
        fakeHome(),
        fakeTools({
          openIssues: [500],
          git: {
            current: "main",
            branches: ["main", "chore/304-seed", "feat/311-ci", "fix/313-preview"],
          },
        }),
      ),
    );
    const findings = findingsOf(result.data).join(" ");
    expect(findings).toContain("orphan-branch: 3 branch(es) whose ticket is closed");
    expect(findings).toContain("chore/304-seed (#304)");
  });

  it("reports a branch whose introduced work never landed on main", async () => {
    const result = await runDoctor(
      context(fakeRepo()),
      deps(
        fakeHome(),
        fakeTools({
          openIssues: [142],
          git: {
            current: "main",
            branches: ["main", "feat/142-visual-regression"],
            ahead: { "feat/142-visual-regression": 4 },
            diffs: {
              "feat/142-visual-regression":
                addedLine("export function compareScreenshots(a: Buffer, b: Buffer) {") +
                addedLine('it("flags a changed hero image", async () => {'),
            },
            onMain: [],
          },
        }),
      ),
    );
    const findings = findingsOf(result.data).join(" ");
    expect(findings).toContain("unlanded-work: feat/142-visual-regression (#142 open)");
    expect(findings).toContain("2 of 2 introduced markers are absent from main");
  });

  it("stays silent for a squash-merged branch whose content did land", async () => {
    const result = await runDoctor(
      context(fakeRepo()),
      deps(
        fakeHome(),
        fakeTools({
          openIssues: [142],
          git: {
            current: "main",
            // Own commits against main — ancestry alone would call this unmerged.
            branches: ["main", "feat/142-done"],
            ahead: { "feat/142-done": 4 },
            diffs: {
              "feat/142-done": addedLine("export function compareScreenshots(a: Buffer) {"),
            },
            onMain: ["compareScreenshots"],
          },
        }),
      ),
    );
    expect(findingsOf(result.data)).toEqual([]);
  });

  it("judges no branch at all when gh cannot say which tickets are open", async () => {
    const result = await runDoctor(
      context(fakeRepo()),
      deps(
        fakeHome(),
        fakeTools({ labelsFail: true, git: { current: "main", branches: ["main", "feat/142-x"] } }),
      ),
    );
    expect(findingsOf(result.data).join(" ")).not.toContain("orphan-branch");
    expect(result.notes?.join(" ")).toContain("open tickets unknown");
  });

  it("reports a merge that started and never completed", async () => {
    const result = await runDoctor(
      context(
        fakeRepo({
          ledger: [
            { at: "2026-07-26T10:00:00.000Z", type: "merge-started", issue: 142 },
            { at: "2026-07-26T10:00:01.000Z", type: "gate", issue: 142, ok: true },
          ],
        }),
      ),
      deps(fakeHome(), fakeTools()),
    );
    expect(findingsOf(result.data).join(" ")).toContain(
      "merge-incomplete: #142: merge-started at 2026-07-26T10:00:00.000Z without merge-completed",
    );
  });

  it("stays silent once the merge completed", async () => {
    const result = await runDoctor(
      context(
        fakeRepo({
          ledger: [
            { at: "2026-07-26T10:00:00.000Z", type: "merge-started", issue: 142 },
            { at: "2026-07-26T10:05:00.000Z", type: "merge-completed", issue: 142 },
          ],
        }),
      ),
      deps(fakeHome(), fakeTools()),
    );
    expect(findingsOf(result.data)).toEqual([]);
  });

  it("puts the full lists in the log and only the summary in the response", async () => {
    const root = fakeRepo();
    const result = await runDoctor(
      context(root),
      deps(
        fakeHome(),
        fakeTools({
          openIssues: [],
          git: { current: "main", branches: ["main", "chore/304-a", "spike/no-ticket"] },
        }),
      ),
    );
    const report = readFileSync(join(root, result.logDir as string, "doctor.log"), "utf8");
    expect(report).toContain("branches of closed tickets:");
    expect(report).toContain("spike/no-ticket");
    expect(result.notes?.join(" ")).toContain("1 branch(es) carry no ticket number");
  });
});

describe("ticketOfBranch", () => {
  it("reads the number only where a ticket number belongs", () => {
    expect(ticketOfBranch("chore/304-remove-seed-prefix")).toBe(304);
    expect(ticketOfBranch("142-fix")).toBe(142);
    expect(ticketOfBranch("feat/589")).toBe(589);
  });

  it("does not read a trailing number as a ticket", () => {
    expect(ticketOfBranch("chore/spec-lock-2451")).toBeUndefined();
    expect(ticketOfBranch("main")).toBeUndefined();
    expect(ticketOfBranch("release/v2")).toBeUndefined();
  });
});

describe("introducedMarkers", () => {
  it("takes test titles and declared symbols from added lines only", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "+++ b/a.ts",
      "+export function compareScreenshots(a: Buffer) {",
      '+  it("flags a changed hero image", () => {',
      "-export function removedOne() {",
      " const untouched = 1;",
    ].join("\n");
    expect(introducedMarkers(diff)).toEqual(["compareScreenshots", "flags a changed hero image"]);
  });

  it("finds nothing in a diff that introduces no symbol", () => {
    expect(introducedMarkers("+++ b/README.md\n+Ein Satz Prosa.\n")).toEqual([]);
  });
});

describe("doctor — options", () => {
  it("rejects an unknown option with exit 4 and names the field", async () => {
    try {
      await runDoctor(
        { ...context(fakeRepo()), args: ["--verbose"] },
        deps(fakeHome(), fakeTools()),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ToolkitError);
      expect((error as ToolkitError).exit).toBe(EXIT.PRECONDITION);
      expect((error as ToolkitError).field).toBe("--verbose");
      return;
    }
    throw new Error("expected the call to throw");
  });
});

describe("parseEffortTable", () => {
  it("reads the agent/effort pairs and ignores the row that names no agent", () => {
    expect(parseEffortTable(normSection())).toEqual([
      { agent: "impl-fast", effort: "low" },
      { agent: "impl", effort: "medium" },
      { agent: "impl-deep", effort: "high" },
      { agent: "investigate", effort: "xhigh" },
      { agent: "review", effort: "high" },
      { agent: "docs", effort: "medium" },
    ]);
  });

  it("takes the agent from the agent cell, not from the trigger cell", () => {
    const table = [
      "| Auslöser | Agent | effort |",
      "|---|---|---|",
      "| Merge-Review, eine Lens je Spawn (`acceptance`/`security`) | `review` | high |",
    ].join("\n");
    expect(parseEffortTable(table)).toEqual([{ agent: "review", effort: "high" }]);
  });

  it("finds no table in a document that has none", () => {
    expect(parseEffortTable("# Nur Prosa\n\nKeine Tabelle.\n")).toEqual([]);
  });
});
