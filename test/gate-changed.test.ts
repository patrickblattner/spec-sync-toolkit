/**
 * `--changed` (spec §7.1, §5 `when`): which phases a diff against `main`
 * actually concerns.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { changedFiles, diffBase, phaseRuns } from "../src/gate/changed.js";
import { EXIT, ToolkitError } from "../src/output.js";

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function write(root: string, path: string, content = "x\n"): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content, "utf8");
}

/** A repo with a `main` carrying one file, and a branch on top of it. */
function repoWithBranch(): string {
  const root = mkdtempSync(join(tmpdir(), "spec-sync-changed-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "gate@example.test");
  git(root, "config", "user.name", "gate");
  write(root, "README.md");
  git(root, "add", "README.md");
  git(root, "commit", "-m", "base");
  git(root, "checkout", "-b", "feature");
  return root;
}

describe("phaseRuns (spec §5: `when` restricts a phase to matching diffs)", () => {
  it("runs a phase without `when` for any diff at all", () => {
    expect(phaseRuns(undefined, ["server/db.ts"])).toBe(true);
    expect(phaseRuns(undefined, [])).toBe(true);
    expect(phaseRuns([], ["server/db.ts"])).toBe(true);
  });

  it("runs a phase whose glob the diff hits, directly under the prefix or deep below it", () => {
    expect(phaseRuns(["client/**", "e2e/**"], ["client/app.tsx"])).toBe(true);
    expect(phaseRuns(["client/**"], ["client/pages/admin/view.tsx"])).toBe(true);
    expect(phaseRuns(["**/auth/**"], ["server/auth/session.ts"])).toBe(true);
    expect(phaseRuns(["package-lock.json"], ["package-lock.json"])).toBe(true);
  });

  it("skips a phase no changed file touches — the whole point of --changed", () => {
    expect(phaseRuns(["client/**", "e2e/**"], ["server/db.ts", "README.md"])).toBe(false);
    expect(phaseRuns(["client/**"], [])).toBe(false);
    // A near miss is a miss: `clients/` is not `client/`.
    expect(phaseRuns(["client/**"], ["clients/a.ts"])).toBe(false);
  });

  it("runs the phase when ONE of several globs matches", () => {
    expect(phaseRuns(["client/**", "e2e/**"], ["e2e/login.spec.ts"])).toBe(true);
  });
});

describe("changedFiles", () => {
  it("sees the branch's commits", async () => {
    const root = repoWithBranch();
    write(root, "server/db.ts");
    git(root, "add", "server/db.ts");
    git(root, "commit", "-m", "work");

    expect(await changedFiles(root)).toEqual(["server/db.ts"]);
  });

  it("sees uncommitted and untracked work too — an unseen file is a phase wrongly skipped", async () => {
    const root = repoWithBranch();
    write(root, "server/db.ts");
    git(root, "add", "server/db.ts");
    git(root, "commit", "-m", "work");
    write(root, "README.md", "edited\n"); // tracked, modified, uncommitted
    write(root, "client/app.tsx"); // untracked

    expect(await changedFiles(root)).toEqual(["README.md", "client/app.tsx", "server/db.ts"]);
  });

  it("measures against HEAD^ where main already contains the checked state", async () => {
    const root = repoWithBranch();
    write(root, "server/db.ts");
    git(root, "add", "server/db.ts");
    git(root, "commit", "-m", "work");
    git(root, "checkout", "main");
    git(root, "merge", "--ff-only", "feature");

    // The defect: against `main` this diff is empty and every `when:` phase
    // reports itself skipped. Against `HEAD^` the work is visible again.
    expect(await changedFiles(root)).toEqual(["server/db.ts"]);
  });

  it("reports an unusable base as a precondition (exit 4), not as a green gate", async () => {
    const root = mkdtempSync(join(tmpdir(), "spec-sync-changed-"));
    git(root, "init", "-b", "other");
    const error = await changedFiles(root).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolkitError);
    expect((error as ToolkitError).exit).toBe(EXIT.PRECONDITION);
    expect((error as ToolkitError).field).toBe("--changed");
  });
});

/**
 * The base is CHOSEN, never hardwired (`#15`, spec §7.1 / `SST-DESIGN-016`
 * rev 3).
 *
 * `DIFF_BASE = "main"` measured every run against the trunk, including runs ON
 * the trunk: there `main...HEAD` is empty, every `when:` phase selects nothing
 * and the gate reports "skipped" — the silently empty selection foundation
 * `PROC-REL-012` rev 3 forbids, and the gate config had no lever against it
 * (`production-cockpit#1221`). A non-run reported as a saving is class 1
 * (`PROC-REL-013` rev 4).
 */
describe("diffBase (#15)", () => {
  it("takes main while main does not contain HEAD", async () => {
    const root = repoWithBranch();
    write(root, "server/db.ts");
    git(root, "add", "server/db.ts");
    git(root, "commit", "-m", "work");

    expect(await diffBase(root)).toBe("main");
  });

  it("takes HEAD^ where main contains HEAD — merged, or standing on main itself", async () => {
    const root = repoWithBranch();
    write(root, "server/db.ts");
    git(root, "add", "server/db.ts");
    git(root, "commit", "-m", "work");
    git(root, "checkout", "main");
    git(root, "merge", "--ff-only", "feature");

    expect(await diffBase(root)).toBe("HEAD^");
  });

  it("takes HEAD^ for a branch still level with main — never HEAD against itself", async () => {
    const root = repoWithBranch();
    git(root, "checkout", "main");
    write(root, "server/db.ts");
    git(root, "add", "server/db.ts");
    git(root, "commit", "-m", "second");
    git(root, "checkout", "-B", "feature"); // level with main, and contained by it

    expect(await diffBase(root)).toBe("HEAD^");
    // The point of the fallback: the selection is not empty, so nothing is
    // skipped that the last commit actually touched.
    expect(await changedFiles(root)).toEqual(["server/db.ts"]);
  });

  it("takes HEAD^ where there is no main at all", async () => {
    const root = mkdtempSync(join(tmpdir(), "spec-sync-changed-"));
    git(root, "init", "-b", "other");
    git(root, "config", "user.email", "gate@example.test");
    git(root, "config", "user.name", "gate");
    write(root, "README.md");
    git(root, "add", "README.md");
    git(root, "commit", "-m", "base");
    write(root, "server/db.ts");
    git(root, "add", "server/db.ts");
    git(root, "commit", "-m", "work");

    expect(await diffBase(root)).toBe("HEAD^");
    expect(await changedFiles(root)).toEqual(["server/db.ts"]);
  });

  it("fails rather than skipping when no base can be determined", async () => {
    // One commit on main: main contains HEAD, and HEAD has no parent left.
    const root = mkdtempSync(join(tmpdir(), "spec-sync-changed-"));
    git(root, "init", "-b", "main");
    git(root, "config", "user.email", "gate@example.test");
    git(root, "config", "user.name", "gate");
    write(root, "README.md");
    git(root, "add", "README.md");
    git(root, "commit", "-m", "base");

    for (const call of [diffBase(root), changedFiles(root)]) {
      const error = await call.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ToolkitError);
      expect((error as ToolkitError).exit).toBe(EXIT.PRECONDITION);
      expect((error as ToolkitError).field).toBe("--changed");
    }
  });
});
