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
 * the complete sequence and changes nothing — **including the ledger**.
 *
 * A script is not a transaction, so the command is resumable
 * (`DECISION (merge-resumable)`): a `merge-started` without its
 * `merge-completed` means a previous run died between two mutating steps, and
 * the next call re-queries every postcondition and executes only the steps that
 * are still missing. Without that path the second call fails on `issue-open` —
 * the very state a half-finished merge leaves behind.
 *
 * `TaskStop` of sub-agents stays with the driver — the toolkit knows no agents.
 */

import { simpleGit } from "simple-git";
import { EXIT, ToolkitError } from "../output.js";
import { appendEvent, interruptedMerge, latestGate, readLedger } from "../ledger.js";
import type { LedgerEvent } from "../ledger.js";
import { ghRunner, type GhRunner } from "./queue.js";
import { loadNorms, type Norms } from "../norms.js";
import { parseGateMode, type GateMode } from "../gate/environment.js";
import type { Command, CommandContext } from "../cli.js";

/** The branch `main` moves only through gate-verified squash merges (§Worker-Loop). */
export const MAIN_BRANCH = "main";

/**
 * The gate profile whose evidence gates a merge: §Worker-Loop merges only
 * "after the complete local merge gate is green".
 */
export const MERGE_GATE_PROFILE = "merge";

/** Status label set on close. From the label taxonomy of `foundation.dev.process`. */
export const DONE_LABEL = "status: done";

/** Prefix of the status labels. Exactly one of them may be set at a time. */
const STATUS_PREFIX = "status: ";

/**
 * The status labels the issue still carries besides `status: done`.
 *
 * Adding `done` without taking the old one off leaves the ticket reading
 * `status: in-progress, status: done` — two states at once, which every query
 * over the taxonomy then counts twice (measured on `production-cockpit#775`).
 * `gh issue edit` takes both flags in one call, so this costs no extra step.
 */
export function staleStatusLabels(facts: Facts): string[] {
  return (facts.issue.labels ?? [])
    .map((label) => label.name)
    .filter((name) => name.startsWith(STATUS_PREFIX) && name !== DONE_LABEL);
}

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
  /** `GATE_MODE` of the repo (PROC-DEV-044); `unknown` when `gh` cannot say. */
  gateMode: GateMode;
}

async function gather(
  deps: MergeDeps,
  options: MergeOptions,
  events: LedgerEvent[],
): Promise<Facts> {
  const currentBranch = (await deps.git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  const isClean = (await deps.git(["status", "--porcelain"])).trim() === "";
  const branches = (await deps.git(["branch", "--list", options.branch])).trim();
  const remote = (await deps.git(["remote"])).trim().split("\n")[0]?.trim() || undefined;
  const worktreePath = await findWorktree(deps, options.branch);

  const issue = JSON.parse(
    await deps.gh(["issue", "view", String(options.issue), "--json", "state,title,labels"]),
  ) as GhIssueView;

  const gate = latestGate(events, options.issue, MERGE_GATE_PROFILE);

  // Asked through the same `gh` the sequence uses. A missing variable is an
  // error for `gh` and `unknown` here — the norm reads it as local, and an
  // unreadable mode must never block a merge that was admissible yesterday.
  const gateMode = await deps
    .gh(["variable", "get", "GATE_MODE"])
    .then(parseGateMode)
    .catch((): GateMode => "unknown");

  return {
    currentBranch,
    isClean,
    branchExists: branches !== "",
    remote,
    worktreePath,
    issue,
    gateMode,
    gateOk: gate?.ok === true,
    // A precondition that does not say how to satisfy it costs the caller a
    // guess, and here the guess is expensive: the ledger is only written when a
    // gate run is TOLD its ticket, so a green run without `--issue` leaves no
    // evidence and the merge blocks on a gate that demonstrably passed
    // (`production-cockpit#775` paid for one full re-run to find this out).
    gateDetail:
      gate === undefined
        ? `no green "${MERGE_GATE_PROFILE}" gate recorded for #${options.issue} in the ledger — ` +
          `run: spec-sync gate --profile ${MERGE_GATE_PROFILE} --issue ${options.issue}`
        : `gate at ${gate.at} was ${gate.ok === true ? "green" : "red"}`,
  };
}

/**
 * The path of the **disposable** worktree checked out on `branch`, if one exists.
 *
 * `git worktree list` always names the MAIN working tree first, and that one is
 * never a ticket worktree — it is the repository itself. An agent that worked in
 * the main checkout instead of a worktree would otherwise have `merge` plan
 * `git worktree remove <repo>` as its last step: git refuses that, so nothing is
 * destroyed, but the refusal lands AFTER the push and the issue was closed and
 * leaves the merge half-done. Measured on `production-cockpit#775`.
 */
async function findWorktree(deps: MergeDeps, branch: string): Promise<string | undefined> {
  const porcelain = await deps.git(["worktree", "list", "--porcelain"]);
  let path: string | undefined;
  let seen = 0;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      seen += 1;
      path = line.slice("worktree ".length).trim();
    } else if (line.trim() === `branch refs/heads/${branch}`) {
      return seen === 1 ? undefined : path;
    }
  }
  return undefined;
}

