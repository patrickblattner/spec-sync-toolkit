/**
 * `review` — Codex second opinion (SST-DESIGN-030, PROC-DEV-049).
 *
 *   spec-sync review pr <n> [--issue <t>] [--recheck]
 *   spec-sync review batch [--dry-run]
 *   spec-sync review tag <from>..<to>
 *   spec-sync review verdict <pr|issue> <n> <id> (accepted (fixed|ticket <t>) | rejected "<reason>") [--source claude:<lens>]
 *
 * The only way any repo calls Codex. It triages, calls `codex exec` read-only,
 * parses a strict result, posts it, and logs one ledger event. It never edits
 * code, never merges, never calls the spec server, and never falls back to
 * another model.
 *
 * Exit: 0 ran (clean, non-blocking findings, skipped, not triaged) · 1 a
 * critical or high finding is open · 4 precondition failed. A skip is never 2.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command, CommandContext, CommandResult } from "../cli.js";
import type { Config, ReviewConfig } from "../config.js";
import { appendEvent, readLedger } from "../ledger.js";
import { createLogDir, protectedLogDirs } from "../logs.js";
import { EXIT, ToolkitError } from "../output.js";
import { checkFlags, positionals, valueFlag } from "../pack/args.js";
import { defaultTools, failureLine, type RunResult, type Tools } from "../pack/exec.js";
import {
  batchIssueTitle,
  hasReviewMarker,
  latestReviewMarker,
  REVIEW_MARKER,
  renderBatchIssue,
  renderRecheckComment,
  renderReviewComment,
  renderSkipLine,
  renderTagIssue,
  renderVerdictComment,
  tagIssueTitle,
  type MarkerFinding,
  type Verdict,
} from "../review/comment.js";
import { runCodex, type FailureClass } from "../review/engine.js";
import {
  assignFindings,
  countFindings,
  dedupeKey,
  findingLine,
  isBlocking,
  isTicketed,
  parseResult,
  partitionFindings,
  reviewKeysOf,
  type Counts,
  type Finding,
  type RawFinding,
  type RecheckEntry,
} from "../review/findings.js";
import { moveMarker, readMarker } from "../review/marker.js";
import { renderPrompt } from "../review/prompt.js";
import { decide, decideAlways, newModule, parseNumstat, sizeOf } from "../review/triage.js";

const VALUE_FLAGS = ["--issue", "--source"];
const PR_BASE = "origin/main";
const MAIN = "origin/main";

export interface ReviewDeps {
  tools: Tools;
  /** Environment of the codex child — tests put a fake `codex` on PATH here. */
  codexEnv?: NodeJS.ProcessEnv;
}

export const reviewCommand: Command = {
  name: "review",
  summary: "Codex second opinion: pr, batch, tag, verdict",
  needsConfig: true,
  run: (ctx) => runReview(ctx, { tools: defaultTools(ctx.repoRoot) }),
};

type Outcome = "findings" | "clean" | "skipped" | "not-triaged";

interface Run {
  ctx: CommandContext;
  deps: ReviewDeps;
  review: ReviewConfig;
  config: Config;
  startedAt: number;
}

export async function runReview(ctx: CommandContext, deps: ReviewDeps): Promise<CommandResult> {
  const config = ctx.config as Config;
  const pos = positionals(ctx.args, VALUE_FLAGS);
  const run: Run = { ctx, deps, review: config.review, config, startedAt: Date.now() };
  switch (pos[0]) {
    case "pr":
      return runPr(run, pos);
    case "batch":
      return runBatch(run, pos);
    case "tag":
      return runTag(run, pos);
    case "verdict":
      return runVerdict(run, pos);
    default:
      throw new ToolkitError(
        `review needs a subcommand — pr, batch, tag or verdict`,
        EXIT.PRECONDITION,
        { field: "subcommand" },
      );
  }
}

// ---------------------------------------------------------------- pr

