/**
 * `licence-inventory` — licence inventory of the production dependencies,
 * offline and fail-closed (SST-FEATURE-001 rev 5, GL-CODE-002).
 *
 * `spec-sync licence-inventory [--allowlist <file>]`
 *
 * Population: the production closure from `npm ls --omit=dev --all --json`
 * (workspaces included), deduplicated by name@version; the repo's own
 * workspace packages (`resolved: file:…`) are skipped, their dependencies are
 * not. Nodes npm marks `extraneous` are not in the closure; they are counted
 * (`skippedExtraneous`), never judged. The licence comes from the installed `package.json` (`license`, legacy
 * `licenses`); a missing or `*` field falls back to the LICENSE/LICENCE/COPYING
 * file. Anything unreadable is a finding, never skipped. An exception is bound
 * to the licence it was granted for (`licence`: SPDX expression, `UNLICENSED`
 * or `unreadable`) and passes only while the package still reads so. Exit 0 without a
 * finding, exit 1 with one; the full inventory goes to the log directory.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";
import { z } from "zod";
import type { Command, CommandContext, CommandResult } from "../cli.js";
import { matchLicenceText } from "../licence/texts.js";
import { parseSpdx, satisfiable } from "../licence/spdx.js";
import { readLedger } from "../ledger.js";
import { createLogDir, firstError, protectedLogDirs } from "../logs.js";
import { EXIT, ToolkitError } from "../output.js";
import { checkFlags, valueFlag } from "../pack/args.js";
import { runProcess, type RunResult } from "../pack/exec.js";

export const DEFAULT_ALLOWLIST = "licence-allowlist.json";
export const NPM_LS_ARGS = ["ls", "--omit=dev", "--all", "--json"];
const INVENTORY_FILE = "licence-inventory.json";
const MAX_LISTED = 10;

export const licenceInventoryCommand: Command = {
  name: "licence-inventory",
  summary: "Licence inventory of the production dependencies against the allowlist",
  needsConfig: false,
  run: (ctx) => runLicenceInventory(ctx),
};

/** The one call into the outside world, injectable so tests need no install. */
export type NpmLs = (repoRoot: string) => RunResult;
const defaultNpmLs: NpmLs = (repoRoot) => runProcess("npm", NPM_LS_ARGS, repoRoot);

const allowlistSchema = z.object({
  licenses: z.array(z.string().min(1)),
  exceptions: z
    .array(
      z.object({
        package: z.string().min(1),
        licence: z.string().trim().min(1),
        reason: z.string().trim().min(1),
      }),
    )
    .default([]),
});
type Allowlist = z.infer<typeof allowlistSchema>;

interface LsNode {
  version?: string;
  resolved?: string;
  missing?: boolean;
  extraneous?: boolean;
  dependencies?: Record<string, LsNode>;
}

export interface InventoryEntry {
  name: string;
  version: string;
  licence: string;
  /** Where the licence was read: `package.json`, a licence file name, or `none`. */
  source: string;
  path?: string;
  verdict: "allowed" | "exception" | "finding";
  why?: string;
}

export async function runLicenceInventory(
  ctx: CommandContext,
  npmLs: NpmLs = defaultNpmLs,
): Promise<CommandResult> {
  checkFlags(ctx.args, ["--allowlist"]);
  const allowlistFile = valueFlag(ctx.args, "--allowlist") ?? DEFAULT_ALLOWLIST;
  const allowlist = readAllowlist(ctx.repoRoot, allowlistFile);

  const tree = readTree(npmLs(ctx.repoRoot));
  const { entries, workspaces, notInstalled, skippedExtraneous } = collect(ctx.repoRoot, tree);
  const judged = entries.map((entry) => judge(entry, allowlist));
  const findings = judged.filter((entry) => entry.verdict === "finding");

  const logDir = createLogDir(ctx.repoRoot, {
    keep: protectedLogDirs(readLedger(ctx.repoRoot).events),
  });
  const inventory = join(logDir, INVENTORY_FILE);
  writeFileSync(
    join(ctx.repoRoot, inventory),
    `${JSON.stringify({ allowlist: allowlistFile, packages: judged }, null, 2)}\n`,
    "utf8",
  );

  const notes: string[] = [];
  if (workspaces > 0) notes.push(`${workspaces} workspace package(s) of the repo skipped`);
  if (notInstalled > 0) {
    notes.push(
      `${notInstalled} optional or peer dependency(ies) not installed, not in the closure`,
    );
  }

  return {
    ok: findings.length === 0,
    exit: findings.length === 0 ? EXIT.OK : EXIT.FAILED,
    logDir,
    notes,
    data: {
      packages: judged.length,
      skippedExtraneous,
      findings: findings.length,
      first: findings
        .slice(0, MAX_LISTED)
        .map((entry) => `${entry.name}@${entry.version}: ${entry.licence} — ${entry.why}`),
      ...(findings.length > MAX_LISTED ? { more: findings.length - MAX_LISTED } : {}),
      inventory,
    },
  };
}

