import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandContext } from "../src/cli.js";
import {
  defaultNpmCache,
  npxSpecSyncLines,
  prePushSources,
  runDoctor,
  type DoctorDeps,
} from "../src/commands/doctor.js";
import { EXIT, ToolkitError } from "../src/output.js";
import type { RunResult, Tools } from "../src/pack/exec.js";
import { introducedMarkers, ticketOfBranch } from "../src/pack/orphans.js";

/**
 * Everything `doctor` inspects is built in a temporary repo and a temporary npm
 * cache. The fake tools answer git and `gh issue list` only — a spec-server or
 * label call fails the test (SST-DESIGN-022 rev 5 asks neither).
 */

interface RepoOptions {
  /** `null` omits the file; a string writes it verbatim (to simulate invalid JSON). */
  pins?: Record<string, number> | string | null;
  paused?: boolean;
  omitConfig?: boolean;
  /** Ledger lines, written verbatim to `.spec-sync/ledger.jsonl`. */
  ledger?: unknown[];
  /** The `review` block of the config (SST-DESIGN-030). */
  review?: unknown;
  /** Files written to `.github/workflows/`. */
  workflows?: string[];
  /** Extra repo files, path → content (hooks, `.gitattributes`, `package.json`). */
  files?: Record<string, string>;
  /** `gate.profiles` override. */
  profiles?: Record<string, string[]>;
  /** Top-level `phase` of the config (PROC-REL-009); omitted when undefined. */
  phase?: string;
}

const config = {
  project: "spec-sync-toolkit",
  gate: { profiles: { local: ["lint"] }, phases: [{ name: "lint", cmd: "npm run lint" }] },
  labels: {
    build: "spec-sync",
    audit: "auto-audit",
    bug: "type: bug",
    hold: "owner-hold",
    started: "status: in-progress",
    blocked: "blocked",
  },
  review: { riskGlobs: { auth: ["server/auth/**"] } },
};

function fakeRepo(options: RepoOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), "spec-sync-doctor-"));
  if (options.omitConfig !== true) {
    writeFileSync(
      join(root, "spec-sync.config.json"),
      JSON.stringify({
        ...config,
        ...(options.profiles === undefined
          ? {}
          : {
              gate: {
                profiles: options.profiles,
                phases: [...new Set(["lint", ...Object.values(options.profiles).flat()])].map(
                  (name) => ({ name, cmd: `npm run ${name}` }),
                ),
              },
            }),
        ...(options.review === undefined ? {} : { review: options.review }),
        ...(options.phase === undefined ? {} : { phase: options.phase }),
      }),
    );
  }
  if (options.workflows !== undefined) {
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    for (const file of options.workflows)
      writeFileSync(join(root, ".github", "workflows", file), "");
  }
  if (options.pins !== null) {
    const content =
      typeof options.pins === "string"
        ? options.pins
        : JSON.stringify(options.pins ?? { "GL-SEC-001": 3 });
    writeFileSync(join(root, "spec-pins.json"), content);
  }
  if (options.paused === true) writeFileSync(join(root, ".spec-sync-pause"), "");
  for (const [file, content] of Object.entries(options.files ?? {})) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
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
  ghFails?: boolean;
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
  /** `git ls-files` output for the review-glob check. */
  lsFiles?: string[];
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
        if (command === "ls-files") {
          return ok((git.lsFiles ?? ["server/auth/login.ts"]).join("\n"));
        }
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
      expect(args[0]).toBe("issue");
      if (fakes.ghFails === true) return fail("no default remote repository");
      return ok(JSON.stringify((fakes.openIssues ?? []).map((number) => ({ number }))));
    },
    async spec(tool: string): Promise<string> {
      throw new Error(`unexpected spec tool: ${tool}`);
    },
  };
}

function context(root: string): CommandContext {
  return { flags: { human: false, dryRun: false }, args: [], repoRoot: root, config: undefined };
}

/** An empty npm cache, so no test reads the real `~/.npm/_npx`. */
const emptyNpmCache = (): string => mkdtempSync(join(tmpdir(), "spec-sync-npm-"));

function deps(tools: Tools, npmCache = emptyNpmCache()): DoctorDeps {
  return { tools, npmCache };
}

