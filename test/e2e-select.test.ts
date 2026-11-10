/**
 * `e2e-select` (PROC-REL-071, register #2024): the selection behind the
 * merge-gate phase `e2e-targeted` — full, files or none.
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/cli.js";
import { selectE2e } from "../src/gate/e2e-select.js";
import { resetEmitState } from "../src/output.js";

const DEFAULTS = { specGlob: "e2e/**/*.spec.ts", package: "@suite/ui" };

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content, "utf8");
}

function lock(version: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: "app",
    lockfileVersion: 3,
    packages: {
      "": { name: "app" },
      "node_modules/@suite/ui": {
        version,
        resolved: `git+ssh://git@github.com/o/suite-ui.git#v${version}`,
      },
      ...extra,
    },
  });
}

function manifest(spec: string, workspaces?: string[]): string {
  return JSON.stringify({ name: "app", workspaces, dependencies: { "@suite/ui": spec } });
}

/** `main` with a lockfile, a manifest, a workspace and two specs; `feature` on top. */
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "spec-sync-e2e-select-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "gate@example.test");
  git(root, "config", "user.name", "gate");
  cpSync(join(process.cwd(), "spec-sync.config.json.example"), join(root, "spec-sync.config.json"));
  write(root, "package-lock.json", lock("1.0.0"));
  write(root, "package.json", manifest("github:o/suite-ui#v1.0.0", ["apps/*"]));
  write(root, "apps/web/package.json", JSON.stringify({ name: "web", devDependencies: {} }));
  write(root, "e2e/login.spec.ts", "a\n");
  write(root, "e2e/admin/users.spec.ts", "a\n");
  write(root, "src/app.ts", "a\n");
  git(root, "add", "-A");
  git(root, "commit", "-m", "base");
  git(root, "checkout", "-b", "feature");
  // One unrelated commit, so `main` (not `HEAD^`) is the diff base.
  write(root, "notes.txt", "a\n");
  git(root, "add", "notes.txt");
  git(root, "commit", "-m", "branch");
  return root;
}

function commit(root: string): void {
  git(root, "add", "-A");
  git(root, "commit", "-m", "work");
}

describe("selectE2e", () => {
  it("rule 1: a lock-only bump of @suite/ui runs the full suite", async () => {
    const root = repo();
    write(root, "package-lock.json", lock("1.1.0"));
    commit(root);
    expect(await selectE2e(root, DEFAULTS)).toMatchObject({ mode: "full", base: "main" });
  });

  it("rule 1: a package.json pin change runs the full suite — root or workspace", async () => {
    const root = repo();
    write(root, "package.json", manifest("github:o/suite-ui#v1.1.0", ["apps/*"]));
    commit(root);
    expect(await selectE2e(root, DEFAULTS)).toMatchObject({ mode: "full" });

    const ws = repo();
    write(ws, "apps/web/package.json", JSON.stringify({ devDependencies: { "@suite/ui": "^1" } }));
    expect(await selectE2e(ws, DEFAULTS)).toMatchObject({ mode: "full" }); // uncommitted counts
  });

  it("rule 1 ignores an unrelated lockfile or manifest change", async () => {
    const root = repo();
    write(root, "package-lock.json", lock("1.0.0", { "node_modules/zod": { version: "4.0.0" } }));
    write(
      root,
      "package.json",
      JSON.stringify({ ...JSON.parse(manifest("github:o/suite-ui#v1.0.0")), scripts: { x: "y" } }),
    );
    commit(root);
    expect(await selectE2e(root, DEFAULTS)).toEqual({ mode: "none", base: "main" });
  });

  it("rule 2: changed spec files, sorted; a deleted one is not listed", async () => {
    const root = repo();
    write(root, "e2e/login.spec.ts", "b\n");
    rmSync(join(root, "e2e/admin/users.spec.ts"));
    write(root, "e2e/new/flow.spec.ts", "a\n"); // untracked
    write(root, "e2e/helpers.ts", "a\n"); // not a spec
    expect(await selectE2e(root, DEFAULTS)).toEqual({
      mode: "files",
      base: "main",
      files: ["e2e/login.spec.ts", "e2e/new/flow.spec.ts"],
    });
  });

  it("rule 3: nothing relevant selects none", async () => {
    const root = repo();
    write(root, "src/app.ts", "b\n");
    commit(root);
    expect(await selectE2e(root, DEFAULTS)).toEqual({ mode: "none", base: "main" });
  });

  it("fail-safe: no diff base runs the full suite with a reason", async () => {
    const root = mkdtempSync(join(tmpdir(), "spec-sync-e2e-select-"));
    git(root, "init", "-b", "main");
    const selection = await selectE2e(root, DEFAULTS);
    expect(selection.mode).toBe("full");
    expect(selection).toHaveProperty("reason", expect.stringMatching(/^no diff base: /));
  });

  it("fail-safe: an unparsable lockfile runs the full suite with a reason", async () => {
    const root = repo();
    write(root, "package-lock.json", "{ broken");
    const selection = await selectE2e(root, DEFAULTS);
    expect(selection).toMatchObject({ mode: "full" });
    expect(selection).toHaveProperty("reason", expect.stringMatching(/^cannot judge: /));
  });

  it("honours a custom spec glob", async () => {
    const root = repo();
    write(root, "tests/e2e/a.e2e.ts", "a\n");
    write(root, "e2e/login.spec.ts", "b\n");
    expect(await selectE2e(root, { ...DEFAULTS, specGlob: "tests/e2e/**/*.e2e.ts" })).toEqual({
      mode: "files",
      base: "main",
      files: ["tests/e2e/a.e2e.ts"],
    });
  });
});

