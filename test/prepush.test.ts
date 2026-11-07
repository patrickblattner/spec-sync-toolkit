/**
 * `prepush` (PROC-DEV-005 rev 7, register #1979): a code-free push skips the
 * preflight, a code push runs it, a red preflight within the cap refuses, and a
 * preflight past the cap is ended with its whole process tree and lets the push
 * through.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandContext } from "../src/cli.js";
import {
  parseRefLines,
  planPrePush,
  runPrePush,
  type PrePushDeps,
} from "../src/commands/prepush.js";
import { BOX_DIR_ENV } from "../src/gate/slots.js";
import { EXIT, ToolkitError } from "../src/output.js";

const ZERO = "0".repeat(40);

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function commit(root: string, files: Record<string, string>, message: string): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content, "utf8");
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

/** A repo with `main` (one code file, pins, coverage) and a branch `feature` on top. */
function repo(): { root: string; base: string } {
  const root = mkdtempSync(join(tmpdir(), "spec-sync-prepush-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "prepush@example.test");
  git(root, "config", "user.name", "prepush");
  const base = commit(
    root,
    {
      "src/a.ts": "a\n",
      "spec-pins.json": "{}\n",
      ".spec-sync/drift-coverage.jsonl": "",
    },
    "base",
  );
  git(root, "checkout", "-q", "-b", "feature");
  return { root, base };
}

const ctx = (root: string, args: string[] = []): CommandContext => ({
  flags: { human: false, dryRun: false },
  args,
  repoRoot: root,
});

/** A fake gate: `sh -c <script>`; it records its arguments in `gate-args`. */
const deps = (stdin: string, script: string, minuteMs = 60_000): PrePushDeps => ({
  readStdin: () => stdin,
  gate: ["sh", "-c", `echo "$@" > gate-args; ${script}`, "fake-gate"],
  minuteMs,
  graceMs: 300,
  ghTimeoutMs: 1_000,
});

const line = (local: string, sha: string, remote: string, remoteSha: string): string =>
  `${local} ${sha} ${remote} ${remoteSha}\n`;

/**
 * A fake `gh` on PATH for every test (PROC-DEV-005 rev 8): it logs its
 * arguments and answers `pr list` with FAKE_GH_LIST (default: no PR) and
 * `pr checks` with FAKE_GH_CHECKS and exit FAKE_GH_CHECKS_EXIT. FAKE_GH_MODE
 * `fail` exits 1 without output, `hang` sleeps past the timeout.
 */
const ENV_KEYS = [
  "PATH",
  "FAKE_GH_LOG",
  "FAKE_GH_LIST",
  "FAKE_GH_CHECKS",
  "FAKE_GH_CHECKS_EXIT",
  "FAKE_GH_MODE",
  "SPEC_SYNC_REGATE",
] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
let ghLog = "";

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  const bin = mkdtempSync(join(tmpdir(), "spec-sync-fake-gh-"));
  ghLog = join(bin, "gh.log");
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      'echo "$*" >> "$FAKE_GH_LOG"',
      'case "$FAKE_GH_MODE" in fail) echo "gh: boom" >&2; exit 1;; hang) exec sleep 30;; esac',
      'if [ "$2" = "list" ]; then echo "${FAKE_GH_LIST:-[]}"; exit 0; fi',
      'if [ "$2" = "checks" ]; then echo "${FAKE_GH_CHECKS:-[]}"; exit "${FAKE_GH_CHECKS_EXIT:-0}"; fi',
      "exit 1",
    ].join("\n"),
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  process.env.FAKE_GH_LOG = ghLog;
  for (const key of ENV_KEYS.slice(2)) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const ghCalls = (): string[] =>
  existsSync(ghLog) ? readFileSync(ghLog, "utf8").trim().split("\n") : [];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("prepush: what skips the preflight", () => {
  it("skips a tag-only push", async () => {
    const { root, base } = repo();
    const result = await runPrePush(
      ctx(root),
      deps(line("refs/tags/v1", base, "refs/tags/v1", ZERO), "exit 1"),
    );
    expect(result).toMatchObject({ ok: true, data: { preflight: "skipped" } });
    expect(existsSync(join(root, "gate-args"))).toBe(false);
  });

  it("skips a branch delete", async () => {
    const { root, base } = repo();
    const result = await runPrePush(
      ctx(root),
      deps(line("(delete)", ZERO, "refs/heads/old", base), "exit 1"),
    );
    expect(result).toMatchObject({ ok: true, data: { preflight: "skipped" } });
    expect(existsSync(join(root, "gate-args"))).toBe(false);
  });

  it("skips a pins-only commit against the remote sha", async () => {
    const { root, base } = repo();
    const tip = commit(root, { "spec-pins.json": '{"X-1": 2}\n' }, "chore: repin");
    const result = await runPrePush(
      ctx(root),
      deps(line("refs/heads/feature", tip, "refs/heads/feature", base), "exit 1"),
    );
    expect(result).toMatchObject({ ok: true, data: { preflight: "skipped" } });
    expect(result.notes?.[0]).toContain("change only spec pins and drift coverage");
  });

  it("skips a coverage-only commit on a new branch, against the merge-base with main", async () => {
    const { root } = repo();
    const tip = commit(
      root,
      { ".spec-sync/drift-coverage.jsonl": '{"key":"X-1","to":2}\n' },
      "chore: cover",
    );
    const result = await runPrePush(
      ctx(root),
      deps(line("refs/heads/feature", tip, "refs/heads/feature", ZERO), "exit 1"),
    );
    expect(result).toMatchObject({ ok: true, data: { preflight: "skipped" } });
  });

  it("runs the preflight when stdin carries no ref lines — never less checking", () => {
    expect(planPrePush(parseRefLines(""), () => [])).toMatchObject({ run: true });
  });

  it("runs the preflight when a tag rides along with a code change", () => {
    const refs = parseRefLines(
      line("refs/tags/v1", "a".repeat(40), "refs/tags/v1", ZERO) +
        line("refs/heads/f", "b".repeat(40), "refs/heads/f", ZERO),
    );
    expect(planPrePush(refs, () => ["src/a.ts"])).toMatchObject({ run: true });
    expect(planPrePush(refs, () => undefined)).toMatchObject({ run: true });
  });
});

describe("prepush: running the preflight", () => {
  it("runs gate --profile merge --preflight --changed for a code change and passes green", async () => {
    const { root } = repo();
    const tip = commit(root, { "src/a.ts": "b\n" }, "feat: b");
    const result = await runPrePush(
      ctx(root),
      deps(
        line("refs/heads/feature", tip, "refs/heads/feature", ZERO),
        `echo '{"ok":true,"notes":["gate note"]}'`,
      ),
    );
    expect(readFileSync(join(root, "gate-args"), "utf8").trim()).toBe(
      "gate --profile merge --preflight --changed",
    );
    expect(result).toMatchObject({ ok: true, exit: EXIT.OK, data: { preflight: "ran" } });
    expect(result.notes).toContain("gate note");
  });

  it("refuses with the gate's exit code and failures when the preflight is red within the cap", async () => {
    const { root } = repo();
    const tip = commit(root, { "src/a.ts": "b\n" }, "feat: b");
    const result = await runPrePush(
      ctx(root),
      deps(
        line("refs/heads/feature", tip, "refs/heads/feature", ZERO),
        `echo '{"ok":false,"failures":[{"name":"lint"}],"logDir":".spec-sync/logs/x"}'; exit 1`,
      ),
    );
    expect(result).toMatchObject({
      ok: false,
      exit: 1,
      logDir: ".spec-sync/logs/x",
      data: { preflight: "ran", gate_exit: 1, failures: [{ name: "lint" }] },
    });
  });

  it("ends the whole process tree at the cap, releases the slot it held and lets the push through", async () => {
    const { root } = repo();
    const box = process.env[BOX_DIR_ENV] as string;
    mkdirSync(box, { recursive: true });
    const tip = commit(root, { "src/a.ts": "b\n" }, "feat: b");
    // The fake gate takes slot 1 under its own pid, starts a child that
    // ignores SIGTERM (as a stuck eslint might) and a plain one, and hangs.
    const script = [
      `printf '{"pid":%s,"startedAt":"x","holder":"fake"}' $$ > "${box}/slot-1.lock"`,
      `sh -c 'trap "" TERM; sleep 30' & echo $! > stubborn.pid`,
      "sleep 30 & echo $! > plain.pid",
      "wait",
    ].join("; ");
    const started = Date.now();
    const result = await runPrePush(
      ctx(root, ["--cap-min", "1"]),
      deps(line("refs/heads/feature", tip, "refs/heads/feature", ZERO), script, 400),
    );

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result).toMatchObject({ ok: true, exit: EXIT.OK, data: { preflight: "capped" } });
    expect(result.notes?.[0]).toContain(
      "the push goes through, the runner's required check decides",
    );
    for (const file of ["stubborn.pid", "plain.pid"]) {
      const pid = Number(readFileSync(join(root, file), "utf8").trim());
      expect(alive(pid), `${file} ${pid}`).toBe(false);
    }
    expect(existsSync(join(box, "slot-1.lock"))).toBe(false);
    expect(result.data).toMatchObject({ released: ["slot-1"] });
  });

  it("rejects a cap that is not a whole number of minutes", async () => {
    const { root } = repo();
    await expect(runPrePush(ctx(root, ["--cap-min", "0"]), deps("", "exit 0"))).rejects.toThrow(
      ToolkitError,
    );
  });
});

