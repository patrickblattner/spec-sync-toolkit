import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandContext, CommandResult } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import { runReview } from "../src/commands/review.js";
import { readLedger } from "../src/ledger.js";
import { EXIT, ToolkitError } from "../src/output.js";
import { runProcess, type RunResult, type Tools } from "../src/pack/exec.js";
import { assignFindings, dedupeKey, type RawFinding } from "../src/review/findings.js";
import { renderReviewComment } from "../src/review/comment.js";

/**
 * End to end on real temporary git repositories (with a bare `origin`), a fake
 * `gh` behind the `Tools` seam and a fake executable `codex` on PATH — never
 * the real one (ported from community-platform `mergeReview.test.mjs`).
 */

// ----------------------------------------------------------------- fake codex

interface CodexBehaviour {
  /** Answers per call, in order; the last one repeats. */
  answers?: string[];
  exit?: number;
  stderr?: string;
  /** Model the header claims; defaults to the requested one. */
  headerModel?: string;
  sleepMs?: number;
  /** Do not write the output file. */
  noOutput?: boolean;
}

const FAKE_CODEX = `#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
// stdin is always drained, otherwise the parent hits EPIPE on a large prompt.
let input = "";
try { input = readFileSync(0, "utf8"); } catch {}
const dir = process.env.FAKE_CODEX_DIR;
const behaviour = JSON.parse(readFileSync(join(dir, "behaviour.json"), "utf8"));
const n = readdirSync(dir).filter((f) => f.startsWith("call-")).length;
writeFileSync(join(dir, "call-" + n + ".json"), JSON.stringify({ args, input }));
const model = args[args.indexOf("-m") + 1];
process.stderr.write("OpenAI Codex (fake)\\n--------\\nmodel: " + (behaviour.headerModel ?? model) + "\\n--------\\nuser\\n" + input + "\\n");
if (behaviour.stderr) process.stderr.write(behaviour.stderr + "\\n");
if (behaviour.sleepMs) { const end = Date.now() + behaviour.sleepMs; while (Date.now() < end) {} }
const answers = behaviour.answers ?? ['{"findings":[],"recheck":[]}'];
const out = args[args.indexOf("-o") + 1];
if (!behaviour.noOutput) writeFileSync(out, answers[Math.min(n, answers.length - 1)]);
process.exit(behaviour.exit ?? 0);
`;

/** A directory holding a fake `codex` and its call log; PATH without the real codex. */
function fakeCodex(behaviour: CodexBehaviour, options: { install?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "spec-sync-fake-codex-"));
  writeFileSync(join(dir, "behaviour.json"), JSON.stringify(behaviour));
  if (options.install !== false) {
    writeFileSync(join(dir, "codex"), FAKE_CODEX, { mode: 0o755 });
    chmodSync(join(dir, "codex"), 0o755);
  }
  // Only node's own directory and the system dirs: the real codex lives in
  // /opt/homebrew/bin and must never be reachable from a test.
  const path = [dir, dirname(process.execPath), "/usr/bin", "/bin"].join(":");
  const env = { ...process.env, PATH: path, FAKE_CODEX_DIR: dir };
  const calls = (): { args: string[]; input: string }[] =>
    readdirSync(dir)
      .filter((f) => f.startsWith("call-"))
      .sort((a, b) => Number(a.slice(5, -5)) - Number(b.slice(5, -5)))
      .map(
        (f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as { args: string[]; input: string },
      );
  return { env, calls };
}

it("the test PATH cannot reach a real codex", () => {
  const { env } = fakeCodex({}, { install: false });
  const probe = spawnSync("sh", ["-c", "command -v codex"], { env, encoding: "utf8" });
  expect(probe.stdout.trim()).toBe("");
});

// ----------------------------------------------------------------- repos

