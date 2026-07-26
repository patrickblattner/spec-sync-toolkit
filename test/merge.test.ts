import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DONE_LABEL,
  commitMessage,
  parseMergeOptions,
  runMerge,
  type MergeDeps,
} from "../src/commands/merge.js";
import { appendEvent, readLedger } from "../src/ledger.js";
import { NORM_DEFAULTS } from "../src/norms.js";
import { EXIT, ToolkitError } from "../src/output.js";

/** Captures the ToolkitError a parser threw, so exit code and field are assertable. */
function thrown(fn: () => unknown): ToolkitError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ToolkitError) return error;
    throw error;
  }
  throw new Error("expected a ToolkitError, none was thrown");
}

interface World {
  currentBranch: string;
  dirty: boolean;
  branches: string[];
  remotes: string[];
  worktrees: { path: string; branch: string }[];
  headSubject: string;
  unpushed: string;
  issueState: string;
  issueTitle: string;
  issueLabels: string[];
}

function world(over: Partial<World> = {}): World {
  return {
    currentBranch: "main",
    dirty: false,
    branches: ["main", "feat/csv"],
    remotes: ["origin"],
    worktrees: [
      { path: "/repo", branch: "main" },
      { path: "/repo/.claude/worktrees/csv", branch: "feat/csv" },
    ],
    headSubject: "previous commit #1",
    unpushed: "1",
    issueState: "OPEN",
    issueTitle: "add CSV export",
    issueLabels: ["spec-sync"],
    ...over,
  };
}

interface Call {
  tool: "git" | "gh";
  args: string[];
}

/**
 * A git/gh pair that answers from `state` and *mutates* it on the write
 * commands, so the postconditions of a real run are checked against a world the
 * sequence actually changed. Nothing here touches a repo, an issue or a remote.
 */