describe("prepush: no push onto a running or green ready PR (PROC-DEV-005 rev 8)", () => {
  const ready = '[{"number":42,"isDraft":false}]';
  /** A code push from `feature` onto the remote branch it already has. */
  function codePush(files: Record<string, string> = { "src/a.ts": "b\n" }): {
    root: string;
    stdin: string;
  } {
    const { root, base } = repo();
    const tip = commit(root, files, "feat: change");
    return { root, stdin: line("refs/heads/feature", tip, "refs/heads/feature", base) };
  }
  const green = `echo '{"ok":true}'`;

  it("refuses a push onto a ready PR whose required check is running", async () => {
    process.env.FAKE_GH_LIST = ready;
    process.env.FAKE_GH_CHECKS = '[{"name":"pr-gate","bucket":"pending"}]';
    process.env.FAKE_GH_CHECKS_EXIT = "8";
    const { root, stdin } = codePush();
    const result = await runPrePush(ctx(root), deps(stdin, green));
    expect(result).toMatchObject({
      ok: false,
      exit: EXIT.PRECONDITION,
      data: { preflight: "refused", pr: 42, checks: "running" },
    });
    expect(result.notes?.[0]).toContain("#42");
    expect(result.notes?.[0]).toContain("gh pr ready 42 --undo");
    expect(result.notes?.[0]).toContain("SPEC_SYNC_REGATE=1 git push");
    expect(existsSync(join(root, "gate-args"))).toBe(false);
    expect(ghCalls()).toEqual([
      "pr list --head feature --state open --json number,isDraft",
      "pr checks 42 --required --json name,bucket",
    ]);
  });

  it("refuses a push onto a ready PR whose required checks are all green", async () => {
    process.env.FAKE_GH_LIST = ready;
    process.env.FAKE_GH_CHECKS =
      '[{"name":"pr-gate","bucket":"pass"},{"name":"lint","bucket":"skipping"}]';
    const { root, stdin } = codePush();
    const result = await runPrePush(ctx(root), deps(stdin, green));
    expect(result).toMatchObject({
      ok: false,
      exit: EXIT.PRECONDITION,
      data: { preflight: "refused", pr: 42, checks: "green" },
    });
  });

  it("lets the push through when the last verdict of the required checks is red", async () => {
    process.env.FAKE_GH_LIST = ready;
    process.env.FAKE_GH_CHECKS =
      '[{"name":"pr-gate","bucket":"fail"},{"name":"unit","bucket":"pending"}]';
    process.env.FAKE_GH_CHECKS_EXIT = "1";
    const { root, stdin } = codePush();
    const result = await runPrePush(ctx(root), deps(stdin, green));
    expect(result).toMatchObject({ ok: true, exit: EXIT.OK, data: { preflight: "ran" } });
    expect(result.notes?.[0]).toContain("#42");
    expect(result.notes?.[0]).toContain("red");
  });

  it("lets the push through when it only modifies existing baseline PNGs", async () => {
    process.env.FAKE_GH_LIST = ready;
    process.env.FAKE_GH_CHECKS = '[{"name":"pr-gate","bucket":"pass"}]';
    const { root } = repo();
    const parent = commit(root, { "e2e/home.spec.ts-snapshots/home.png": "v1" }, "add baseline");
    const tip = commit(root, { "e2e/home.spec.ts-snapshots/home.png": "v2" }, "refresh baseline");
    const result = await runPrePush(
      ctx(root),
      deps(line("refs/heads/feature", tip, "refs/heads/feature", parent), green),
    );
    expect(result).toMatchObject({ ok: true, exit: EXIT.OK });
    expect(result.notes?.[0]).toContain("only existing baseline PNGs");
  });

  it("refuses a push that adds a baseline PNG", async () => {
    process.env.FAKE_GH_LIST = ready;
    process.env.FAKE_GH_CHECKS = '[{"name":"pr-gate","bucket":"pass"}]';
    const { root, stdin } = codePush({ "e2e/home.spec.ts-snapshots/new.png": "v1" });
    const result = await runPrePush(ctx(root), deps(stdin, green));
    expect(result).toMatchObject({ ok: false, data: { preflight: "refused" } });
  });

  it("lets the push through with SPEC_SYNC_REGATE=1 and says so, without asking GitHub", async () => {
    process.env.SPEC_SYNC_REGATE = "1";
    process.env.FAKE_GH_LIST = ready;
    process.env.FAKE_GH_CHECKS = '[{"name":"pr-gate","bucket":"pass"}]';
    const { root, stdin } = codePush();
    const result = await runPrePush(ctx(root), deps(stdin, green));
    expect(result).toMatchObject({ ok: true, exit: EXIT.OK, data: { preflight: "ran" } });
    expect(result.notes?.[0]).toContain("SPEC_SYNC_REGATE=1");
    expect(ghCalls()).toEqual([]);
  });

  it("fails open with one line when gh fails", async () => {
    process.env.FAKE_GH_MODE = "fail";
    const { root, stdin } = codePush();
    const result = await runPrePush(ctx(root), deps(stdin, green));
    expect(result).toMatchObject({ ok: true, exit: EXIT.OK, data: { preflight: "ran" } });
    expect(result.notes?.[0]).toContain("GitHub could not be asked");
  });

  it("fails open with one line when gh times out", async () => {
    process.env.FAKE_GH_MODE = "hang";
    const { root, stdin } = codePush();
    const started = Date.now();
    const result = await runPrePush(ctx(root), deps(stdin, green));
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result).toMatchObject({ ok: true, exit: EXIT.OK, data: { preflight: "ran" } });
    expect(result.notes?.[0]).toContain("GitHub could not be asked");
  });

  it("never refuses a push onto a draft PR", async () => {
    process.env.FAKE_GH_LIST = '[{"number":42,"isDraft":true}]';
    process.env.FAKE_GH_CHECKS = '[{"name":"pr-gate","bucket":"pass"}]';
    const { root, stdin } = codePush();
    const result = await runPrePush(ctx(root), deps(stdin, green));
    expect(result).toMatchObject({ ok: true, exit: EXIT.OK, data: { preflight: "ran" } });
    expect(ghCalls()).toHaveLength(1);
  });

  it("never refuses a branch without a PR", async () => {
    const { root, stdin } = codePush();
    const result = await runPrePush(ctx(root), deps(stdin, green));
    expect(result).toMatchObject({ ok: true, exit: EXIT.OK, data: { preflight: "ran" } });
    expect(ghCalls()).toEqual(["pr list --head feature --state open --json number,isDraft"]);
  });

  it("does not ask GitHub for tags or branch deletes", async () => {
    const { root, base } = repo();
    await runPrePush(
      ctx(root),
      deps(
        line("refs/tags/v1", base, "refs/tags/v1", ZERO) +
          line("(delete)", ZERO, "refs/heads/old", base),
        "exit 1",
      ),
    );
    expect(ghCalls()).toEqual([]);
  });
});