const findingsOf = (data: Record<string, unknown> | undefined): string[] =>
  (data?.findings ?? []) as string[];

describe("doctor (spec §7.7)", () => {
  it("passes a sound environment with exit 0 and no findings", async () => {
    const result = await runDoctor(context(fakeRepo()), deps(fakeTools()));
    expect(findingsOf(result.data)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.exit).toBe(EXIT.OK);
    expect(result.logDir).toBeUndefined();
  });

  it("leaves a repo without pins alone (SST-DESIGN-025 rev 6), reports invalid pins and the pause flag", async () => {
    const missing = await runDoctor(context(fakeRepo({ pins: null })), deps(fakeTools()));
    expect(findingsOf(missing.data)).toEqual([]);
    expect(missing.exit).toBe(EXIT.OK);

    const invalid = await runDoctor(
      context(fakeRepo({ pins: "not json", paused: true })),
      deps(fakeTools()),
    );
    const findings = findingsOf(invalid.data).join(" ");
    expect(findings).toContain("spec-pins.json is not a valid {key: rev} map");
    expect(findings).toContain(".spec-sync-pause exists");
  });

  it("writes the full report to the log directory and returns its path (spec §3)", async () => {
    const root = fakeRepo({ paused: true });
    const result = await runDoctor(context(root), deps(fakeTools()));

    expect(result.logDir).toMatch(/^\.spec-sync\/logs\//u);
    const report = readFileSync(join(root, result.logDir as string, "doctor.log"), "utf8");
    expect(report).toContain("[pause] .spec-sync-pause exists");
  });

  it("checks nothing beyond its four checks and the leftovers (SST-DESIGN-022 rev 6)", async () => {
    // Everything the former checks reported: workflows without nightlyWorkflow,
    // no pre-push hook, no unit-static phase, a legacy review key, an unfinished
    // merge in the ledger. The fake tools fail on any spec-server or label call.
    const root = fakeRepo({
      workflows: ["ci.yml"],
      profiles: { local: ["lint"], merge: ["lint"] },
      review: { cmd: "codex exec", riskGlobs: { auth: ["server/auth/**"] } },
      ledger: [{ at: "2026-07-26T10:00:00.000Z", type: "merge-started", issue: 142 }],
    });
    const result = await runDoctor(context(root), deps(fakeTools()));
    expect(findingsOf(result.data)).toEqual([]);
    expect(result.data).toEqual({ findings: [] });
    expect(result.exit).toBe(EXIT.OK);
  });
});

describe("doctor — review.riskGlobs (SST-DESIGN-022 rev 6)", () => {
  const run = (root: string, lsFiles?: string[]) =>
    runDoctor(context(root), deps(fakeTools(lsFiles === undefined ? {} : { git: { lsFiles } })));

  it("is silent for a list whose every glob matches a tracked file", async () => {
    const result = await run(fakeRepo());
    expect(findingsOf(result.data)).toEqual([]);
    expect(result.exit).toBe(EXIT.OK);
  });

  it("reports a missing config as the same finding", async () => {
    const result = await run(fakeRepo({ omitConfig: true }));
    expect(findingsOf(result.data)).toEqual([
      expect.stringMatching(
        /^review-globs: no usable config, so no review\.riskGlobs — the Codex pass on risk paths never runs: /u,
      ),
    ]);
    expect(result.exit).toBe(EXIT.FAILED);
  });

  it("reports a config that does not load (riskGlobs of the wrong shape)", async () => {
    const result = await run(fakeRepo({ review: { riskGlobs: ["server/auth/**"] } }));
    expect(findingsOf(result.data)).toEqual([
      expect.stringContaining("review-globs: no usable config"),
    ]);
  });

  it.each<[string, unknown]>([
    ["a review block without riskGlobs", {}],
    ["an empty riskGlobs", { riskGlobs: {} }],
  ])("reports %s", async (_name, review) => {
    const result = await run(fakeRepo({ review }));
    expect(findingsOf(result.data)).toEqual([
      "review-globs: review.riskGlobs is missing or empty — the Codex pass on risk paths never runs (PROC-DEV-002)",
    ]);
  });

  it("reports an area without globs and a glob that matches no tracked file", async () => {
    const root = fakeRepo({
      review: { riskGlobs: { auth: ["server/auth/**", "server/gone/**"], billing: [] } },
    });
    expect(findingsOf((await run(root, ["server/auth/login.ts", "README.md"])).data)).toEqual([
      'review-globs: riskGlobs.auth "server/gone/**" matches no file',
      "review-globs: riskGlobs.billing lists no glob",
    ]);
  });
});

describe("doctor — review.riskGlobs by phase (PROC-REL-009)", () => {
  const run = (root: string) => runDoctor(context(root), deps(fakeTools()));
  const emptyGlobs = { riskGlobs: {} };

  it("skips the check in phase development, even with an empty riskGlobs", async () => {
    const result = await run(fakeRepo({ phase: "development", review: emptyGlobs }));
    expect(findingsOf(result.data)).toEqual([]);
    expect(result.exit).toBe(EXIT.OK);
  });

  it.each([["production"], [undefined]])(
    "runs the check with phase %s as before",
    async (phase) => {
      const result = await run(fakeRepo({ phase, review: emptyGlobs }));
      expect(findingsOf(result.data)).toEqual([
        "review-globs: review.riskGlobs is missing or empty — the Codex pass on risk paths never runs (PROC-DEV-002)",
      ]);
      expect(result.exit).toBe(EXIT.FAILED);
    },
  );

  it("reports an invalid phase value as a config that does not load", async () => {
    const result = await run(fakeRepo({ phase: "staging" }));
    expect(findingsOf(result.data)).toEqual([
      expect.stringMatching(/^review-globs: no usable config, .*config invalid at phase: /u),
    ]);
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
      deps(fakeTools({ git: { worktrees: porcelain([{ path: stale, branch: "142-x" }]) } })),
    );
    expect(findingsOf(result.data).join(" ")).toContain(`orphan-worktree: ${stale} (3d old`);
  });

  it("reports a fresh worktree whose ticket is already closed", async () => {
    const fresh = worktreeAged(0);
    const result = await runDoctor(
      context(fakeRepo()),
      deps(
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

  // Spec §7.7, DECISION (doctor-harness-branches). These branches come from the
  // harness, not from the ticket flow: no merge command ever creates or removes
  // them, and their names carry hex that must not be read as a ticket number.
  it("calls a harness branch without commits and without worktree safe to delete", async () => {
    const result = await runDoctor(
      context(fakeRepo()),
      deps(
        fakeTools({
          openIssues: [500],
          git: {
            current: "main",
            branches: ["main", "worktree-agent-a0263e6cd114e71c3", "agent-ff12ab34"],
          },
        }),
      ),
    );
    const findings = findingsOf(result.data).join(" ");
    expect(findings).toContain("harness-residue: 2 harness branch(es)");
    expect(findings).toContain("safe to delete");
    // It must not be mistaken for a ticket branch: `…a0263e…` parses as a number.
    expect(findings).not.toContain("orphan-branch");
    expect(findings).not.toContain("no ticket number in their name");
  });

  // The harness class is judged by own commits and a registered worktree — it needs
  // no ticket data. An early return for "gh could not answer" used to take it down
  // with the ticket-based checks, so offline `doctor` reported none of the 97 empty
  // harness branches it had just been taught to find.
  it("still classifies harness branches when gh cannot say which tickets are open", async () => {
    const result = await runDoctor(
      context(fakeRepo()),
      deps(
        fakeTools({
          ghFails: true, // no remote — `gh issue list` and `gh label list` both fail
          git: {
            current: "main",
            branches: ["main", "worktree-agent-a0263e6cd114e71c3", "chore/304-seed"],
          },
        }),
      ),
    );
    const findings = findingsOf(result.data).join(" ");
    const notes = (result.notes ?? []).join(" ");
    expect(findings).toContain("harness-residue: 1 harness branch(es)");
    // The ticket branch stays unjudged, and that is said out loud.
    expect(findings).not.toContain("orphan-branch");
    expect(notes).toContain("open tickets unknown");
    expect(notes).toContain("the harness class was");
  });

  it("does not call a harness branch residue while its worktree still exists", async () => {
    const result = await runDoctor(
      context(fakeRepo()),
      deps(
        fakeTools({
          openIssues: [500],
          git: {
            current: "main",
            branches: ["main", "worktree-agent-a0263e6cd114e71c3"],
            worktrees:
              "worktree /repo\nbranch refs/heads/main\n\n" +
              "worktree /repo/.claude/worktrees/x\nbranch refs/heads/worktree-agent-a0263e6cd114e71c3\n",
          },
        }),
      ),
    );
    expect(findingsOf(result.data).join(" ")).not.toContain("harness-residue");
  });

  it("checks a harness branch that carries commits by content, not by ancestry", async () => {
    const branch = "worktree-agent-a751aabbccddeeff0";
    const result = await runDoctor(
      context(fakeRepo()),
      deps(
        fakeTools({
          openIssues: [500],
          git: {
            current: "main",
            branches: ["main", branch],
            ahead: { [branch]: 1 },
            diffs: {
              [branch]:
                '+export function visualRegressionSurfaces() {\n+  it("covers the calendar", () => {});\n',
            },
            onMain: [],
          },
        }),
      ),
    );
    const findings = findingsOf(result.data).join(" ");
    expect(findings).toContain("unlanded-work");
    expect(findings).toContain(branch);
    expect(findings).toContain("harness branch, no ticket");
    expect(findings).not.toContain("harness-residue");
  });

  // A minority of absent markers is weak evidence: on a branch that is weeks old
  // `main` has renamed things since, so a single miss means "the code moved", not
  // "the work never landed". Measured against production-cockpit: the branch that
  // really carried unlanded work scored 6 of 7, the noise sat at 1–2 of 10.
  it("keeps a minority of absent markers out of the findings and notes it instead", async () => {
    const branch = "feat/142-partly-renamed";
    const result = await runDoctor(
      context(fakeRepo()),
      deps(
        fakeTools({
          openIssues: [142],
          git: {
            current: "main",
            branches: ["main", branch],
            ahead: { [branch]: 3 },
            diffs: {
              [branch]:
                addedLine("export function alphaSurface() {") +
                addedLine("export function betaSurface() {") +
                addedLine("export function gammaSurface() {") +
                addedLine("export function deltaSurface() {"),
            },
            // Three of four landed; only `deltaSurface` was renamed on main since.
            onMain: ["alphaSurface", "betaSurface", "gammaSurface"],
          },
        }),
      ),
    );
    const findings = findingsOf(result.data).join(" ");
    expect(findings).not.toContain("unlanded-work");
    expect((result.notes ?? []).join(" ")).toContain("miss a minority of their markers");
  });

  it("reports a branch whose introduced work never landed on main", async () => {
    const result = await runDoctor(
      context(fakeRepo()),
      deps(
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
        fakeTools({ ghFails: true, git: { current: "main", branches: ["main", "feat/142-x"] } }),
      ),
    );
    expect(findingsOf(result.data).join(" ")).not.toContain("orphan-branch");
    expect(result.notes?.join(" ")).toContain("open tickets unknown");
  });

  it("puts the full lists in the log and only the summary in the response", async () => {
    const root = fakeRepo();
    const result = await runDoctor(
      context(root),
      deps(
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
      await runDoctor({ ...context(fakeRepo()), args: ["--verbose"] }, deps(fakeTools()));
    } catch (error) {
      expect(error).toBeInstanceOf(ToolkitError);
      expect((error as ToolkitError).exit).toBe(EXIT.PRECONDITION);
      expect((error as ToolkitError).field).toBe("--verbose");
      return;
    }
    throw new Error("expected the call to throw");
  });
});

describe("doctor — npx calls of spec-sync (GL-SEC-011)", () => {
  const SOUND_PREPUSH = [
    'import { spawnSync } from "node:child_process";',
    'import { readFileSync } from "node:fs";',
    'const stdin = readFileSync(0, "utf8");',
    "const preflight = spawnSync(",
    "  process.execPath,",
    '  [fileURLToPath(import.meta.resolve("spec-sync-toolkit/dist/cli.js")), "prepush"],',
    '  { input: stdin, stdio: ["pipe", "inherit", "inherit"] },',
    ");",
    "if (preflight.status !== 0) process.exit(preflight.status ?? 1);",
  ].join("\n");

  /** The app repo shape: simple-git-hooks → a node script → `npm run verify`. */
  const appRepo = (prePush: string, extra: RepoOptions = {}): string =>
    fakeRepo({
      workflows: ["ci.yml"],
      ...extra,
      files: {
        "package.json": JSON.stringify({
          scripts: { verify: "spec-sync gate --profile local" },
          "simple-git-hooks": { "pre-push": "node scripts/prePush.mjs" },
        }),
        "scripts/prePush.mjs": prePush,
        ...extra.files,
      },
    });

  const run = (root: string) => runDoctor(context(root), deps(fakeTools()));

  it("is silent for a hook that runs the toolkit through process.execPath", async () => {
    const result = await run(appRepo(SOUND_PREPUSH));
    expect(findingsOf(result.data)).toEqual([]);
    expect(result.exit).toBe(EXIT.OK);
  });

  it("reports each npx spec-sync in hook, workflow and scripts/ by file and line", async () => {
    const root = appRepo('const r = spawnSync(\n  "npx",\n  ["spec-sync", "prepush"],\n);', {
      files: {
        ".github/workflows/ci.yml": "jobs:\n  x:\n    steps:\n      - run: npx -y spec-sync gate\n",
        "scripts/nested/sync.sh":
          "#!/bin/sh\nnpx --no-install spec-sync repin\nnpx --yes spec-sync map check\n",
        "scripts/README.md": "npx spec-sync doctor\n",
        "docs/usage.md": "npx spec-sync doctor\n",
      },
    });
    const findings = findingsOf((await run(root)).data).filter((f) => f.startsWith("npx:"));
    expect(findings.map((f) => f.split(" ")[1])).toEqual([
      "scripts/prePush.mjs:2",
      ".github/workflows/ci.yml:4",
      "scripts/nested/sync.sh:2",
      "scripts/nested/sync.sh:3",
    ]);
    expect(findings[0]).toContain("call `node_modules/.bin/spec-sync …` (shell)");
    expect(findings[0]).toContain(
      'spawnSync(process.execPath, [fileURLToPath(import.meta.resolve("spec-sync-toolkit/dist/cli.js")), …])` (Node)',
    );
    expect(findings[0]).toContain("even with --no-install");
  });

  it.each<[string, string, string, number]>([
    ["CLAUDE.md", "CLAUDE.md", "# Repo\n\nRun `npx spec-sync gate` before a commit.\n", 3],
    ["AGENTS.md", "AGENTS.md", "# Agents\n\n- npx -y spec-sync doctor\n", 3],
    [
      "AGENTS.md with --no-install",
      "AGENTS.md",
      "# Agents\n\n- npx --no-install spec-sync doctor\n",
      3,
    ],
    [
      "the whole package.json",
      "package.json",
      JSON.stringify({ name: "app", scripts: { pins: "npx spec-sync repin --check" } }, null, 2),
      4,
    ],
    [
      ".claude/settings.json",
      ".claude/settings.json",
      JSON.stringify({ permissions: { allow: ["Bash(npx spec-sync *)"] } }, null, 2),
      4,
    ],
    [
      ".claude/settings.local.json",
      ".claude/settings.local.json",
      JSON.stringify({ permissions: { allow: ["Bash(npx --yes spec-sync:*)"] } }, null, 2),
      4,
    ],
    [
      "an allow rule with --no-install",
      ".claude/settings.json",
      JSON.stringify({ permissions: { allow: ["Bash(npx --no-install spec-sync *)"] } }, null, 2),
      4,
    ],
  ])("reports an npx spec-sync in %s with its line", async (_name, file, text, line) => {
    const root = fakeRepo({ files: { [file]: text } });
    expect(findingsOf((await run(root)).data)).toEqual([
      expect.stringMatching(
        new RegExp(
          `^npx: ${file.replace(/\./gu, "\\.")}:${line} runs \`spec-sync\` through npx`,
          "u",
        ),
      ),
    ]);
  });

  it("is silent for agent files that call the local bin", async () => {
    const root = fakeRepo({
      files: {
        "CLAUDE.md": "node_modules/.bin/spec-sync gate\n",
        ".claude/settings.json": JSON.stringify({
          permissions: { allow: ["Bash(node_modules/.bin/spec-sync *)"] },
        }),
        "package.json": JSON.stringify({ scripts: { pins: "spec-sync repin --check" } }),
      },
    });
    expect(findingsOf((await run(root)).data)).toEqual([]);
  });

  it("npxSpecSyncLines reports every npx spec-sync, --no-install included", () => {
    expect(npxSpecSyncLines("npx spec-sync gate")).toEqual([1]);
    expect(npxSpecSyncLines("a\nnpx -y spec-sync gate")).toEqual([2]);
    expect(npxSpecSyncLines("npx --yes spec-sync gate")).toEqual([1]);
    expect(npxSpecSyncLines('spawnSync("npx", ["spec-sync", "prepush"])')).toEqual([1]);
    expect(npxSpecSyncLines("npx --no-install spec-sync gate")).toEqual([1]);
    expect(npxSpecSyncLines('spawnSync("npx", ["--no-install", "spec-sync"])')).toEqual([1]);
    expect(npxSpecSyncLines("npx --no-install --yes spec-sync gate")).toEqual([1]);
    expect(npxSpecSyncLines("node_modules/.bin/spec-sync gate")).toEqual([]);
    expect(npxSpecSyncLines("spec-sync gate && npx playwright test")).toEqual([]);
    expect(npxSpecSyncLines("npx spec-sync-toolkit")).toEqual([]);
  });

  it("prePushSources follows the hook into the script it calls", () => {
    const root = appRepo(SOUND_PREPUSH);
    expect(prePushSources(root).map((source) => source.file)).toEqual([
      "package.json",
      "scripts/prePush.mjs",
    ]);
  });
});

describe("doctor — npx cache", () => {
  /** An npm cache whose `_npx/<hash>/package.json` manifests are the given ones. */
  const npmCache = (folders: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), "spec-sync-npm-"));
    for (const [hash, manifest] of Object.entries(folders)) {
      mkdirSync(join(root, "_npx", hash), { recursive: true });
      writeFileSync(join(root, "_npx", hash, "package.json"), manifest);
    }
    return root;
  };

  const run = (cache: string) => runDoctor(context(fakeRepo()), deps(fakeTools(), cache));

  it("reports each npx cache folder whose manifest names spec-sync", async () => {
    const cache = npmCache({
      aaa: JSON.stringify({ dependencies: { "spec-sync": "^1.0.0" } }),
      bbb: JSON.stringify({ dependencies: { playwright: "^1.0.0" } }),
      ccc: JSON.stringify({ name: "spec-sync", version: "1.0.0" }),
      ddd: JSON.stringify({ dependencies: { "spec-sync-toolkit": "^0.51.0" } }),
      eee: "not json",
    });
    const result = await run(cache);
    expect(findingsOf(result.data)).toEqual([
      `npx-cache: ${join(cache, "_npx", "aaa")} holds the public npm package \`spec-sync\` — npx runs it in place of the toolkit when the local bin is missing; delete that folder`,
      expect.stringMatching(new RegExp(`^npx-cache: ${join(cache, "_npx", "ccc")} holds`, "u")),
    ]);
    expect(result.exit).toBe(EXIT.FAILED);
  });

  it("is silent without an npx cache or with a clean one", async () => {
    expect(findingsOf((await run(npmCache({}))).data)).toEqual([]);
    expect(
      findingsOf(
        (await run(npmCache({ a: JSON.stringify({ dependencies: { tsx: "^4" } }) }))).data,
      ),
    ).toEqual([]);
  });

  it("defaultNpmCache honours npm_config_cache, then NPM_CONFIG_CACHE, else ~/.npm", () => {
    expect(defaultNpmCache({ npm_config_cache: "/a", NPM_CONFIG_CACHE: "/b" }, "/home")).toBe("/a");
    expect(defaultNpmCache({ NPM_CONFIG_CACHE: "/b" }, "/home")).toBe("/b");
    expect(defaultNpmCache({}, "/home")).toBe(join("/home", ".npm"));
  });
});