function readAllowlist(repoRoot: string, file: string): Allowlist {
  const path = isAbsolute(file) ? file : join(repoRoot, file);
  if (!existsSync(path)) {
    throw new ToolkitError(`licence allowlist ${file} not found`, EXIT.PRECONDITION, {
      field: file,
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ToolkitError(`licence allowlist ${file} is not valid JSON`, EXIT.PRECONDITION, {
      field: file,
      cause: error,
    });
  }
  const parsed = allowlistSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined ? "" : issue.path.join(".");
    throw new ToolkitError(
      `licence allowlist ${file}: ${where} ${issue?.message ?? "invalid"}`.trim(),
      EXIT.PRECONDITION,
      { field: where === "" ? file : `${file}:${where}` },
    );
  }
  return parsed.data;
}

/** `npm ls` exits 1 on any tree problem but still prints the tree; only no tree is fatal. */
function readTree(result: RunResult): LsNode {
  let tree: unknown;
  try {
    tree = JSON.parse(result.stdout);
  } catch {
    tree = undefined;
  }
  if (typeof tree !== "object" || tree === null) {
    const first = firstError(result.stderr);
    throw new ToolkitError(
      `npm ls gave no readable dependency tree — are the dependencies installed?${first === undefined ? "" : ` ${first}`}`,
      EXIT.PRECONDITION,
      { field: "node_modules" },
    );
  }
  return tree as LsNode;
}

interface Located {
  name: string;
  version: string;
  dir?: string;
  missing: boolean;
}

function collect(
  repoRoot: string,
  root: LsNode,
): { entries: Located[]; workspaces: number; notInstalled: number; skippedExtraneous: number } {
  const rootDir = realpathSync(repoRoot);
  const seen = new Map<string, Located>();
  const workspaceNames = new Set<string>();
  let notInstalled = 0;
  const extraneous = new Set<string>();
  const walked = new Set<string>();

  const walk = (node: LsNode, fromDir: string): void => {
    for (const [name, child] of Object.entries(node.dependencies ?? {})) {
      if (child.extraneous === true) {
        // Installed but not part of the closure npm resolves: counted, never judged.
        extraneous.add(`${name}@${child.version ?? "?"}`);
        continue;
      }
      if (child.missing === true) {
        const key = `${name}@${child.version ?? "?"}`;
        if (!seen.has(key)) seen.set(key, { name, version: child.version ?? "?", missing: true });
        continue;
      }
      if (child.version === undefined) {
        // An optional or peer dependency npm did not install: not shipped.
        notInstalled += 1;
        continue;
      }
      const dir = findPackageDir(name, fromDir, rootDir);
      // The repo's own packages: `resolved: file:…`, or — where npm prints a deduped
      // reference without `resolved` — a directory outside any node_modules.
      const own =
        child.resolved?.startsWith("file:") === true ||
        (dir !== undefined && !dir.split(sep).includes("node_modules"));
      if (own) {
        workspaceNames.add(name);
      } else {
        const key = `${name}@${child.version}`;
        if (!seen.has(key)) seen.set(key, { name, version: child.version, dir, missing: false });
      }
      // A deduped node carries no dependencies; the full one is walked once per directory.
      if (Object.keys(child.dependencies ?? {}).length === 0) continue;
      const from = dir ?? fromDir;
      if (walked.has(`${from}\0${name}`)) continue;
      walked.add(`${from}\0${name}`);
      walk(child, from);
    }
  };
  walk(root, rootDir);

  const entries = [...seen.values()].sort((a, b) =>
    a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name),
  );
  return {
    entries,
    workspaces: workspaceNames.size,
    notInstalled,
    skippedExtraneous: extraneous.size,
  };
}

/** Node's lookup: `node_modules/<name>` in the directory and each ancestor. */
function findPackageDir(name: string, fromDir: string, repoRoot: string): string | undefined {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    const parent = dirname(dir);
    if (dir === repoRoot || parent === dir) return undefined;
    dir = parent;
  }
}

interface Read {
  licence: string;
  source: string;
  /** Set when the licence field holds something other than an SPDX expression. */
  invalid?: boolean;
  unreadable?: string;
}