async function runPr(run: Run, pos: string[]): Promise<CommandResult> {
  const { ctx, deps, review } = run;
  checkFlags(ctx.args, ["--issue"], ["--recheck"]);
  if (pos.length !== 2) usage("review pr <n> [--issue <t>] [--recheck]", "pr");
  const pr = positiveInt(pos[1], "pr");
  const issueFlag = valueFlag(ctx.args, "--issue");
  const issue = issueFlag === undefined ? undefined : positiveInt(issueFlag, "--issue");
  const recheck = ctx.args.includes("--recheck");
  const mode = recheck ? "recheck" : "pr";

  const view = gh(deps.tools, ["pr", "view", String(pr), "--json", "headRefOid,comments"], "pr");
  const prData = parseJson<{ headRefOid?: string; comments?: { body?: string }[] }>(
    view.stdout,
    "pr",
  );
  const head = git(deps.tools, ["rev-parse", "HEAD"], "HEAD").stdout.trim();
  if (prData.headRefOid !== head) {
    throw new ToolkitError(
      `HEAD ${head.slice(0, 12)} is not the head of PR #${pr} (${String(prData.headRefOid).slice(0, 12)}) — run in the PR's worktree`,
      EXIT.PRECONDITION,
      { field: "HEAD" },
    );
  }

  const range = `${PR_BASE}...HEAD`;
  const entries = parseNumstat(
    git(deps.tools, ["diff", "--numstat", "--no-renames", range], PR_BASE).stdout,
  );
  const files = entries.map((entry) => entry.file);
  const size = sizeOf(entries, review.textGlobs);
  const base = { mode, pr, range, files: size.files, lines: size.lines };

  let model: string;
  let effort: string;
  let trigger: string;
  let areas: string[];
  const prior = recheck
    ? latestReviewMarker((prData.comments ?? []).map((comment) => comment.body ?? ""))
    : undefined;
  if (recheck) {
    if (prior === undefined) {
      throw new ToolkitError(
        `PR #${pr} carries no ${REVIEW_MARKER} marker — nothing to recheck`,
        EXIT.PRECONDITION,
        { field: "--recheck" },
      );
    }
    ({ model, trigger } = prior);
    // Markers written before `effort` existed: the effort of the model kind.
    effort =
      prior.effort ?? (model === review.models.risk ? review.effort.risk : review.effort.size);
    areas = [];
  } else {
    const decision = decide(entries, isNewModule(deps.tools, review, range), review);
    if (!decision.triaged) {
      if (!ctx.flags.dryRun) {
        ledger(run, { issue, pr, mode, trigger: "not-triaged", outcome: "not-triaged" });
      }
      return {
        ok: true,
        exit: EXIT.OK,
        notes: ["no risk area, below the size thresholds — no Codex call"],
        data: { ...base, outcome: "not-triaged", trigger: "not-triaged" },
      };
    }
    ({ model, effort, trigger, areas } = decision);
  }

  if (ctx.flags.dryRun) {
    return {
      ok: true,
      notes: ["dry run — no Codex call, no comment, no ledger event"],
      data: { ...base, model, effort, trigger, outcome: "dry-run" },
    };
  }

  const logDir = newLogDir(run);
  const diff = git(deps.tools, ["diff", range], PR_BASE).stdout;
  const prompt = renderPrompt({
    REPO: run.config.project,
    MODE: mode,
    RANGE: range,
    AREAS: areas.length === 0 ? "none" : areas.join(", "),
    FILES: files.join("\n"),
    DIFF: diff,
    PRIOR: prior === undefined ? "none" : JSON.stringify(prior.findings, null, 2),
  });
  const answer = callEngine(run, logDir, model, effort, prompt, "codex");

  if (!answer.ok) {
    const notes = [`skipped — ${answer.class}: ${answer.detail}`];
    const posted = postComment(
      deps.tools,
      run,
      logDir,
      "pr",
      pr,
      renderSkipLine(answer.class, model),
    );
    if (posted !== undefined) notes.push(`skip line not posted: ${posted}`);
    ledger(run, {
      issue,
      pr,
      mode,
      model,
      effort,
      trigger,
      outcome: "skipped",
      class: answer.class,
      overrunMs: overrun(deps.tools, pr),
    });
    return {
      ok: true,
      exit: EXIT.OK,
      notes,
      logDir,
      data: { ...base, model, effort, trigger, outcome: "skipped", class: answer.class },
    };
  }

  const notes: string[] = [];
  let body: string;
  let open: { severity: Finding["severity"] }[];
  let listed: string[];
  let downgraded: string[] = [];
  if (prior !== undefined) {
    const byId = new Map(answer.recheck.map((entry) => [entry.id, entry]));
    const stillOpen: MarkerFinding[] = prior.findings.filter(
      (finding) => byId.get(finding.id)?.resolved !== true,
    );
    if (answer.findings.length > 0) {
      notes.push(`${answer.findings.length} new finding(s) in the recheck answer were ignored`);
    }
    body = renderRecheckComment({
      prior,
      effort,
      head,
      range,
      durationMs: answer.durationMs,
      recheck: answer.recheck,
      open: stillOpen,
    });
    open = stillOpen;
    listed = stillOpen.map((f) => `${f.id} ${f.severity} ${f.area} ${f.file}:${f.line} — open`);
  } else {
    const assigned = assignFindings(answer.findings);
    downgraded = assigned.downgraded;
    body = renderReviewComment({
      pr,
      head,
      model,
      effort,
      trigger,
      round: 1,
      range,
      files: size.files,
      lines: size.lines,
      durationMs: answer.durationMs,
      findings: assigned.findings,
      downgraded,
    });
    open = assigned.findings;
    listed = assigned.findings.map(findingLine);
  }

  const failed = postComment(deps.tools, run, logDir, "pr", pr, body);
  if (failed !== undefined) throw new Error(`PR comment not posted: ${failed}`);

  const counts = countFindings(open);
  const outcome: Outcome = open.length > 0 ? "findings" : "clean";
  ledger(run, {
    issue,
    pr,
    mode,
    model,
    effort,
    trigger,
    outcome,
    counts,
    overrunMs: overrun(deps.tools, pr),
  });
  const blocking = open.some(isBlocking);
  return {
    ok: !blocking,
    exit: blocking ? EXIT.FAILED : EXIT.OK,
    notes,
    logDir,
    data: { ...base, model, effort, trigger, outcome, counts, findings: listed, downgraded },
  };
}