function fakeDeps(state: World): {
  deps: MergeDeps;
  git: string[][];
  gh: string[][];
  calls: Call[];
  root: string;
} {
  const gitCalls: string[][] = [];
  const ghCalls: string[][] = [];
  // One ordered list, so a test can assert the true git/gh interleaving.
  const calls: Call[] = [];
  const root = mkdtempSync(join(tmpdir(), "spec-sync-merge-"));

  const git = async (args: string[]): Promise<string> => {
    gitCalls.push(args);
    calls.push({ tool: "git", args });
    const key = args.join(" ");
    if (key === "rev-parse --abbrev-ref HEAD") return `${state.currentBranch}\n`;
    if (key === "status --porcelain") return state.dirty ? " M src/a.ts\n" : "";
    if (key === "remote") return `${state.remotes.join("\n")}\n`;
    if (args[0] === "branch" && args[1] === "--list") {
      return state.branches.includes(args[2] ?? "") ? `  ${args[2]}\n` : "";
    }
    if (key === "worktree list --porcelain") {
      return state.worktrees
        .map((tree) => `worktree ${tree.path}\nbranch refs/heads/${tree.branch}\n`)
        .join("\n");
    }
    if (key === "log -1 --format=%s") return `${state.headSubject}\n`;
    if (args[0] === "rev-list") return `${state.unpushed}\n`;

    if (args[0] === "merge") return "";
    if (args[0] === "commit") {
      state.headSubject = args[2] ?? "";
      return "";
    }
    if (args[0] === "push") {
      state.unpushed = "0";
      return "";
    }
    if (args[0] === "worktree" && args[1] === "remove") {
      state.worktrees = state.worktrees.filter((tree) => tree.path !== args[2]);
      return "";
    }
    if (args[0] === "branch" && args[1] === "-D") {
      state.branches = state.branches.filter((branch) => branch !== args[2]);
      return "";
    }
    throw new Error(`unexpected git call: ${key}`);
  };

  const gh = async (args: string[]): Promise<string> => {
    ghCalls.push(args);
    calls.push({ tool: "gh", args });
    if (args[1] === "view") {
      return JSON.stringify({
        state: state.issueState,
        title: state.issueTitle,
        labels: state.issueLabels.map((name) => ({ name })),
      });
    }
    if (args[1] === "close") {
      state.issueState = "CLOSED";
      return "";
    }
    if (args[1] === "edit") {
      state.issueLabels.push(args[4] ?? "");
      return "";
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };

  return {
    deps: { git, gh, repoRoot: root, now: () => new Date("2026-07-26T12:00:00.000Z") },
    git: gitCalls,
    gh: ghCalls,
    calls,
    root,
  };
}

/** Records the green merge-gate evidence §7.4 demands as a precondition. */
function recordGreenGate(root: string, issue: number): void {
  appendEvent(root, { type: "gate", issue, ok: true, profile: "merge" });
}

const options = { issue: 42, branch: "feat/csv", dryRun: false };

/** Every command that would change the repo, an issue or the remote, in call order. */
function mutations(calls: Call[]): string[] {
  const writingGit = new Set(["merge", "commit", "push"]);
  return calls
    .filter(({ tool, args }) =>
      tool === "git"
        ? writingGit.has(args[0] ?? "") ||
          (args[0] === "branch" && args[1] === "-D") ||
          (args[0] === "worktree" && args[1] === "remove")
        : args[1] === "close" || args[1] === "edit",
    )
    .map(({ args }) => `${args[0]} ${args[1] ?? ""}`.trim());
}

describe("--dry-run changes nothing and reports the full sequence (§12 M3)", () => {
  it("issues no mutating command at all", async () => {
    const { deps, calls, root } = fakeDeps(world());
    recordGreenGate(root, 42);

    const result = await runMerge(deps, { ...options, dryRun: true }, NORM_DEFAULTS);

    expect(result.ok).toBe(true);
    expect(mutations(calls)).toEqual([]);
  });

  it("reports the complete sequence of §7.4, in order", async () => {
    const { deps, root } = fakeDeps(world());
    recordGreenGate(root, 42);

    const result = await runMerge(deps, { ...options, dryRun: true }, NORM_DEFAULTS);
    const steps = result.data.steps as { name: string; cmd: string }[];

    expect(steps.map((step) => step.name)).toEqual([
      "squash-merge",
      "commit",
      "push",
      "label-issue",
      "close-issue",
      "remove-worktree",
      "delete-branch",
    ]);
    expect(steps[0]?.cmd).toBe("git merge --squash feat/csv");
    expect(steps[2]?.cmd).toBe("git push origin main");
    // The worktree is removed without --force, as the norm demands.
    expect(steps[5]?.cmd).toBe("git worktree remove /repo/.claude/worktrees/csv");
    expect(steps[5]?.cmd).not.toContain("--force");
  });

  it("plans exactly one push", async () => {
    const { deps, root } = fakeDeps(world());
    recordGreenGate(root, 42);
    const result = await runMerge(deps, { ...options, dryRun: true }, NORM_DEFAULTS);
    const steps = result.data.steps as { name: string }[];
    expect(steps.filter((step) => step.name === "push")).toHaveLength(1);
  });

  it("leaves the worktree step out when no worktree is checked out on the branch", async () => {
    const { deps, root } = fakeDeps(world({ worktrees: [{ path: "/repo", branch: "main" }] }));
    recordGreenGate(root, 42);
    const result = await runMerge(deps, { ...options, dryRun: true }, NORM_DEFAULTS);
    const steps = result.data.steps as { name: string }[];
    expect(steps.map((step) => step.name)).not.toContain("remove-worktree");
  });

  it("marks itself as a dry run so a caller cannot mistake it for a merge", async () => {
    const { deps, root } = fakeDeps(world());
    recordGreenGate(root, 42);
    const result = await runMerge(deps, { ...options, dryRun: true }, NORM_DEFAULTS);
    expect(result.data.dryRun).toBe(true);
    expect(result.notes.join(" ")).toMatch(/nothing changed/);
  });
});

describe("a violated precondition is exit 4 and changes nothing (§12 M3)", () => {
  const cases: { name: string; state: Partial<World>; gate: boolean; check: string }[] = [
    { name: "no gate evidence at all", state: {}, gate: false, check: "gate-evidence-green" },
    { name: "a dirty working tree", state: { dirty: true }, gate: true, check: "worktree-clean" },
    {
      name: "a branch that does not exist",
      state: { branches: ["main"] },
      gate: true,
      check: "branch-exists",
    },
    {
      name: "HEAD on another branch",
      state: { currentBranch: "feat/other" },
      gate: true,
      check: "on-main",
    },
    {
      name: "an already closed issue",
      state: { issueState: "CLOSED" },
      gate: true,
      check: "issue-open",
    },
    {
      name: "an owner-hold on the issue",
      state: { issueLabels: ["spec-sync", "owner-hold"] },
      gate: true,
      check: "no-owner-hold",
    },
    {
      name: "no remote to push to",
      state: { remotes: [] },
      gate: true,
      check: "remote-configured",
    },
  ];

  for (const testCase of cases) {
    it(`refuses on ${testCase.name}`, async () => {
      const { deps, calls, root } = fakeDeps(world(testCase.state));
      if (testCase.gate) recordGreenGate(root, 42);

      const result = await runMerge(deps, options, NORM_DEFAULTS);

      expect(result.exit).toBe(EXIT.PRECONDITION);
      expect(result.ok).toBe(false);
      expect(mutations(calls)).toEqual([]);
      const violated = result.data.preconditions as { name: string }[];
      expect(violated.map((check) => check.name)).toContain(testCase.check);
    });
  }

  it("refuses on a red gate, not only on a missing one", async () => {
    const { deps, root } = fakeDeps(world());
    appendEvent(root, { type: "gate", issue: 42, ok: false, profile: "merge" });
    const result = await runMerge(deps, options, NORM_DEFAULTS);
    expect(result.exit).toBe(EXIT.PRECONDITION);
    expect((result.data.preconditions as { detail?: string }[])[0]?.detail).toMatch(/red/);
  });

  it("does not accept a green local gate as merge evidence", async () => {
    const { deps, root } = fakeDeps(world());
    appendEvent(root, { type: "gate", issue: 42, ok: true, profile: "local" });
    const result = await runMerge(deps, options, NORM_DEFAULTS);
    expect(result.exit).toBe(EXIT.PRECONDITION);
  });

  it("refuses in --dry-run too — the check is the point of the dry run", async () => {
    const { deps, calls } = fakeDeps(world({ dirty: true }));
    const result = await runMerge(deps, { ...options, dryRun: true }, NORM_DEFAULTS);
    expect(result.exit).toBe(EXIT.PRECONDITION);
    expect(mutations(calls)).toEqual([]);
  });

  it("reports every violated precondition, not just the first", async () => {
    const { deps } = fakeDeps(world({ dirty: true, branches: ["main"], remotes: [] }));
    const result = await runMerge(deps, options, NORM_DEFAULTS);
    const violated = result.data.preconditions as { name: string }[];
    expect(violated.map((check) => check.name)).toEqual(
      expect.arrayContaining([
        "gate-evidence-green",
        "worktree-clean",
        "branch-exists",
        "remote-configured",
      ]),
    );
  });

  it("records the refusal in the ledger as a blocked event with its reason", async () => {
    const { deps, root } = fakeDeps(world({ dirty: true }));
    recordGreenGate(root, 42);
    await runMerge(deps, options, NORM_DEFAULTS);

    const blocked = readLedger(root).events.filter((event) => event.type === "blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ issue: 42, reason: "worktree-clean" });
  });
});

describe("the executed sequence and its postconditions (§7.4)", () => {
  it("walks the sequence in order and pushes exactly once", async () => {
    const state = world();
    const { deps, git, calls, root } = fakeDeps(state);
    recordGreenGate(root, 42);

    const result = await runMerge(deps, options, NORM_DEFAULTS);

    expect(result.ok).toBe(true);
    expect(result.exit).toBe(EXIT.OK);
    const mutating = mutations(calls);
    expect(mutating).toEqual([
      "merge --squash",
      "commit -m",
      "push origin",
      "issue edit",
      "issue close",
      "worktree remove",
      "branch -D",
    ]);
    expect(git.filter((call) => call[0] === "push")).toHaveLength(1);
  });

  it("commits with the ticket reference and closes the issue with the status label", async () => {
    const state = world();
    const { deps, root } = fakeDeps(state);
    recordGreenGate(root, 42);

    await runMerge(deps, options, NORM_DEFAULTS);

    expect(state.headSubject).toBe("add CSV export #42");
    expect(state.issueState).toBe("CLOSED");
    expect(state.issueLabels).toContain(DONE_LABEL);
  });

  it("removes the worktree and deletes the branch", async () => {
    const state = world();
    const { deps, root } = fakeDeps(state);
    recordGreenGate(root, 42);

    await runMerge(deps, options, NORM_DEFAULTS);

    expect(state.worktrees.map((tree) => tree.branch)).toEqual(["main"]);
    expect(state.branches).toEqual(["main"]);
  });

  it("re-queries every postcondition after execution", async () => {
    const { deps, root } = fakeDeps(world());
    recordGreenGate(root, 42);

    const result = await runMerge(deps, options, NORM_DEFAULTS);
    const after = result.data.postconditions as { name: string; ok: boolean }[];

    expect(after.map((check) => check.name)).toEqual([
      "commit-on-main",
      "worktree-clean",
      "pushed",
      "issue-closed",
      "branch-deleted",
      "worktree-removed",
    ]);
    expect(after.every((check) => check.ok)).toBe(true);
  });

  it("writes a merge-completed event once the postconditions hold", async () => {
    const { deps, root } = fakeDeps(world());
    recordGreenGate(root, 42);
    await runMerge(deps, { ...options, run: "run-1" }, NORM_DEFAULTS);

    const merged = readLedger(root).events.filter((event) => event.type === "merge-completed");
    expect(merged[0]).toMatchObject({ issue: 42, ok: true, branch: "feat/csv", run: "run-1" });
  });

  // DECISION (merge-resumable), spec §7.4: the pair is what lets a later run — and
  // `doctor` — tell "never merged" from "merge died between two mutating steps".
  it("writes merge-started before the first mutating step and completes the pair", async () => {
    const { deps, root } = fakeDeps(world());
    recordGreenGate(root, 42);
    await runMerge(deps, { ...options, run: "run-1" }, NORM_DEFAULTS);

    const types = readLedger(root)
      .events.filter((event) => String(event.type).startsWith("merge-"))
      .map((event) => event.type);
    expect(types).toEqual(["merge-started", "merge-completed"]);
  });

  it("leaves a merge-started without its completion when a postcondition fails", async () => {
    const { deps, root } = fakeDeps(world());
    recordGreenGate(root, 42);
    const brokenDeps: MergeDeps = {
      ...deps,
      git: async (args) => (args[0] === "push" ? "" : deps.git(args)),
    };

    await runMerge(brokenDeps, options, NORM_DEFAULTS);

    const events = readLedger(root).events;
    expect(events.filter((event) => event.type === "merge-started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "merge-completed")).toHaveLength(0);
  });

  it("writes no merge-started at all when a precondition already fails", async () => {
    const { deps, root } = fakeDeps(world());
    // No green gate recorded — the merge is not mechanically admissible.
    await runMerge(deps, options, NORM_DEFAULTS);
    expect(readLedger(root).events.filter((e) => e.type === "merge-started")).toHaveLength(0);
  });

  it("is exit 1, not exit 4, when a postcondition fails after execution", async () => {
    const state = world();
    const { deps, root } = fakeDeps(state);
    recordGreenGate(root, 42);
    // The push silently leaves commits behind — the repo is half-finished.
    const brokenDeps: MergeDeps = {
      ...deps,
      git: async (args) => {
        if (args[0] === "push") return "";
        return deps.git(args);
      },
    };

    const result = await runMerge(brokenDeps, options, NORM_DEFAULTS);

    expect(result.exit).toBe(EXIT.FAILED);
    expect(result.ok).toBe(false);
    const failed = result.data.postconditions as { name: string }[];
    expect(failed.map((check) => check.name)).toEqual(["pushed"]);
    expect(result.notes.join(" ")).toMatch(/needs diagnosis/);
  });

  it("records a failed postcondition as blocked, not as merge-completed", async () => {
    const { deps, root } = fakeDeps(world());
    recordGreenGate(root, 42);
    const brokenDeps: MergeDeps = {
      ...deps,
      git: async (args) => (args[0] === "push" ? "" : deps.git(args)),
    };

    await runMerge(brokenDeps, options, NORM_DEFAULTS);

    const events = readLedger(root).events;
    expect(events.filter((event) => event.type === "merge-completed")).toHaveLength(0);
    expect(events.filter((event) => event.type === "blocked")[0]).toMatchObject({
      issue: 42,
      reason: "pushed",
    });
  });
});

describe("commit message and option parsing", () => {
  it("appends the ticket reference the commit hook demands", () => {
    expect(commitMessage(42, "add CSV export")).toBe("add CSV export #42");
  });

  it("does not duplicate a reference the title already carries", () => {
    expect(commitMessage(42, "add CSV export #42")).toBe("add CSV export #42");
  });

  it("parses the issue number and --branch, with or without the hash", () => {
    expect(parseMergeOptions(["42", "--branch", "feat/csv"], false)).toEqual({
      issue: 42,
      branch: "feat/csv",
      dryRun: false,
    });
    expect(parseMergeOptions(["#42", "--branch", "x"], true).issue).toBe(42);
  });

  it("accepts --branch=x as well as --branch x", () => {
    expect(parseMergeOptions(["42", "--branch=feat/csv"], false)).toEqual(
      parseMergeOptions(["42", "--branch", "feat/csv"], false),
    );
  });

  it("keeps an = inside the branch name intact", () => {
    expect(parseMergeOptions(["42", "--branch=feat/a=b"], false).branch).toBe("feat/a=b");
  });

  it("refuses an empty --branch= instead of merging a nameless branch", () => {
    expect(() => parseMergeOptions(["42", "--branch="], false)).toThrowError(
      /--branch needs a value/,
    );
  });

  it("rejects a mistyped option with exit 4 and names the field", () => {
    const error = thrown(() => parseMergeOptions(["42", "--brnach", "x"], false));
    expect(error.exit).toBe(EXIT.PRECONDITION);
    expect(error.field).toBe("--brnach");
  });

  it("refuses without an issue number or without a branch", () => {
    expect(() => parseMergeOptions(["--branch", "x"], false)).toThrowError(/needs an issue number/);
    expect(() => parseMergeOptions(["42"], false)).toThrowError(/needs --branch/);
    expect(() => parseMergeOptions(["42", "--branch"], false)).toThrowError(
      /--branch needs a value/,
    );
  });

  it("refuses a non-numeric issue instead of guessing one", () => {
    expect(() => parseMergeOptions(["latest", "--branch", "x"], false)).toThrowError(
      /not an issue number/,
    );
  });
});
