/**
 * `e2e-select`: which E2E specs the merge-gate phase `e2e-targeted` runs for
 * this diff (`PROC-REL-071`, register #2024).
 *
 * 1. The resolved version of the UI package differs between base and HEAD
 *    (lockfile entry or a `package.json` dependency spec) → the full suite.
 * 2. Else changed E2E spec files that still exist → exactly those files.
 * 3. Else → none.
 *
 * Fail-safe: when the selection cannot judge (no diff base, a manifest it
 * cannot read or parse), it answers `full`. It never fails the gate itself.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import picomatch from "picomatch";
import { simpleGit } from "simple-git";
import type { E2eSelectConfig } from "../config.js";
import { changedFiles, diffBase } from "./changed.js";

export type E2eSelection =
  { mode: "full"; reason?: string } | { mode: "files"; files: string[] } | { mode: "none" };

/** A version fingerprint; `undefined` = the file or the entry is absent. */
type Fingerprint = string | undefined;

class Unreadable extends Error {}

const DEP_FIELDS = ["dependencies", "devDependencies"] as const;

export async function selectE2e(
  repoRoot: string,
  options: E2eSelectConfig,
): Promise<E2eSelection & { base?: string }> {
  let base: string;
  let files: string[];
  let ref: string;
  try {
    base = await diffBase(repoRoot);
    files = await changedFiles(repoRoot, base);
    // The content comparison measures what the diff measures: `base...HEAD`
    // is against the merge base, so a newer `main` does not count as this PR.
    ref = (await simpleGit(repoRoot).raw(["merge-base", base, "HEAD"])).trim();
    if (ref === "") throw new Error(`no merge base between ${base} and HEAD`);
  } catch (error) {
    return { mode: "full", reason: `no diff base: ${firstLine(error)}` };
  }

  // Only a changed manifest can carry a changed version.
  const locks = files.filter((file) => basename(file) === "package-lock.json" && !inModules(file));
  const manifests = files.filter((file) => basename(file) === "package.json" && !inModules(file));

  try {
    for (const lock of locks) {
      const before = lockFingerprint(await atRef(repoRoot, ref, lock), options.package);
      const after = lockFingerprint(await inTree(repoRoot, lock), options.package);
      if (before !== after) {
        return { mode: "full", base, reason: `${options.package} changes in ${lock}` };
      }
    }
    for (const manifest of manifests) {
      const before = manifestFingerprint(await atRef(repoRoot, ref, manifest), options.package);
      const after = manifestFingerprint(await inTree(repoRoot, manifest), options.package);
      if (before !== after) {
        return { mode: "full", base, reason: `${options.package} pin changes in ${manifest}` };
      }
    }
  } catch (error) {
    return { mode: "full", base, reason: `cannot judge: ${firstLine(error)}` };
  }

  const isSpec = picomatch(options.specGlob);
  const specs = files.filter((file) => isSpec(file) && existsSync(join(repoRoot, file))).sort();
  if (specs.length > 0) return { mode: "files", base, files: specs };
  return { mode: "none", base };
}

function inModules(file: string): boolean {
  return file.split("/").includes("node_modules");
}

function firstLine(error: unknown): string {
  return ((error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "").trim();
}

/** The file at `ref`; `undefined` when `ref` does not carry it. */
async function atRef(repoRoot: string, ref: string, path: string): Promise<string | undefined> {
  const git = simpleGit(repoRoot);
  try {
    await git.raw(["cat-file", "-e", `${ref}:${path}`]);
  } catch {
    return undefined;
  }
  try {
    return await git.raw(["show", `${ref}:${path}`]);
  } catch (error) {
    throw new Unreadable(`${path} at ${ref} unreadable: ${firstLine(error)}`);
  }
}

/** The working-tree file; `undefined` when it is gone. */
async function inTree(repoRoot: string, path: string): Promise<string | undefined> {
  if (!existsSync(join(repoRoot, path))) return undefined;
  try {
    return await readFile(join(repoRoot, path), "utf8");
  } catch (error) {
    throw new Unreadable(`${path} unreadable: ${firstLine(error)}`);
  }
}

function parse(content: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Unreadable(`${what} is not valid JSON: ${firstLine(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Unreadable(`${what} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Every `…node_modules/<pkg>` entry of the lockfile: version and resolved. */
function lockFingerprint(content: string | undefined, pkg: string): Fingerprint {
  if (content === undefined) return undefined;
  const packages = asRecord(parse(content, "package-lock.json").packages);
  const suffix = `node_modules/${pkg}`;
  const entries = Object.keys(packages)
    .filter((key) => key === suffix || key.endsWith(`/${suffix}`))
    .sort()
    .map((key) => {
      const entry = asRecord(packages[key]);
      return [key, entry.version, entry.resolved];
    });
  return entries.length === 0 ? undefined : JSON.stringify(entries);
}

/** The package's spec in `dependencies` / `devDependencies` of one manifest. */
function manifestFingerprint(content: string | undefined, pkg: string): Fingerprint {
  if (content === undefined) return undefined;
  const manifest = parse(content, "package.json");
  const specs = DEP_FIELDS.map((field) => asRecord(manifest[field])[pkg]);
  return specs.every((spec) => spec === undefined) ? undefined : JSON.stringify(specs);
}