/** An added `package.json`, or a new directory under `modulesRoot` (SST-DESIGN-030 §Triage). */
function isNewModule(tools: Tools, review: ReviewConfig, range: string): boolean {
  const added = git(
    tools,
    ["diff", "--name-only", "--diff-filter=A", "--no-renames", range],
    PR_BASE,
  )
    .stdout.split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (added.length === 0) return false;
  let existing = new Set<string>();
  if (review.modulesRoot !== undefined) {
    const mergeBase = git(tools, ["merge-base", PR_BASE, "HEAD"], PR_BASE).stdout.trim();
    const root = review.modulesRoot.replace(/\/+$/, "");
    const tree = tools.run("git", ["ls-tree", "-d", "--name-only", mergeBase, `${root}/`]);
    existing = new Set(
      tree.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .map((line) => line.slice(line.lastIndexOf("/") + 1)),
    );
  }
  return newModule(added, review.modulesRoot, existing);
}

/** Review end minus pr-gate `completedAt` (PROC-DEV-002 time budget). */
function overrun(tools: Tools, pr: number): number | undefined {
  // `gh pr checks` exits non-zero while checks are pending; its JSON still counts.
  const result = tools.run("gh", ["pr", "checks", String(pr), "--json", "name,completedAt"]);
  let checks: { name?: string; completedAt?: string }[];
  try {
    checks = JSON.parse(result.stdout) as { name?: string; completedAt?: string }[];
  } catch {
    return undefined;
  }
  const gate = checks.find((check) => check.name === "pr-gate");
  const completed = Date.parse(gate?.completedAt ?? "");
  if (!Number.isFinite(completed) || new Date(completed).getUTCFullYear() < 2000) return undefined;
  return Date.now() - completed;
}