function readLicence(dir: string): Read {
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return { licence: "unreadable", source: "none", unreadable: "package.json not readable" };
  }

  const declared = declaredLicence(manifest);
  if (declared !== undefined && declared !== "*") {
    return { licence: declared, source: "package.json" };
  }
  return fromLicenceFiles(dir);
}

/** `license` (string, or the legacy `{ type }` object) or the legacy `licenses` array. */
function declaredLicence(manifest: Record<string, unknown>): string | undefined {
  const typeOf = (value: unknown): string | undefined => {
    if (typeof value === "string") return value.trim() || undefined;
    if (typeof value === "object" && value !== null) {
      const type = (value as Record<string, unknown>).type;
      if (typeof type === "string") return type.trim() || undefined;
    }
    return undefined;
  };
  const license = typeOf(manifest.license);
  if (license !== undefined) return license;
  if (Array.isArray(manifest.licenses)) {
    const ids = manifest.licenses.map(typeOf).filter((id): id is string => id !== undefined);
    if (ids.length === 1) return ids[0];
    // A legacy list names alternative licences.
    if (ids.length > 1) return `(${ids.join(" OR ")})`;
  }
  return undefined;
}

const LICENCE_FILE = /^(licen[cs]e|copying)/i;

function fromLicenceFiles(dir: string): Read {
  let files: string[];
  try {
    files = readdirSync(dir).filter((file) => LICENCE_FILE.test(file));
  } catch {
    files = [];
  }
  if (files.length === 0) {
    return {
      licence: "unreadable",
      source: "none",
      unreadable: "no licence field and no LICENSE/LICENCE/COPYING file",
    };
  }
  const ids: string[] = [];
  for (const file of files.sort()) {
    let text: string;
    try {
      text = readFileSync(join(dir, file), "utf8");
    } catch {
      return { licence: "unreadable", source: file, unreadable: `${file} not readable` };
    }
    const id = matchLicenceText(text);
    if (id === undefined) {
      return {
        licence: "unreadable",
        source: file,
        unreadable: `no licence field and ${file} matches no known licence text`,
      };
    }
    if (!ids.includes(id)) ids.push(id);
  }
  // Several licence files: every one of them must be allowed (fail-closed).
  return { licence: ids.join(" AND "), source: files.join(", ") };
}

function judge(located: Located, allowlist: Allowlist): InventoryEntry {
  const { name, version } = located;
  const exception = allowlist.exceptions.find(
    (entry) => entry.package === name || entry.package === `${name}@${version}`,
  );

  const base = { name, version };
  if (located.missing) {
    return finding(base, "unreadable", "none", "not installed — run npm ci");
  }
  if (located.dir === undefined) {
    return finding(base, "unreadable", "none", "package directory not found in node_modules");
  }
  const read = readLicence(located.dir);
  const entry = { ...base, licence: read.licence, source: read.source, path: located.dir };

  if (exception !== undefined) {
    const granted = exception.licence;
    const holds =
      granted.toLowerCase() === "unreadable"
        ? read.unreadable !== undefined
        : read.unreadable === undefined && normaliseSpdx(granted) === normaliseSpdx(read.licence);
    if (holds) return { ...entry, verdict: "exception", why: exception.reason };
    return {
      ...entry,
      verdict: "finding",
      why: `exception granted for ${granted}, package now ${read.licence}`,
    };
  }
  if (read.unreadable !== undefined) {
    return { ...entry, verdict: "finding", why: read.unreadable };
  }
  if (read.licence.toUpperCase() === "UNLICENSED") {
    return { ...entry, verdict: "finding", why: "UNLICENSED and not named in the allowlist" };
  }
  const tree = parseSpdx(read.licence);
  if (tree === undefined) {
    return { ...entry, verdict: "finding", why: "not a valid SPDX expression" };
  }
  const allowed = new Set(
    allowlist.licenses.map((id) => id.toUpperCase()).filter((id) => id !== "UNLICENSED"),
  );
  if (!satisfiable(tree, allowed)) {
    return { ...entry, verdict: "finding", why: "not satisfiable from the allowed licences" };
  }
  return { ...entry, verdict: "allowed" };
}

/** SPDX text compared as written, up to whitespace and case (ids and operators are case-insensitive). */
function normaliseSpdx(expression: string): string {
  return expression
    .replace(/\s+/g, " ")
    .replace(/\(\s*/g, "(")
    .replace(/\s*\)/g, ")")
    .trim()
    .toUpperCase();
}

function finding(
  base: { name: string; version: string },
  licence: string,
  source: string,
  why: string,
): InventoryEntry {
  return { ...base, licence, source, verdict: "finding", why };
}
