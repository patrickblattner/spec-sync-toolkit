/**
 * `merge` — run the mechanical merge sequence (spec §7.4).
 *
 * The command **never decides whether a merge is allowed** — that judgement
 * belongs to the driver (spec §2). It only checks whether a merge is
 * *mechanically admissible*, then walks the sequence of §7.4:
 *
 *   preconditions → `git merge --squash` onto `main` → commit with the ticket
 *   reference → **exactly one push** → close the issue + status label → remove
 *   the worktree (**without** `--force`) + delete the branch → **re-query every
 *   postcondition**.
 *
 * A violated precondition is exit 4 (fix the cause). A postcondition that fails
 * *after* execution is exit 1 (diagnose) — the difference matters, because the
 * second means the repo is in a half-finished state.
 *
 * `--dry-run` is mandatory functionality: it checks the preconditions, reports
 * the complete sequence and changes nothing.
 *
 * `TaskStop` of sub-agents stays with the driver — the toolkit knows no agents.
 */

import { simpleGit } from "simple-git";
import { EXIT, ToolkitError } from "../output.js";
import { appendEvent, latestGate, readLedger } from "../ledger.js";
import { ghRunner, type GhRunner } from "./queue.js";
import { loadNorms, type Norms } from "../norms.js";
import type { Command, CommandContext } from "../cli.js";

/** The branch `main` moves only through gate-verified squash merges (§Worker-Loop). */
export const MAIN_BRANCH = "main";

/**
 * The gate profile whose evidence gates a merge: §Worker-Loop merges only
 * "erst, nachdem das komplette lokale Merge-Gate grün ist".
 */
export const MERGE_GATE_PROFILE = "merge";

/** Status label set on close. From the label taxonomy of `foundation.dev.process`. */
export const DONE_LABEL = "status: done";

export interface MergeDeps {
  git: (args: string[]) => Promise<string>;
  gh: GhRunner;
  repoRoot: string;
  now: () => Date;
}

export interface MergeOptions {
  issue: number;
  branch: string;
  dryRun: boolean;
  /** Groups this merge's ledger events with the rest of the run. */
  run?: string;
}

/** One step of the sequence — the same list drives dry-run and execution. */
export interface MergeStep {
  name: string;
  /** The command that runs, verbatim, so a dry-run is reviewable. */
  cmd: string;
}

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

/** Splits `--flag=value` into two tokens, so both spellings reach the same loop. */
function splitInlineValues(args: string[]): string[] {
  return args.flatMap((token) => {
    const match = /^(--[^=]+)=(.*)$/.exec(token);
    return match === null ? [token] : [match[1] as string, match[2] as string];
  });
}

/**
 * Parses `merge`'s own options: `<issue> --branch <name>` (or `--branch=<name>`).
 *
 * `cli.ts` passes command-specific flags through untouched, so validating them
 * — and failing with exit 4 naming the offending field — is this command's job.
 */