// ---------------------------------------------------------------- batch

interface Chunk {
  range: string;
  files: string[];
  diff: string;
}

async function runBatch(run: Run, pos: string[]): Promise<CommandResult> {
  const { ctx, deps, review } = run;
  checkFlags(ctx.args, []);
  if (pos.length !== 1) usage("review batch [--dry-run]", "batch");
  const tools = deps.tools;

  const from = readMarker(tools, review.marker);
  if (from === undefined) {
    throw new ToolkitError(
      `marker ${review.marker} does not exist — set it once to the current main (git tag ${review.marker} origin/main && git push origin refs/tags/${review.marker})`,
      EXIT.PRECONDITION,
      { field: "review.marker" },
    );
  }
  const to = git(tools, ["rev-parse", "--verify", `${MAIN}^{commit}`], MAIN).stdout.trim();
  const range = `${review.marker}..${MAIN}`;
  const commits = lines(
    git(tools, ["rev-list", "--reverse", "--first-parent", `${from}..${to}`], review.marker).stdout,
  );

  // PRs that Codex already saw under trigger 1 carry the marker comment.
  const reviewedCommits = new Set<string>();
  const reviewedPrs: number[] = [];
  if (commits.length > 0) {
    const list = gh(
      tools,
      [
        "pr",
        "list",
        "--state",
        "merged",
        "--base",
        "main",
        "--limit",
        "300",
        "--json",
        "number,mergeCommit,comments",
      ],
      "gh",
    );
    const prs = parseJson<
      { number: number; mergeCommit?: { oid?: string }; comments?: { body?: string }[] }[]
    >(list.stdout, "gh");
    const inRange = new Set(commits);
    for (const pr of prs) {
      const oid = pr.mergeCommit?.oid;
      if (oid === undefined || !inRange.has(oid)) continue;
      if ((pr.comments ?? []).some((comment) => hasReviewMarker(comment.body ?? ""))) {
        reviewedCommits.add(oid);
        reviewedPrs.push(pr.number);
      }
    }
  }
  const included = commits.filter((sha) => !reviewedCommits.has(sha));
  const base = {
    mode: "batch",
    range,
    from,
    to,
    commits: commits.length,
    reviewedPrs,
  };

  if (included.length === 0) {
    const notes = [
      commits.length === 0
        ? `nothing merged since ${review.marker}`
        : "every merge in range was already reviewed",
    ];
    if (ctx.flags.dryRun) return { ok: true, notes, data: { ...base, outcome: "dry-run" } };
    if (commits.length > 0) moveOrThrow(tools, review.marker, to);
    ledger(run, { mode: "batch", trigger: "not-triaged", outcome: "not-triaged" });
    return {
      ok: true,
      exit: EXIT.OK,
      notes,
      data: { ...base, outcome: "not-triaged", markerMoved: commits.length > 0 },
    };
  }

  const chunks = buildChunks(tools, from, to, included, included.length === commits.length, review);
  const files = [...new Set(chunks.flatMap((chunk) => chunk.files))];
  const { model, effort, trigger, areas } = decideAlways(files, review);
  const plan = {
    ...base,
    included: included.length,
    chunks: chunks.length,
    model,
    effort,
    trigger,
  };

  if (ctx.flags.dryRun) {
    return {
      ok: true,
      notes: ["dry run — no Codex call, no issues, marker stays"],
      data: { ...plan, outcome: "dry-run" },
    };
  }

  const logDir = newLogDir(run);
  const result = runChunks(run, logDir, "batch", chunks, model, effort, areas);
  const notes: string[] = [];
  if (result.skipped !== undefined) {
    notes.push(
      `skipped — ${result.skipped.class}: ${result.skipped.detail}; marker stays at ${from.slice(0, 12)}`,
    );
  }

  // Critical, high and medium become issues, deduplicated by review-key.
  const ticketed = result.findings.filter(isTicketed);
  const created: string[] = [];
  let duplicates = 0;
  if (ticketed.length > 0) {
    const open = gh(
      tools,
      [
        "issue",
        "list",
        "--label",
        review.label,
        "--state",
        "open",
        "--limit",
        "500",
        "--json",
        "body",
      ],
      "gh",
    );
    const keys = reviewKeysOf(
      parseJson<{ body?: string }[]>(open.stdout, "gh").map((issue) => issue.body ?? ""),
    );
    const parts = partitionFindings(ticketed, keys);
    duplicates = parts.duplicates.length;
    for (const finding of parts.fresh) {
      const body = renderBatchIssue(finding, { model, range, key: dedupeKey(finding) });
      const labels =
        finding.area === "security" ? [review.label, review.securityLabel] : [review.label];
      created.push(
        createIssue(tools, run, logDir, batchIssueTitle(finding), body, labels, finding.id),
      );
    }
  }

  let markerMoved = false;
  if (result.skipped === undefined) {
    moveOrThrow(tools, review.marker, to);
    markerMoved = true;
  }

  const counts = countFindings(result.findings);
  const outcome: Outcome =
    result.skipped !== undefined ? "skipped" : result.findings.length > 0 ? "findings" : "clean";
  ledger(run, {
    mode: "batch",
    model,
    effort,
    trigger,
    outcome,
    class: result.skipped?.class,
    counts,
  });
  const blocking = result.findings.some(isBlocking);
  return {
    ok: !blocking,
    exit: blocking ? EXIT.FAILED : EXIT.OK,
    notes,
    logDir,
    data: {
      ...plan,
      outcome,
      class: result.skipped?.class,
      counts,
      findings: result.findings.filter(isTicketed).map(findingLine),
      low: result.findings.filter((f) => f.severity === "low").map(findingLine),
      taste: result.findings.filter((f) => f.severity === "taste").map(findingLine),
      downgraded: result.downgraded,
      issues: created,
      duplicates,
      markerMoved,
    },
  };
}