describe("spec-sync e2e-select (command)", () => {
  afterEach(() => {
    resetEmitState();
    vi.restoreAllMocks();
  });

  function capture(): string[] {
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    return chunks;
  }

  it("reads e2eSelect.specGlob from the config and emits the JSON envelope", async () => {
    const root = repo();
    write(
      root,
      "spec-sync.config.json",
      JSON.stringify({
        ...JSON.parse(
          execFileSync("git", ["show", "main:spec-sync.config.json"], {
            cwd: root,
            encoding: "utf8",
          }),
        ),
        e2eSelect: { specGlob: "tests/**/*.pw.ts" },
      }),
    );
    write(root, "tests/a.pw.ts", "a\n");
    const chunks = capture();
    expect(await run(["e2e-select", "--repo", root])).toBe(0);
    expect(JSON.parse(chunks.join(""))).toMatchObject({
      command: "e2e-select",
      ok: true,
      exit: 0,
      mode: "files",
      files: ["tests/a.pw.ts"],
    });
  });

  it("--format lines prints the mode or one file per line", async () => {
    const root = repo();
    let chunks = capture();
    expect(await run(["e2e-select", "--repo", root, "--format", "lines"])).toBe(0);
    expect(chunks.join("")).toBe("none\n");

    resetEmitState();
    vi.restoreAllMocks();
    write(root, "e2e/login.spec.ts", "b\n");
    write(root, "e2e/admin/users.spec.ts", "b\n");
    chunks = capture();
    await run(["e2e-select", "--repo", root, "--format", "lines"]);
    expect(chunks.join("")).toBe("e2e/admin/users.spec.ts\ne2e/login.spec.ts\n");

    resetEmitState();
    vi.restoreAllMocks();
    write(root, "package-lock.json", lock("2.0.0"));
    chunks = capture();
    await run(["e2e-select", "--repo", root, "--format=lines"]);
    expect(chunks.join("")).toBe("full\n");
  });

  it("rejects an unknown --format with exit 4", async () => {
    const root = repo();
    const chunks = capture();
    expect(await run(["e2e-select", "--repo", root, "--format", "csv"])).toBe(4);
    expect(JSON.parse(chunks.join(""))).toMatchObject({ field: "--format" });
  });
});