export function parseMergeOptions(args: string[], dryRun: boolean): MergeOptions {
  let issue: number | undefined;
  let branch: string | undefined;
  const tokens = splitInlineValues(args);

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    if (token === "--branch") {
      const value = tokens[i + 1];
      if (value === undefined || value === "" || value.startsWith("-")) {
        throw new ToolkitError("--branch needs a value", EXIT.PRECONDITION, { field: "--branch" });
      }
      branch = value;
      i += 1;
    } else if (token.startsWith("-")) {
      throw new ToolkitError(`unknown option for merge: ${token}`, EXIT.PRECONDITION, {
        field: token,
      });
    } else if (issue === undefined) {
      const parsed = Number.parseInt(token.replace(/^#/, ""), 10);
      if (!Number.isInteger(parsed)) {
        throw new ToolkitError(`not an issue number: ${token}`, EXIT.PRECONDITION, {
          field: "issue",
        });
      }
      issue = parsed;
    } else {
      throw new ToolkitError(`unexpected argument for merge: ${token}`, EXIT.PRECONDITION, {
        field: token,
      });
    }
  }

  if (issue === undefined) {
    throw new ToolkitError("merge needs an issue number", EXIT.PRECONDITION, { field: "issue" });
  }
  if (branch === undefined) {
    throw new ToolkitError("merge needs --branch <name>", EXIT.PRECONDITION, { field: "--branch" });
  }
  return { issue, branch, dryRun };
}

interface GhIssueView {
  state?: string;
  title?: string;
  labels?: { name: string }[];
}

/**
 * Everything the sequence needs to know about the world, gathered once. Read
 * only — nothing here changes the repo, so `--dry-run` runs the identical path.
 */
interface Facts {
  currentBranch: string;
  isClean: boolean;
  branchExists: boolean;
  remote?: string;
  worktreePath?: string;
  issue: GhIssueView;
  gateOk: boolean;
  gateDetail: string;
}

async function gather(deps: MergeDeps, options: MergeOptions): Promise<Facts> {
  const currentBranch = (await deps.git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  const isClean = (await deps.git(["status", "--porcelain"])).trim() === "";
  const branches = (await deps.git(["branch", "--list", options.branch])).trim();
  const remote = (await deps.git(["remote"])).trim().split("\n")[0]?.trim() || undefined;
  const worktreePath = await findWorktree(deps, options.branch);

  const issue = JSON.parse(
    await deps.gh(["issue", "view", String(options.issue), "--json", "state,title,labels"]),
  ) as GhIssueView;

  const gate = latestGate(readLedger(deps.repoRoot).events, options.issue, MERGE_GATE_PROFILE);

  return {
    currentBranch,
    isClean,
    branchExists: branches !== "",
    remote,
    worktreePath,
    issue,
    gateOk: gate?.ok === true,
    gateDetail:
      gate === undefined
        ? `no green "${MERGE_GATE_PROFILE}" gate recorded for #${options.issue} in the ledger`
        : `gate at ${gate.at} was ${gate.ok === true ? "green" : "red"}`,
  };
}

/** The path of the worktree checked out on `branch`, if one exists. */
async function findWorktree(deps: MergeDeps, branch: string): Promise<string | undefined> {
  const porcelain = await deps.git(["worktree", "list", "--porcelain"]);
  let path: string | undefined;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
    else if (line.trim() === `branch refs/heads/${branch}`) return path;
  }
  return undefined;
}

/** The preconditions of §7.4. All of them are reported, not just the first. */
export function preconditions(facts: Facts, options: MergeOptions, norms: Norms): Check[] {
  const labels = (facts.issue.labels ?? []).map((label) => label.name);
  return [
    {
      name: "gate-evidence-green",
      ok: facts.gateOk,
      detail: facts.gateDetail,
    },
    {
      name: "worktree-clean",
      ok: facts.isClean,
      detail: facts.isClean ? undefined : "working tree has uncommitted changes",
    },
    {
      name: "branch-exists",
      ok: facts.branchExists,
      detail: facts.branchExists ? undefined : `no local branch "${options.branch}"`,
    },
    {
      name: `on-${MAIN_BRANCH}`,
      ok: facts.currentBranch === MAIN_BRANCH,
      detail:
        facts.currentBranch === MAIN_BRANCH
          ? undefined
          : `HEAD is on "${facts.currentBranch}" — the squash merge lands on "${MAIN_BRANCH}"`,
    },
    {
      name: "issue-open",
      ok: facts.issue.state?.toUpperCase() === "OPEN",
      detail:
        facts.issue.state?.toUpperCase() === "OPEN"
          ? undefined
          : `issue #${options.issue} is "${facts.issue.state ?? "unknown"}"`,
    },
    {
      name: "no-owner-hold",
      ok: !labels.includes(norms.hold),
      detail: labels.includes(norms.hold)
        ? `issue #${options.issue} carries "${norms.hold}" — only the owner removes it`
        : undefined,
    },
    {
      name: "remote-configured",
      ok: facts.remote !== undefined,
      // The norm forbids piling up unpushed merges, so a merge without a push
      // target is not admissible in the first place.
      detail: facts.remote === undefined ? "no git remote — every merge must be pushed" : undefined,
    },
  ];
}

/** The commit message: the ticket reference is mandatory (§Commit-Disziplin). */
export function commitMessage(issue: number, title: string | undefined): string {
  const subject = title === undefined || title.trim() === "" ? `merge branch` : title.trim();
  return subject.includes(`#${issue}`) ? subject : `${subject} #${issue}`;
}

/** The sequence of §7.4, as data — dry-run reports it, execution walks it. */
export function plan(facts: Facts, options: MergeOptions): MergeStep[] {
  const steps: MergeStep[] = [
    { name: "squash-merge", cmd: `git merge --squash ${options.branch}` },
    {
      name: "commit",
      cmd: `git commit -m ${JSON.stringify(commitMessage(options.issue, facts.issue.title))}`,
    },
    { name: "push", cmd: `git push ${facts.remote ?? "origin"} ${MAIN_BRANCH}` },
    {
      name: "label-issue",
      cmd: `gh issue edit ${options.issue} --add-label ${JSON.stringify(DONE_LABEL)}`,
    },
    { name: "close-issue", cmd: `gh issue close ${options.issue}` },
  ];
  if (facts.worktreePath !== undefined) {
    steps.push({ name: "remove-worktree", cmd: `git worktree remove ${facts.worktreePath}` });
  }
  // `-d` would always refuse: a squash merge records no parent link, so git
  // cannot see the branch as merged. `-D` after a verified squash is the norm.
  steps.push({ name: "delete-branch", cmd: `git branch -D ${options.branch}` });
  return steps;
}

async function execute(deps: MergeDeps, facts: Facts, options: MergeOptions): Promise<void> {
  await deps.git(["merge", "--squash", options.branch]);
  await deps.git(["commit", "-m", commitMessage(options.issue, facts.issue.title)]);
  await deps.git(["push", facts.remote ?? "origin", MAIN_BRANCH]);
  await deps.gh(["issue", "edit", String(options.issue), "--add-label", DONE_LABEL]);
  await deps.gh(["issue", "close", String(options.issue)]);
  if (facts.worktreePath !== undefined) {
    await deps.git(["worktree", "remove", facts.worktreePath]);
  }
  await deps.git(["branch", "-D", options.branch]);
}

/** Every postcondition, re-queried against the world after execution (§7.4). */
export async function postconditions(
  deps: MergeDeps,
  facts: Facts,
  options: MergeOptions,
): Promise<Check[]> {
  const head = (await deps.git(["log", "-1", "--format=%s"])).trim();
  const clean = (await deps.git(["status", "--porcelain"])).trim() === "";
  const branchGone = (await deps.git(["branch", "--list", options.branch])).trim() === "";
  const worktreeGone = (await findWorktree(deps, options.branch)) === undefined;
  const remote = facts.remote ?? "origin";
  const unpushed = (
    await deps.git(["rev-list", "--count", `${remote}/${MAIN_BRANCH}..${MAIN_BRANCH}`])
  ).trim();
  const issue = JSON.parse(
    await deps.gh(["issue", "view", String(options.issue), "--json", "state"]),
  ) as GhIssueView;

  return [
    {
      name: "commit-on-main",
      ok: head.includes(`#${options.issue}`),
      detail: head.includes(`#${options.issue}`) ? undefined : `HEAD subject is "${head}"`,
    },
    { name: "worktree-clean", ok: clean, detail: clean ? undefined : "working tree is dirty" },
    {
      name: "pushed",
      ok: unpushed === "0",
      detail:
        unpushed === "0" ? undefined : `${unpushed} commit(s) not on ${remote}/${MAIN_BRANCH}`,
    },
    {
      name: "issue-closed",
      ok: issue.state?.toUpperCase() === "CLOSED",
      detail:
        issue.state?.toUpperCase() === "CLOSED" ? undefined : `issue is "${issue.state ?? "?"}"`,
    },
    {
      name: "branch-deleted",
      ok: branchGone,
      detail: branchGone ? undefined : `branch "${options.branch}" still exists`,
    },
    {
      name: "worktree-removed",
      ok: worktreeGone,
      detail: worktreeGone ? undefined : `a worktree for "${options.branch}" still exists`,
    },
  ];
}

export interface MergeResult {
  ok: boolean;
  exit?: (typeof EXIT)[keyof typeof EXIT];
  notes: string[];
  data: Record<string, unknown>;
}

export async function runMerge(
  deps: MergeDeps,
  options: MergeOptions,
  norms: Norms = loadNorms().norms,
): Promise<MergeResult> {
  const facts = await gather(deps, options);
  const checks = preconditions(facts, options, norms);
  const violated = checks.filter((check) => !check.ok);
  const steps = plan(facts, options);

  if (violated.length > 0) {
    // Not a merge verdict — only the statement that a merge is not mechanically
    // admissible yet. The driver fixes the cause and calls again.
    appendEvent(deps.repoRoot, {
      type: "blocked",
      issue: options.issue,
      run: options.run,
      reason: violated.map((check) => check.name).join(", "),
    });
    return {
      ok: false,
      exit: EXIT.PRECONDITION,
      notes: [`${violated.length} precondition(s) violated — nothing was changed`],
      data: { issue: options.issue, branch: options.branch, preconditions: violated, steps },
    };
  }

  if (options.dryRun) {
    return {
      ok: true,
      notes: ["dry run — preconditions checked, nothing changed"],
      data: { issue: options.issue, branch: options.branch, dryRun: true, steps },
    };
  }

  // Written BEFORE the first mutating step (spec §7.4, `DECISION (merge-resumable)`).
  // A script is not a transaction: if the process dies between the push and the
  // worktree removal, this entry without its `merge-completed` is the only trace
  // that says so — and it is what `doctor` looks for (§7.7).
  appendEvent(deps.repoRoot, {
    type: "merge-started",
    issue: options.issue,
    run: options.run,
    branch: options.branch,
  });

  await execute(deps, facts, options);
  const after = await postconditions(deps, facts, options);
  const failed = after.filter((check) => !check.ok);

  appendEvent(deps.repoRoot, {
    type: failed.length === 0 ? "merge-completed" : "blocked",
    issue: options.issue,
    run: options.run,
    ok: failed.length === 0,
    branch: options.branch,
    ...(failed.length === 0 ? {} : { reason: failed.map((check) => check.name).join(", ") }),
  });

  return {
    ok: failed.length === 0,
    // After execution a broken postcondition is red on the merits, not a
    // precondition: the repo is in a half-finished state and needs diagnosis.
    exit: failed.length === 0 ? EXIT.OK : EXIT.FAILED,
    notes:
      failed.length === 0
        ? []
        : [`${failed.length} postcondition(s) failed after execution — repo needs diagnosis`],
    data: {
      issue: options.issue,
      branch: options.branch,
      steps,
      postconditions: failed.length === 0 ? after : failed,
    },
  };
}

export function mergeDeps(ctx: CommandContext): MergeDeps {
  const git = simpleGit(ctx.repoRoot);
  return {
    git: (args) => git.raw(args),
    gh: ghRunner(ctx.repoRoot),
    repoRoot: ctx.repoRoot,
    now: () => new Date(),
  };
}

export const mergeCommand: Command = {
  name: "merge",
  summary: "Run the mechanical merge sequence after approval",
  needsConfig: true,
  async run(ctx) {
    const options = parseMergeOptions(ctx.args, ctx.flags.dryRun);
    return runMerge(mergeDeps(ctx), options);
  },
};