/** The preconditions of §7.4. All of them are reported, not just the first. */
export function preconditions(facts: Facts, options: MergeOptions, norms: Norms): Check[] {
  const labels = (facts.issue.labels ?? []).map((label) => label.name);
  return [
    {
      // In remote mode `main` moves only through pull requests (PROC-DEV-044,
      // `SST-DESIGN-019` rev 3): the local sequence is not admissible, however
      // green the local evidence. The detail names the way, as §7.4 demands.
      name: "gate-mode-local",
      ok: facts.gateMode !== "remote",
      detail:
        facts.gateMode === "remote"
          ? `GATE_MODE=remote — ${MAIN_BRANCH} moves only through pull requests: push the branch, open a PR, poll "pr-gate" in the foreground (gh pr checks <nr>, no monitor) while the next disjoint ticket builds, and merge with gh pr merge <nr> --squash --delete-branch`
          : undefined,
    },
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

/** The `gh issue edit` arguments that move the ticket to exactly one status. */
export function labelArgs(facts: Facts, options: MergeOptions): string[] {
  const args = ["issue", "edit", String(options.issue), "--add-label", DONE_LABEL];
  for (const stale of staleStatusLabels(facts)) args.push("--remove-label", stale);
  return args;
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
      cmd: `gh ${labelArgs(facts, options)
        .map((arg) => (arg.includes(" ") ? JSON.stringify(arg) : arg))
        .join(" ")}`,
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

/**
 * Executes one named step. The switch is the single definition of what a step
 * *does*, so the full sequence and the resume path can never drift apart: both
 * walk `MergeStep[]`, the first the whole plan, the second a subset of it.
 */
async function runStep(
  deps: MergeDeps,
  facts: Facts,
  options: MergeOptions,
  name: string,
): Promise<void> {
  switch (name) {
    case "squash-merge":
      await deps.git(["merge", "--squash", options.branch]);
      return;
    case "commit":
      await deps.git(["commit", "-m", commitMessage(options.issue, facts.issue.title)]);
      return;
    case "push":
      await deps.git(["push", facts.remote ?? "origin", MAIN_BRANCH]);
      return;
    case "label-issue":
      await deps.gh(labelArgs(facts, options));
      return;
    case "close-issue":
      await deps.gh(["issue", "close", String(options.issue)]);
      return;
    case "remove-worktree":
      if (facts.worktreePath !== undefined)
        await deps.git(["worktree", "remove", facts.worktreePath]);
      return;
    case "delete-branch":
      await deps.git(["branch", "-D", options.branch]);
      return;
    default:
      throw new ToolkitError(`unknown merge step "${name}"`, EXIT.FAILED);
  }
}

async function execute(
  deps: MergeDeps,
  facts: Facts,
  options: MergeOptions,
  steps: MergeStep[],
): Promise<void> {
  for (const step of steps) await runStep(deps, facts, options, step.name);
}

/**
 * Which step repairs which postcondition — the whole map the resume path needs.
 *
 * `worktree-clean` is deliberately absent: no step of §7.4 cleans a working
 * tree, so a dirty tree after a half-finished merge is a diagnosis for the
 * driver, not something to re-run.
 */
const REPAIRS: Record<string, readonly string[]> = {
  "commit-on-main": ["squash-merge", "commit"],
  pushed: ["push"],
  "issue-closed": ["label-issue", "close-issue"],
  "worktree-removed": ["remove-worktree"],
  "branch-deleted": ["delete-branch"],
};

/**
 * The steps still missing, in the order of §7.4. A postcondition that already
 * holds contributes nothing — that is what makes a resume idempotent: run it
 * twice and the second run finds nothing left to do.
 */
export function remainingSteps(failed: Check[], steps: MergeStep[]): MergeStep[] {
  const wanted = new Set(failed.flatMap((check) => REPAIRS[check.name] ?? []));
  return steps.filter((step) => wanted.has(step.name));
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
  // On the resume path this runs BEFORE the push, so `<remote>/main` may not
  // exist yet — git answers that with an error, not with a number. An
  // unreadable ref is the strongest possible evidence for "not pushed", and
  // reporting it as such keeps the resume able to repair it; letting the raw
  // git error escape would end the run with exit 1 and no verdict at all.
  const unpushed = await deps
    .git(["rev-list", "--count", `${remote}/${MAIN_BRANCH}..${MAIN_BRANCH}`])
    .then((out) => out.trim())
    .catch(() => undefined);
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
        unpushed === "0"
          ? undefined
          : unpushed === undefined
            ? `${remote}/${MAIN_BRANCH} is unreadable — nothing was pushed there yet`
            : `${unpushed} commit(s) not on ${remote}/${MAIN_BRANCH}`,
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

/**
 * Resumes a merge whose `merge-started` never got its `merge-completed`
 * (spec §7.4, `DECISION (merge-resumable)`).
 *
 * The preconditions are deliberately **not** checked here: a merge that died
 * after the push violates half of them by construction — the issue is closed,
 * the branch may be gone — and failing on them is precisely the dead end this
 * path exists to remove. The postconditions replace them: they describe the
 * target state, so what they report missing is exactly what is left to do.
 */
async function resume(deps: MergeDeps, facts: Facts, options: MergeOptions): Promise<MergeResult> {
  const before = await postconditions(deps, facts, options);
  const open = before.filter((check) => !check.ok);
  const steps = remainingSteps(open, plan(facts, options));

  if (options.dryRun) {
    return {
      ok: true,
      notes: [
        steps.length === 0
          ? "resume dry run — every postcondition already holds, nothing left to do"
          : `resume dry run — ${steps.length} step(s) left of an interrupted merge, nothing changed`,
      ],
      data: {
        issue: options.issue,
        branch: options.branch,
        resumed: true,
        dryRun: true,
        steps,
        postconditions: open,
      },
    };
  }

  await execute(deps, facts, options, steps);
  // Nothing ran, nothing can have changed — re-querying would only cost calls.
  const after = steps.length === 0 ? before : await postconditions(deps, facts, options);
  const failed = after.filter((check) => !check.ok);

  appendEvent(deps.repoRoot, {
    type: failed.length === 0 ? "merge-completed" : "blocked",
    issue: options.issue,
    run: options.run,
    ok: failed.length === 0,
    branch: options.branch,
    resumed: true,
    ...(failed.length === 0 ? {} : { reason: failed.map((check) => check.name).join(", ") }),
  });

  return {
    ok: failed.length === 0,
    exit: failed.length === 0 ? EXIT.OK : EXIT.FAILED,
    notes:
      failed.length === 0
        ? [
            steps.length === 0
              ? "resumed an interrupted merge — every postcondition already held"
              : `resumed an interrupted merge — ${steps.length} missing step(s) executed`,
          ]
        : [
            `${failed.length} postcondition(s) still failing after the resume — repo needs diagnosis`,
          ],
    data: {
      issue: options.issue,
      branch: options.branch,
      resumed: true,
      steps,
      postconditions: failed.length === 0 ? after : failed,
    },
  };
}

export async function runMerge(
  deps: MergeDeps,
  options: MergeOptions,
  norms: Norms = loadNorms().norms,
): Promise<MergeResult> {
  const events = readLedger(deps.repoRoot).events;
  const facts = await gather(deps, options, events);

  // Before the preconditions, because a half-finished merge fails them by
  // construction — see `resume`.
  if (interruptedMerge(events, options.issue) !== undefined) {
    return resume(deps, facts, options);
  }

  const checks = preconditions(facts, options, norms);
  const violated = checks.filter((check) => !check.ok);
  const steps = plan(facts, options);

  if (violated.length > 0) {
    // Not a merge verdict — only the statement that a merge is not mechanically
    // admissible yet. The driver fixes the cause and calls again.
    //
    // A dry run writes nothing: §7.4 binds `--dry-run` to "changes nothing", and
    // the ledger is part of the repo, not a log. A phantom `blocked` from a
    // question nobody acted on would surface in `report`'s open list.
    if (!options.dryRun) {
      appendEvent(deps.repoRoot, {
        type: "blocked",
        issue: options.issue,
        run: options.run,
        reason: violated.map((check) => check.name).join(", "),
      });
    }
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

  await execute(deps, facts, options, steps);
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