function moveOrThrow(tools: Tools, marker: string, target: string): void {
  const moved = moveMarker(tools, marker, target);
  if (!moved.ok) throw new Error(moved.detail);
}

/**
 * One chunk for the whole range when every commit is included and the diff
 * fits `maxDiffBytes`; otherwise one diff per commit, grouped greedily up to
 * `maxDiffBytes` (a single commit larger than that is sent alone).
 */
function buildChunks(
  tools: Tools,
  from: string,
  to: string,
  commits: readonly string[],
  whole: boolean,
  review: ReviewConfig,
): Chunk[] {
  if (whole) {
    const diff = git(tools, ["diff", `${from}..${to}`], "range").stdout;
    if (Buffer.byteLength(diff) <= review.maxDiffBytes) {
      const files = lines(
        git(tools, ["diff", "--name-only", "--no-renames", `${from}..${to}`], "range").stdout,
      );
      return [{ range: `${from.slice(0, 12)}..${to.slice(0, 12)}`, files, diff }];
    }
  }
  const chunks: Chunk[] = [];
  let current: { shas: string[]; files: Set<string>; diff: string } | undefined;
  const flush = (): void => {
    if (current === undefined) return;
    const first = current.shas[0] as string;
    const last = current.shas[current.shas.length - 1] as string;
    chunks.push({
      range:
        current.shas.length === 1
          ? first.slice(0, 12)
          : `${first.slice(0, 12)}^..${last.slice(0, 12)} (${current.shas.length} commits)`,
      files: [...current.files],
      diff: current.diff,
    });
    current = undefined;
  };
  for (const sha of commits) {
    const diff = git(tools, ["diff", `${sha}^1`, sha], "range").stdout;
    const files = lines(
      git(tools, ["diff", "--name-only", "--no-renames", `${sha}^1`, sha], "range").stdout,
    );
    if (
      current !== undefined &&
      Buffer.byteLength(current.diff) + Buffer.byteLength(diff) > review.maxDiffBytes
    ) {
      flush();
    }
    current ??= { shas: [], files: new Set(), diff: "" };
    current.shas.push(sha);
    for (const file of files) current.files.add(file);
    current.diff += diff;
  }
  flush();
  return chunks;
}