function sh(cwd: string, args: string[]): string {
  const result = runProcess("git", args, cwd);
  if (!result.ok) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function commit(root: string, files: Record<string, string>, message: string): string {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  sh(root, ["add", "-A", "--", ...Object.keys(files)]);
  sh(root, ["commit", "-q", "-m", message]);
  return sh(root, ["rev-parse", "HEAD"]);
}

interface Repo {
  root: string;
  origin: string;
}

function repo(review: Record<string, unknown> = {}): Repo {
  const origin = mkdtempSync(join(tmpdir(), "spec-sync-review-origin-"));
  sh(origin, ["init", "-q", "--bare", "-b", "main"]);
  const root = mkdtempSync(join(tmpdir(), "spec-sync-review-repo-"));
  sh(root, ["init", "-q", "-b", "main"]);
  for (const [key, value] of [
    ["user.email", "test@example.invalid"],
    ["user.name", "test"],
    ["commit.gpgsign", "false"],
    ["tag.gpgsign", "false"],
  ]) {
    sh(root, ["config", key as string, value as string]);
  }
  writeFileSync(
    join(root, "spec-sync.config.json"),
    JSON.stringify({
      project: "demo",
      gate: { profiles: { local: ["lint"] }, phases: [{ name: "lint", cmd: "true" }] },
      review,
    }),
  );
  writeFileSync(join(root, ".gitignore"), ".spec-sync/\n");
  commit(root, { "src/a.ts": "export const a = 1;\n", "server/auth/x.ts": "x\n" }, "init");
  sh(root, ["remote", "add", "origin", origin]);
  sh(root, ["push", "-q", "origin", "main"]);
  sh(root, ["fetch", "-q", "origin"]);
  return { root, origin };
}

function push(r: Repo): void {
  sh(r.root, ["push", "-q", "origin", "HEAD:main"]);
  sh(r.root, ["fetch", "-q", "origin"]);
}

// ----------------------------------------------------------------- fake gh

interface GhWorld {
  prHead?: string;
  prComments?: string[];
  merged?: { number: number; oid: string; comments: string[] }[];
  openIssueBodies?: string[];
  tagIssues?: { number: number; title: string }[];
  gateCompletedAt?: string;
}

interface GhLog {
  calls: string[][];
  bodies: string[];
}

function tools(root: string, world: GhWorld): { tools: Tools; gh: GhLog } {
  const log: GhLog = { calls: [], bodies: [] };
  const ok = (stdout: string): RunResult => ({ ok: true, code: 0, stdout, stderr: "" });
  return {
    gh: log,
    tools: {
      run(file, args) {
        if (file === "git") return runProcess(file, args, root);
        expect(file).toBe("gh");
        log.calls.push(args);
        const bodyFile = args[args.indexOf("--body-file") + 1];
        if (args.includes("--body-file") && bodyFile !== undefined) {
          log.bodies.push(readFileSync(bodyFile, "utf8"));
        }
        const [a, b] = args;
        if (a === "pr" && b === "view") {
          return ok(
            JSON.stringify({
              headRefOid: world.prHead,
              comments: (world.prComments ?? []).map((body) => ({ body })),
            }),
          );
        }
        if (a === "pr" && b === "checks") {
          return ok(
            JSON.stringify([{ name: "pr-gate", completedAt: world.gateCompletedAt ?? "" }]),
          );
        }
        if (a === "pr" && b === "list") {
          return ok(
            JSON.stringify(
              (world.merged ?? []).map((pr) => ({
                number: pr.number,
                mergeCommit: { oid: pr.oid },
                comments: pr.comments.map((body) => ({ body })),
              })),
            ),
          );
        }
        if (a === "issue" && b === "list") {
          if (args.includes("all")) return ok(JSON.stringify(world.tagIssues ?? []));
          return ok(JSON.stringify((world.openIssueBodies ?? []).map((body) => ({ body }))));
        }
        if ((a === "pr" || a === "issue") && b === "comment")
          return ok("https://example/comment\n");
        if (a === "issue" && b === "create")
          return ok(`https://example/issues/${100 + log.calls.length}\n`);
        throw new Error(`unexpected gh call: ${args.join(" ")}`);
      },
      spec: () => {
        throw new Error("review must never call the spec server");
      },
    },
  };
}

function context(root: string, args: string[], dryRun = false): CommandContext {
  return {
    flags: { human: false, dryRun },
    args,
    repoRoot: root,
    config: loadConfig(root),
  };
}

async function precondition(call: Promise<unknown>): Promise<ToolkitError> {
  try {
    await call;
  } catch (error) {
    expect(error).toBeInstanceOf(ToolkitError);
    expect((error as ToolkitError).exit).toBe(EXIT.PRECONDITION);
    return error as ToolkitError;
  }
  throw new Error("expected exit 4");
}

const reviewEvents = (root: string) =>
  readLedger(root).events.filter((event) => event.type === "review");

const highFinding: RawFinding = {
  area: "security",
  severity: "high",
  file: "server/auth/x.ts",
  line: 1,
  claim: "Token is not checked",
  scenario: "an expired token logs in",
  evidence: "line 1 skips verify()",
  fix: "call verify()",
};

const answer = (findings: RawFinding[] = [], recheck: unknown[] = []): string =>
  JSON.stringify({ findings, recheck });

/** A PR branch touching the auth risk area. */
function prRepo(review: Record<string, unknown> = { riskGlobs: { auth: ["server/auth/**"] } }) {
  const r = repo(review);
  sh(r.root, ["checkout", "-q", "-b", "feat"]);
  const head = commit(r.root, { "server/auth/x.ts": "changed\n" }, "touch auth");
  return { ...r, head };
}

// ----------------------------------------------------------------- pr

describe("review pr (acceptance 3, 4)", () => {
  it("calls codex read-only with -m and the prompt on stdin, posts one marked comment, exit 1 on high", async () => {
    const r = prRepo();
    const codex = fakeCodex({ answers: [answer([highFinding])] });
    const { tools: t, gh } = tools(r.root, {
      prHead: r.head,
      gateCompletedAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const result = await runReview(context(r.root, ["pr", "12", "--issue", "34"]), {
      tools: t,
      codexEnv: codex.env,
    });

    const [call] = codex.calls();
    expect(codex.calls()).toHaveLength(1);
    expect(call?.args.slice(0, 5)).toEqual(["exec", "--sandbox", "read-only", "-m", "gpt-6-astra"]);
    expect(call?.args).toEqual(
      expect.arrayContaining(["--ephemeral", "--output-schema", "-o", "-C"]),
    );
    expect(call?.args.at(-1)).toBe("-");
    expect(call?.input).toContain("diff --git a/server/auth/x.ts");
    expect(call?.args.some((arg) => arg.includes("diff --git"))).toBe(false);

    expect(result.exit).toBe(EXIT.FAILED);
    expect(result.data).toMatchObject({
      outcome: "findings",
      trigger: "risk:auth",
      model: "gpt-6-astra",
    });
    const comment = gh.bodies[0] ?? "";
    expect(gh.calls.filter((c) => c[1] === "comment")).toHaveLength(1);
    expect(comment).toMatch(/^<!-- spec-sync-review \{.*"model":"gpt-6-astra".*\} -->/);
    expect(comment).toContain("Codex review · gpt-6-astra · risk:auth");

    const [event] = reviewEvents(r.root);
    expect(event).toMatchObject({
      type: "review",
      issue: 34,
      pr: 12,
      mode: "pr",
      model: "gpt-6-astra",
      outcome: "findings",
      counts: { high: 1 },
    });
    expect(event?.overrunMs as number).toBeGreaterThanOrEqual(60_000);
  });

  it("clean result → exit 0", async () => {
    const r = prRepo();
    const codex = fakeCodex({});
    const { tools: t } = tools(r.root, { prHead: r.head });
    const result = await runReview(context(r.root, ["pr", "12"]), {
      tools: t,
      codexEnv: codex.env,
    });
    expect(result.exit).toBe(EXIT.OK);
    expect(result.data).toMatchObject({ outcome: "clean" });
  });

  it.each<[string, CodexBehaviour, { install?: boolean }, Record<string, unknown>]>([
    ["unreachable", {}, { install: false }, {}],
    ["timeout", { sleepMs: 3000 }, {}, { timeoutMs: 300 }],
    [
      "limit",
      { exit: 1, noOutput: true, stderr: "ERROR: usage_limit_reached, try again at 5pm" },
      {},
      {},
    ],
    ["model-switch", { headerModel: "gpt-4-other" }, {}, {}],
    ["unparsable", { answers: ["Here are my findings: none"] }, {}, {}],
    ["unparsable", { exit: 1, noOutput: true, stderr: "boom" }, {}, {}],
  ])(
    "%s → skipped, exit 0, a skip line, a ledger line, no second model",
    async (cls, behaviour, opts, extra) => {
      const r = prRepo({ riskGlobs: { auth: ["server/auth/**"] }, ...extra });
      const codex = fakeCodex(behaviour, opts);
      const { tools: t, gh } = tools(r.root, { prHead: r.head });

      const result = await runReview(context(r.root, ["pr", "12"]), {
        tools: t,
        codexEnv: codex.env,
      });

      expect(result.exit).toBe(EXIT.OK);
      expect(result.data).toMatchObject({ outcome: "skipped", class: cls });
      expect(codex.calls().length).toBeLessThanOrEqual(1);
      expect(codex.calls().every((c) => c.args.includes("gpt-6-astra"))).toBe(true);
      expect(gh.bodies).toEqual([
        `Codex review skipped — ${cls} (gpt-6-astra). No Claude fallback; nightly batch catches up.\n`,
      ]);
      expect(reviewEvents(r.root)).toEqual([
        expect.objectContaining({ outcome: "skipped", class: cls, model: "gpt-6-astra" }),
      ]);
    },
  );

  it("HEAD other than the PR head → exit 4", async () => {
    const r = prRepo();
    const { tools: t } = tools(r.root, { prHead: "0".repeat(40) });
    const error = await precondition(runReview(context(r.root, ["pr", "12"]), { tools: t }));
    expect(error.field).toBe("HEAD");
  });

  it("not triaged → no codex call, no comment, a ledger line", async () => {
    const r = repo({ riskGlobs: { auth: ["server/auth/**"] } });
    sh(r.root, ["checkout", "-q", "-b", "feat"]);
    const head = commit(r.root, { "src/a.ts": "export const a = 2;\n" }, "small");
    const codex = fakeCodex({});
    const { tools: t, gh } = tools(r.root, { prHead: head });
    const result = await runReview(context(r.root, ["pr", "12"]), {
      tools: t,
      codexEnv: codex.env,
    });
    expect(result.exit).toBe(EXIT.OK);
    expect(result.data).toMatchObject({ outcome: "not-triaged" });
    expect(codex.calls()).toHaveLength(0);
    expect(gh.bodies).toEqual([]);
    expect(reviewEvents(r.root)).toEqual([expect.objectContaining({ outcome: "not-triaged" })]);
  });

  it("a new package triggers the size model", async () => {
    const r = repo();
    sh(r.root, ["checkout", "-q", "-b", "feat"]);
    const head = commit(r.root, { "tools/new/package.json": "{}\n" }, "new package");
    const codex = fakeCodex({});
    const { tools: t } = tools(r.root, { prHead: head });
    const result = await runReview(context(r.root, ["pr", "12"]), {
      tools: t,
      codexEnv: codex.env,
    });
    expect(result.data).toMatchObject({ trigger: "size", model: "gpt-5.6-sol" });
  });

  it("a new directory under modulesRoot triggers size; an existing one does not", async () => {
    const r = repo({ modulesRoot: "server" });
    sh(r.root, ["checkout", "-q", "-b", "feat"]);
    const fresh = commit(r.root, { "server/billing/a.ts": "x\n" }, "new module");
    const codex = fakeCodex({});
    let t = tools(r.root, { prHead: fresh }).tools;
    expect(
      (await runReview(context(r.root, ["pr", "1"]), { tools: t, codexEnv: codex.env })).data,
    ).toMatchObject({
      trigger: "size",
    });

    const s = repo({ modulesRoot: "server" });
    sh(s.root, ["checkout", "-q", "-b", "feat"]);
    const old = commit(s.root, { "server/auth/new.ts": "x\n" }, "existing module");
    t = tools(s.root, { prHead: old }).tools;
    expect(
      (await runReview(context(s.root, ["pr", "1"]), { tools: t, codexEnv: codex.env })).data,
    ).toMatchObject({
      outcome: "not-triaged",
    });
  });

  it("--recheck re-asks the marker's model about its findings only", async () => {
    const r = prRepo({});
    const { findings } = assignFindings([highFinding]);
    const prior = renderReviewComment({
      pr: 12,
      head: "old",
      model: "gpt-6-astra",
      trigger: "risk:auth",
      round: 1,
      range: "origin/main...HEAD",
      files: 1,
      lines: 1,
      durationMs: 1,
      findings,
      downgraded: [],
    });
    const codex = fakeCodex({
      answers: [answer([], [{ id: "CX1", resolved: true, note: "verify() added" }])],
    });
    const { tools: t, gh } = tools(r.root, { prHead: r.head, prComments: ["hello", prior] });

    const result = await runReview(context(r.root, ["pr", "12", "--recheck"]), {
      tools: t,
      codexEnv: codex.env,
    });

    const [call] = codex.calls();
    expect(call?.args[call.args.indexOf("-m") + 1]).toBe("gpt-6-astra");
    expect(call?.input).toContain("Mode: recheck");
    expect(call?.input).toContain('"id": "CX1"');
    expect(result.exit).toBe(EXIT.OK);
    expect(result.data).toMatchObject({ mode: "recheck", outcome: "clean" });
    expect(gh.bodies[0]).toMatch(/"round":2/);
    expect(gh.bodies[0]).toContain("resolved");
  });

  it("--recheck without a marker → exit 4", async () => {
    const r = prRepo();
    const { tools: t } = tools(r.root, { prHead: r.head });
    const error = await precondition(
      runReview(context(r.root, ["pr", "12", "--recheck"]), { tools: t }),
    );
    expect(error.field).toBe("--recheck");
  });
});

// ----------------------------------------------------------------- batch

function batchRepo(review: Record<string, unknown> = {}) {
  const r = repo(review);
  sh(r.root, ["tag", "review/last"]);
  sh(r.root, ["push", "-q", "origin", "refs/tags/review/last"]);
  const marker = sh(r.root, ["rev-parse", "HEAD"]);
  const c1 = commit(r.root, { "src/one.ts": "one\n" }, "one (#1)");
  const c2 = commit(r.root, { "src/two.ts": "two\n" }, "two (#2)");
  push(r);
  return { ...r, marker, c1, c2 };
}

const remoteTag = (r: Repo): string =>
  sh(r.root, ["ls-remote", "--tags", "origin", "refs/tags/review/last"]).split(/\s+/)[0] ?? "";

describe("review batch (acceptance 5)", () => {
  it("a missing marker → exit 4", async () => {
    const r = repo();
    const { tools: t } = tools(r.root, {});
    const error = await precondition(runReview(context(r.root, ["batch"]), { tools: t }));
    expect(error.field).toBe("review.marker");
  });

  it("a skip keeps the marker", async () => {
    const r = batchRepo();
    const codex = fakeCodex({ exit: 1, noOutput: true, stderr: "rate_limit_exceeded" });
    const { tools: t } = tools(r.root, {});
    const result = await runReview(context(r.root, ["batch"]), { tools: t, codexEnv: codex.env });
    expect(result.exit).toBe(EXIT.OK);
    expect(result.data).toMatchObject({ outcome: "skipped", class: "limit", markerMoved: false });
    expect(remoteTag(r)).toBe(r.marker);
    expect(reviewEvents(r.root)).toEqual([
      expect.objectContaining({ mode: "batch", outcome: "skipped" }),
    ]);
  });

  it("a clean run moves the marker to origin/main, checked with ls-remote", async () => {
    const r = batchRepo();
    const codex = fakeCodex({});
    const { tools: t } = tools(r.root, {});
    const result = await runReview(context(r.root, ["batch"]), { tools: t, codexEnv: codex.env });
    expect(result.data).toMatchObject({ outcome: "clean", markerMoved: true });
    expect(remoteTag(r)).toBe(r.c2);
  });

  it("excludes PRs that already carry a review marker", async () => {
    const r = batchRepo();
    const codex = fakeCodex({});
    const { tools: t } = tools(r.root, {
      merged: [
        {
          number: 1,
          oid: r.c1,
          comments: ['<!-- spec-sync-review {"v":1,"model":"m","findings":[]} -->'],
        },
        { number: 2, oid: r.c2, comments: ["Codex review skipped — limit (m)."] },
      ],
    });
    const result = await runReview(context(r.root, ["batch"]), { tools: t, codexEnv: codex.env });
    expect(result.data).toMatchObject({ reviewedPrs: [1], included: 1 });
    const [call] = codex.calls();
    expect(call?.input).toContain("src/two.ts");
    expect(call?.input).not.toContain("src/one.ts");
  });

  it("splits by commit when the diff exceeds maxDiffBytes", async () => {
    const r = batchRepo({ maxDiffBytes: 200 });
    const codex = fakeCodex({
      answers: [
        answer([{ ...highFinding, severity: "low" }]),
        answer([{ ...highFinding, severity: "low", claim: "other" }]),
      ],
    });
    const { tools: t } = tools(r.root, {});
    const result = await runReview(context(r.root, ["batch"]), { tools: t, codexEnv: codex.env });
    expect(codex.calls()).toHaveLength(2);
    expect(result.data).toMatchObject({ chunks: 2 });
    // Numbering continues across chunks; low findings only go to the output.
    expect((result.data?.low as string[]).map((line) => line.split(" ")[0])).toEqual([
      "CX1",
      "CX2",
    ]);
  });

  it("files critical/high/medium as issues, deduplicated by review-key; taste is returned", async () => {
    const r = batchRepo();
    const known = { ...highFinding, claim: "Already open" };
    const codex = fakeCodex({
      answers: [
        answer([
          highFinding,
          known,
          { ...highFinding, severity: "medium", area: "code", claim: "Medium one" },
          { ...highFinding, severity: "taste", claim: "Prefer a map" },
          { ...highFinding, claim: "Token  is not\nchecked" },
        ]),
      ],
    });
    const { tools: t, gh } = tools(r.root, {
      openIssueBodies: [`old\n<!-- review-key: ${dedupeKey(known)} -->`],
    });
    const result = await runReview(context(r.root, ["batch"]), { tools: t, codexEnv: codex.env });

    const creates = gh.calls.filter((c) => c[0] === "issue" && c[1] === "create");
    expect(creates).toHaveLength(2);
    expect(creates[0]).toEqual(expect.arrayContaining(["--label", "review-codex", "security"]));
    expect(creates[1]).not.toContain("security");
    expect(gh.bodies[0]).toContain(`<!-- review-key: ${dedupeKey(highFinding)} -->`);
    expect(result.data).toMatchObject({ duplicates: 2, markerMoved: true });
    expect(result.data?.taste as string[]).toHaveLength(1);
    expect(result.exit).toBe(EXIT.FAILED);
  });

  it("--dry-run calls nothing and moves nothing", async () => {
    const r = batchRepo();
    const codex = fakeCodex({});
    const { tools: t, gh } = tools(r.root, {});
    const result = await runReview(context(r.root, ["batch"], true), {
      tools: t,
      codexEnv: codex.env,
    });
    expect(result.data).toMatchObject({ outcome: "dry-run", included: 2 });
    expect(codex.calls()).toHaveLength(0);
    expect(gh.calls.filter((c) => c[1] === "create")).toHaveLength(0);
    expect(remoteTag(r)).toBe(r.marker);
    expect(existsSync(join(r.root, ".spec-sync", "ledger.jsonl"))).toBe(false);
  });
});

// ----------------------------------------------------------------- tag

describe("review tag (acceptance 6)", () => {
  it("opens exactly one issue per tag", async () => {
    const r = repo();
    sh(r.root, ["tag", "v1.0.0"]);
    commit(r.root, { "src/b.ts": "b\n" }, "b");
    sh(r.root, ["tag", "v1.1.0"]);
    const codex = fakeCodex({});
    const first = tools(r.root, {});
    const result = await runReview(context(r.root, ["tag", "v1.0.0..v1.1.0"]), {
      tools: first.tools,
      codexEnv: codex.env,
    });
    const creates = first.gh.calls.filter((c) => c[1] === "create");
    expect(creates).toHaveLength(1);
    expect(creates[0]).toEqual(
      expect.arrayContaining(["--title", "Codex review v1.1.0", "--label", "review-codex"]),
    );
    expect(result.data).toMatchObject({ outcome: "clean" });

    const again = tools(r.root, { tagIssues: [{ number: 9, title: "Codex review v1.1.0" }] });
    const second = await runReview(context(r.root, ["tag", "v1.0.0..v1.1.0"]), {
      tools: again.tools,
      codexEnv: codex.env,
    });
    expect(second.data).toMatchObject({ outcome: "already-reviewed", issue: 9 });
    expect(again.gh.calls.filter((c) => c[1] === "create")).toHaveLength(0);
    expect(codex.calls()).toHaveLength(1);
  });

  it("a bad range → exit 4", async () => {
    const r = repo();
    const { tools: t } = tools(r.root, {});
    await precondition(runReview(context(r.root, ["tag", "v1"]), { tools: t }));
  });
});

// ----------------------------------------------------------------- verdict

describe("review verdict", () => {
  async function verdict(args: string[]): Promise<{ result: CommandResult; gh: GhLog }> {
    const r = repo();
    const { tools: t, gh } = tools(r.root, {});
    const result = await runReview(context(r.root, ["verdict", ...args]), { tools: t });
    return { result, gh };
  }

  it("writes the review-verdict marker on a PR", async () => {
    const { result, gh } = await verdict(["pr", "12", "CX1", "accepted", "fixed"]);
    expect(result.exit).toBe(EXIT.OK);
    expect(gh.calls[0]?.slice(0, 3)).toEqual(["pr", "comment", "12"]);
    expect(gh.bodies[0]).toMatch(
      /^<!-- review-verdict \{.*"finding":"CX1".*"source":"codex".*\} -->/,
    );
  });

  it("accepts a ticket and a rejection with a Claude lens source", async () => {
    const ticket = await verdict(["issue", "40", "CX2", "accepted", "ticket", "41"]);
    expect(ticket.gh.calls[0]?.slice(0, 3)).toEqual(["issue", "comment", "40"]);
    expect(ticket.gh.bodies[0]).toContain('"ticket":41');
    const rejected = await verdict([
      "pr",
      "12",
      "S1",
      "rejected",
      "guarded upstream",
      "--source",
      "claude:security",
    ]);
    expect(rejected.gh.bodies[0]).toContain('"source":"claude:security"');
    expect(rejected.gh.bodies[0]).toContain('"reason":"guarded upstream"');
  });

  it.each([
    [["pr", "12", "CX1", "accepted"]],
    [["pr", "12", "CX1", "accepted", "ticket"]],
    [["pr", "12", "CX1", "maybe"]],
    [["commit", "12", "CX1", "accepted", "fixed"]],
    [["pr", "12", "CX1", "accepted", "fixed", "--source", "gpt"]],
  ])("rejects %j with exit 4", async (args) => {
    const r = repo();
    const { tools: t } = tools(r.root, {});
    await precondition(runReview(context(r.root, ["verdict", ...args]), { tools: t }));
  });
});

it("an unknown subcommand → exit 4", async () => {
  const r = repo();
  const { tools: t } = tools(r.root, {});
  await precondition(runReview(context(r.root, ["frobnicate"]), { tools: t }));
});