interface ChunkResult {
  findings: Finding[];
  downgraded: string[];
  skipped?: { class: FailureClass; detail: string };
}

/** Runs the chunks in order; the first skip ends the run (the rest would fail alike). */
function runChunks(
  run: Run,
  logDir: string,
  mode: string,
  chunks: readonly Chunk[],
  model: string,
  effort: string,
  areas: readonly string[],
): ChunkResult {
  const findings: Finding[] = [];
  const downgraded: string[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const prompt = renderPrompt({
      REPO: run.config.project,
      MODE: mode,
      RANGE: chunk.range,
      AREAS: areas.length === 0 ? "none" : areas.join(", "),
      FILES: chunk.files.join("\n"),
      DIFF: chunk.diff,
      PRIOR: "none",
    });
    const answer = callEngine(run, logDir, model, effort, prompt, `codex-${index + 1}`);
    if (!answer.ok) {
      return { findings, downgraded, skipped: { class: answer.class, detail: answer.detail } };
    }
    const assigned = assignFindings(answer.findings, findings.length + 1);
    findings.push(...assigned.findings);
    downgraded.push(...assigned.downgraded);
  }
  return { findings, downgraded };
}

// ---------------------------------------------------------------- tag

async function runTag(run: Run, pos: string[]): Promise<CommandResult> {
  const { ctx, deps, review } = run;
  checkFlags(ctx.args, []);
  const spec = pos[1] ?? "";
  const match = /^([^.].*?)\.\.([^.].*)$/.exec(spec);
  if (pos.length !== 2 || match === null) usage("review tag <from>..<to>", "range");
  const fromRef = match?.[1] as string;
  const toRef = match?.[2] as string;
  const tools = deps.tools;
  const from = git(tools, ["rev-parse", "--verify", `${fromRef}^{commit}`], "range").stdout.trim();
  const to = git(tools, ["rev-parse", "--verify", `${toRef}^{commit}`], "range").stdout.trim();

  const title = tagIssueTitle(toRef);
  const existing = gh(
    tools,
    [
      "issue",
      "list",
      "--label",
      review.label,
      "--state",
      "all",
      "--search",
      `"${title}" in:title`,
      "--limit",
      "100",
      "--json",
      "number,title",
    ],
    "gh",
  );
  const already = parseJson<{ number: number; title: string }[]>(existing.stdout, "gh").find(
    (issue) => issue.title === title,
  );
  const base = { mode: "tag", range: spec, title };
  if (already !== undefined) {
    return {
      ok: true,
      exit: EXIT.OK,
      notes: [`tag ${toRef} already reviewed in #${already.number} — one issue per tag`],
      data: { ...base, outcome: "already-reviewed", issue: already.number },
    };
  }

  const commits = lines(
    git(tools, ["rev-list", "--reverse", "--first-parent", `${from}..${to}`], "range").stdout,
  );
  if (commits.length === 0) {
    return {
      ok: true,
      exit: EXIT.OK,
      notes: [`${spec} is empty — no Codex call, no issue`],
      data: { ...base, outcome: "not-triaged" },
    };
  }
  const chunks = buildChunks(tools, from, to, commits, true, review);
  const files = [...new Set(chunks.flatMap((chunk) => chunk.files))];
  const { model, effort, trigger, areas } = decideAlways(files, review);
  const plan = { ...base, files: files.length, chunks: chunks.length, model, effort, trigger };

  if (ctx.flags.dryRun) {
    return {
      ok: true,
      notes: ["dry run — no Codex call, no issue"],
      data: { ...plan, outcome: "dry-run" },
    };
  }

  const logDir = newLogDir(run);
  const result = runChunks(run, logDir, "tag", chunks, model, effort, areas);
  if (result.skipped !== undefined) {
    ledger(run, {
      mode: "tag",
      model,
      effort,
      trigger,
      outcome: "skipped",
      class: result.skipped.class,
    });
    return {
      ok: true,
      exit: EXIT.OK,
      notes: [
        `skipped — ${result.skipped.class}: ${result.skipped.detail}; no issue opened, rerun to review ${toRef}`,
      ],
      logDir,
      data: { ...plan, outcome: "skipped", class: result.skipped.class },
    };
  }

  const counts = countFindings(result.findings);
  const body = renderTagIssue({
    model,
    trigger,
    range: spec,
    files: files.length,
    durationMs: Date.now() - run.startedAt,
    counts,
    findings: result.findings,
    downgraded: result.downgraded,
  });
  const labels = result.findings.some((f) => f.area === "security")
    ? [review.label, review.securityLabel]
    : [review.label];
  const issue = createIssue(tools, run, logDir, title, body, labels, "tag");

  const outcome: Outcome = result.findings.length > 0 ? "findings" : "clean";
  ledger(run, { mode: "tag", model, effort, trigger, outcome, counts });
  const blocking = result.findings.some(isBlocking);
  return {
    ok: !blocking,
    exit: blocking ? EXIT.FAILED : EXIT.OK,
    notes: [],
    logDir,
    data: {
      ...plan,
      outcome,
      counts,
      issue,
      findings: result.findings.map(findingLine),
      downgraded: result.downgraded,
    },
  };
}

// ---------------------------------------------------------------- verdict

async function runVerdict(run: Run, pos: string[]): Promise<CommandResult> {
  const { ctx, deps } = run;
  checkFlags(ctx.args, ["--source"]);
  const form =
    'review verdict <pr|issue> <n> <id> (accepted (fixed|ticket <t>) | rejected "<reason>") [--source claude:<lens>]';
  const [, target, numberText, finding, word, ...rest] = pos;
  if (target !== "pr" && target !== "issue") usage(form, "target");
  const number = positiveInt(numberText, "number");
  if (finding === undefined || finding.trim() === "") usage(form, "id");

  let verdict: Verdict;
  if (word === "accepted" && rest.length === 1 && rest[0] === "fixed") {
    verdict = { verdict: "accepted", resolution: "fixed" };
  } else if (word === "accepted" && rest.length === 2 && rest[0] === "ticket") {
    verdict = { verdict: "accepted", resolution: "ticket", ticket: positiveInt(rest[1], "ticket") };
  } else if (word === "rejected" && rest.length === 1 && (rest[0] ?? "").trim() !== "") {
    verdict = { verdict: "rejected", reason: (rest[0] as string).trim() };
  } else {
    usage(form, "verdict");
  }

  const source = valueFlag(ctx.args, "--source") ?? "codex";
  if (source !== "codex" && !/^claude:[A-Za-z0-9_-]+$/.test(source)) {
    throw new ToolkitError(`--source must be claude:<lens>, got "${source}"`, EXIT.PRECONDITION, {
      field: "--source",
    });
  }

  const body = renderVerdictComment({
    target: target as "pr" | "issue",
    number,
    finding: finding as string,
    source,
    verdict,
  });
  if (ctx.flags.dryRun) {
    return {
      ok: true,
      notes: ["dry run — verdict not posted"],
      data: { target, number, finding, source, ...verdict },
    };
  }
  const logDir = newLogDir(run);
  const failed = postComment(deps.tools, run, logDir, target as "pr" | "issue", number, body);
  if (failed !== undefined) throw new Error(`verdict not posted: ${failed}`);
  return {
    ok: true,
    exit: EXIT.OK,
    notes: [],
    logDir,
    data: { target, number, finding, source, ...verdict },
  };
}

// ---------------------------------------------------------------- helpers

type EngineAnswer =
  | {
      ok: true;
      findings: RawFinding[];
      recheck: RecheckEntry[];
      durationMs: number;
    }
  | { ok: false; class: FailureClass; detail: string };

/** Engine call plus strict parse: every failure is a class, never a fallback. */
function callEngine(
  run: Run,
  logDir: string,
  model: string,
  effort: string,
  prompt: string,
  name: string,
): EngineAnswer {
  const result = runCodex({
    model,
    effort,
    prompt,
    root: run.ctx.repoRoot,
    logDir: join(run.ctx.repoRoot, logDir),
    timeoutMs: run.review.timeoutMs,
    name,
    env: run.deps.codexEnv,
  });
  if (!result.ok) return { ok: false, class: result.class, detail: result.detail };
  const parsed = parseResult(result.raw);
  if (!parsed.ok) return { ok: false, class: "unparsable", detail: parsed.reason };
  return {
    ok: true,
    findings: parsed.findings,
    recheck: parsed.recheck,
    durationMs: result.durationMs,
  };
}

interface ReviewEvent {
  issue?: number;
  pr?: number;
  mode: string;
  model?: string;
  effort?: string;
  trigger: string;
  outcome: Outcome;
  class?: FailureClass;
  counts?: Counts;
  overrunMs?: number;
}

/** One ledger event per run (SST-DESIGN-030 §Ledger). */
function ledger(run: Run, event: ReviewEvent): void {
  appendEvent(run.ctx.repoRoot, {
    type: "review",
    ...event,
    durationMs: Date.now() - run.startedAt,
  });
}

function newLogDir(run: Run): string {
  return createLogDir(run.ctx.repoRoot, {
    retention: run.config.logRetention,
    keep: protectedLogDirs(readLedger(run.ctx.repoRoot).events),
  });
}

/** Posts a comment via `--body-file`. Returns the failure line, or `undefined` when posted. */
function postComment(
  tools: Tools,
  run: Run,
  logDir: string,
  target: "pr" | "issue",
  number: number,
  body: string,
): string | undefined {
  const file = join(run.ctx.repoRoot, logDir, `comment-${target}-${number}.md`);
  writeFileSync(file, body, "utf8");
  const result = tools.run("gh", [target, "comment", String(number), "--body-file", file]);
  return result.ok ? undefined : failureLine(result);
}

/** Opens one issue via `--body-file`; returns what `gh` printed (the URL). */
function createIssue(
  tools: Tools,
  run: Run,
  logDir: string,
  title: string,
  body: string,
  labels: string[],
  name: string,
): string {
  const file = join(run.ctx.repoRoot, logDir, `issue-${name}.md`);
  writeFileSync(file, body, "utf8");
  const result = tools.run("gh", [
    "issue",
    "create",
    "--title",
    title,
    "--body-file",
    file,
    ...labels.flatMap((label) => ["--label", label]),
  ]);
  if (!result.ok) throw new Error(`gh issue create failed: ${failureLine(result)}`);
  return result.stdout.trim();
}

function git(tools: Tools, args: string[], field: string): RunResult {
  const result = tools.run("git", args);
  if (!result.ok) {
    throw new ToolkitError(
      `git ${args.join(" ")} failed: ${failureLine(result)}`,
      EXIT.PRECONDITION,
      {
        field,
      },
    );
  }
  return result;
}

function gh(tools: Tools, args: string[], field: string): RunResult {
  const result = tools.run("gh", args);
  if (!result.ok) {
    throw new ToolkitError(
      `gh ${args.slice(0, 2).join(" ")} failed: ${failureLine(result)}`,
      EXIT.PRECONDITION,
      { field },
    );
  }
  return result;
}

function parseJson<T>(text: string, field: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ToolkitError(`gh returned no JSON`, EXIT.PRECONDITION, { field });
  }
}

function lines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function positiveInt(value: string | undefined, field: string): number {
  const number = Number(value);
  if (value === undefined || !/^\d+$/.test(value) || number < 1) {
    throw new ToolkitError(
      `${field} must be a positive number, got "${value ?? ""}"`,
      EXIT.PRECONDITION,
      {
        field,
      },
    );
  }
  return number;
}

function usage(form: string, field: string): never {
  throw new ToolkitError(`usage: spec-sync ${form}`, EXIT.PRECONDITION, { field });
}
