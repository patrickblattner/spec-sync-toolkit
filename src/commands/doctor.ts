/**
 * `doctor` — five checks and the leftovers of aborted runs (spec §7.7,
 * SST-DESIGN-022 rev 13).
 *
 * `spec-sync doctor`
 *
 * Checks exactly: every `npx … spec-sync` (with or without `--no-install`) in
 * the GL-SEC-011 places — pre-push hook, workflows, `scripts/`, `package.json`,
 * `CLAUDE.md`, `AGENTS.md`, the Claude settings — and a copy of the public npm
 * package `spec-sync` in the user's npx cache; `review.riskGlobs` present and
 * valid in the config (a missing config is the same finding; skipped in phase
 * `development`, PROC-REL-009); a retired top-level config key; a `spec-pins.json` that exists
 * but is not a valid map; a lying `.spec-sync-pause`. Agent types, skill
 * tables, labels, pins as a duty and norm revisions are the lead's business
 * (PROC-DEV-001), not doctor's. Findings are reported, never fixed.
 *
 * Exit 1 on at least one finding.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import picomatch from "picomatch";
import { homedir } from "node:os";
import { join, relative as relativeTo } from "node:path";
import type { Command, CommandContext, CommandResult } from "../cli.js";
import { loadConfig, retiredKeysOf, type Config } from "../config.js";
import { readLedger } from "../ledger.js";
import { createLogDir, protectedLogDirs, writePhaseLog } from "../logs.js";
import { EXIT } from "../output.js";
import { checkFlags } from "../pack/args.js";
import { defaultTools, failureLine, type Tools } from "../pack/exec.js";
import { findOrphans } from "../pack/orphans.js";
import { readPinsFile } from "../pins.js";

const PINS_FILE = "spec-pins.json";
const PAUSE_FILE = ".spec-sync-pause";
const WORKFLOWS_DIR = join(".github", "workflows");

/** How many findings the response itself carries; the rest lives in the log. */
const MAX_LISTED_FINDINGS = 8;

export interface DoctorDeps {
  tools: Tools;
  /** The npm cache root whose `_npx/` folders are scanned — a seam for tests. */
  npmCache: string;
}

/** The npm cache of the current user: `npm_config_cache` / `NPM_CONFIG_CACHE`, else `~/.npm`. */
export function defaultNpmCache(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.npm_config_cache || env.NPM_CONFIG_CACHE || join(home, ".npm");
}

export const doctorCommand: Command = {
  name: "doctor",
  summary:
    "Report npx calls of spec-sync, missing risk globs, retired config keys, an invalid pin file, the pause flag and leftovers",
  needsConfig: false,
  run: (ctx) =>
    runDoctor(ctx, {
      tools: defaultTools(ctx.repoRoot),
      npmCache: defaultNpmCache(),
    }),
};

export interface Finding {
  check: string;
  detail: string;
}

export async function runDoctor(ctx: CommandContext, deps: DoctorDeps): Promise<CommandResult> {
  checkFlags(ctx.args, []);

  const findings: Finding[] = [];
  const notes: string[] = [];
  const details: string[] = [];
  const add = (check: string, detail: string): void => void findings.push({ check, detail });

  checkRiskGlobs(ctx, deps.tools, add);
  checkRetiredKeys(ctx, add);
  checkPins(ctx.repoRoot, add);
  checkPause(ctx.repoRoot, add);
  checkNpxCalls(ctx.repoRoot, add);
  checkNpxCache(deps.npmCache, add);

  // Leftovers of aborted runs (spec §7.7): worktrees and branches.
  const orphans = findOrphans({
    tools: deps.tools,
    repoRoot: ctx.repoRoot,
    openIssues: openIssues(deps.tools),
  });
  findings.push(...orphans.findings);
  notes.push(...orphans.notes);
  details.push(...orphans.details);

  const logDir =
    findings.length === 0
      ? undefined
      : writeReport(ctx.repoRoot, findings, details, ctx.config?.logRetention);
  const listed = findings
    .slice(0, MAX_LISTED_FINDINGS)
    .map((finding) => `${finding.check}: ${finding.detail}`);
  if (findings.length > listed.length) {
    listed.push(`… ${findings.length - listed.length} more, see ${logDir}`);
  }

  return {
    ok: findings.length === 0,
    exit: findings.length === 0 ? EXIT.OK : EXIT.FAILED,
    notes,
    logDir,
    data: { findings: listed },
  };
}

type Add = (check: string, detail: string) => void;

/**
 * `review.riskGlobs` (SST-DESIGN-022 rev 13): without the list the automatic
 * Codex pass on risk paths never runs (PROC-DEV-002), and nothing else would
 * notice. A config that is missing or does not load is the same finding; so
 * is an empty list, an area without globs, and a glob that matches no tracked
 * file — each guards nothing. PROC-DEV-002 binds only in phase `production`
 * (PROC-REL-009), so a config with `phase: "development"` skips the check; an
 * absent phase runs it.
 */
function checkRiskGlobs(ctx: CommandContext, tools: Tools, add: Add): void {
  let config: Config;
  try {
    config = loadConfig(ctx.repoRoot, ctx.flags.config);
  } catch (error) {
    add(
      "review-globs",
      `no usable config, so no review.riskGlobs — the Codex pass on risk paths never runs: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  if (config.phase === "development") return;

  const areas = Object.entries(config.review.riskGlobs);
  if (areas.length === 0) {
    add(
      "review-globs",
      "review.riskGlobs is missing or empty — the Codex pass on risk paths never runs (PROC-DEV-002)",
    );
    return;
  }
  const listed = tools.run("git", ["ls-files"]);
  if (!listed.ok) {
    add("review-globs", `git ls-files failed: ${failureLine(listed)}`);
    return;
  }
  const files = listed.stdout.split("\n").filter((line) => line !== "");
  for (const [area, globs] of areas) {
    if (globs.length === 0) add("review-globs", `riskGlobs.${area} lists no glob`);
    for (const glob of globs) {
      if (!files.some((file) => picomatch.isMatch(file, glob))) {
        add("review-globs", `riskGlobs.${area} "${glob}" matches no file`);
      }
    }
  }
}

/** A retired top-level config key loads without effect; each one is reported for deletion (SST-DESIGN-022 rev 13). */
function checkRetiredKeys(ctx: CommandContext, add: Add): void {
  for (const key of retiredKeysOf(ctx.repoRoot, ctx.flags.config)) {
    add(
      "config-retired",
      `${key} in spec-sync.config.json is retired since 0.55.0 and has no effect — delete it`,
    );
  }
}

/** Whether a repo keeps a pin file is its lead's call (SST-DESIGN-025 rev 6); one it keeps must parse. */
function checkPins(repoRoot: string, add: Add): void {
  if (!existsSync(join(repoRoot, PINS_FILE))) return;
  if (readPinsFile(repoRoot) === undefined) {
    add("pins", `${PINS_FILE} is not a valid {key: rev} map`);
  }
}

/** A lying pause flag is reported, never removed (SST-DESIGN-022 rev 13). */
function checkPause(repoRoot: string, add: Add): void {
  if (existsSync(join(repoRoot, PAUSE_FILE))) {
    add("pause", `${PAUSE_FILE} exists — the loop is paused`);
  }
}

interface HookSource {
  /** Repo-relative file the text came from. */
  file: string;
  text: string;
}

/**
 * Where a repo defines its pre-push hook: `.husky/pre-push`, `.githooks/pre-push`,
 * or the `pre-push` entry of `simple-git-hooks` (or legacy `husky.hooks`) in
 * `package.json`. Each source is followed one step into the files and npm
 * scripts it calls (`node scripts/prePush.mjs`, `npm run verify`), so a hook
 * that delegates still counts. The first returned source is the entry point.
 */
export function prePushSources(repoRoot: string): HookSource[] {
  const read = (file: string): string | undefined => {
    const path = join(repoRoot, file);
    try {
      return existsSync(path) ? readFileSync(path, "utf8") : undefined;
    } catch {
      return undefined;
    }
  };

  let scripts: Record<string, string> = {};
  const entries: HookSource[] = [];
  for (const file of [join(".husky", "pre-push"), join(".githooks", "pre-push")]) {
    const text = read(file);
    if (text !== undefined) entries.push({ file, text });
  }
  const pkgText = read("package.json");
  if (pkgText !== undefined) {
    try {
      const pkg = JSON.parse(pkgText) as {
        scripts?: Record<string, string>;
        "simple-git-hooks"?: Record<string, string>;
        husky?: { hooks?: Record<string, string> };
      };
      scripts = pkg.scripts ?? {};
      const command = pkg["simple-git-hooks"]?.["pre-push"] ?? pkg.husky?.hooks?.["pre-push"];
      if (typeof command === "string") entries.push({ file: "package.json", text: command });
    } catch {
      // An unreadable package.json is not this check's finding.
    }
  }

  const sources = [...entries];
  const seen = new Set(sources.map((source) => source.file));
  for (const source of entries) {
    for (const match of source.text.matchAll(/npm\s+run(?:-script)?\s+([\w:.-]+)/gu)) {
      const name = match[1] as string;
      const script = scripts[name];
      const key = `package.json#${name}`;
      if (script !== undefined && !seen.has(key)) {
        seen.add(key);
        sources.push({ file: key, text: script });
      }
    }
    for (const match of source.text.matchAll(
      /(?:node|sh|bash|zsh|tsx)\s+["']?((?:\.\/)?[\w./-]+\.(?:mjs|cjs|js|ts|sh))/gu,
    )) {
      const file = (match[1] as string).replace(/^\.\//u, "");
      if (seen.has(file)) continue;
      const text = read(file);
      if (text !== undefined) {
        seen.add(file);
        sources.push({ file, text });
      }
    }
  }
  return sources;
}

/**
 * `npx` followed by `spec-sync`, whatever flags stand between (`--no-install`
 * included). Quotes, commas and brackets are blanked length-preserving, so
 * `spawnSync("npx", ["--no-install", "spec-sync", …])` matches across lines and
 * the match offset still gives the line.
 */
const NPX_CALL = /\bnpx(?:\s+-\S+)*\s+spec-sync(?![\w-])/gu;

/** 1-based lines of the text that run `spec-sync` through npx. */
export function npxSpecSyncLines(text: string): number[] {
  const blanked = text.replace(/["'`,[\]()]/gu, " ");
  return [...blanked.matchAll(NPX_CALL)].map(
    (match) => blanked.slice(0, match.index).split("\n").length,
  );
}

/** Every file below `dir`, repo-relative; missing directory → none. */
function filesBelow(repoRoot: string, dir: string): string[] {
  const path = join(repoRoot, dir);
  if (!existsSync(path)) return [];
  return readdirSync(path, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relativeTo(repoRoot, join(entry.parentPath, entry.name)));
}

/** Root files agents read or act on; `package.json` is read whole, with line numbers. */
const AGENT_FILES = [
  "CLAUDE.md",
  "AGENTS.md",
  "package.json",
  join(".claude", "settings.json"),
  join(".claude", "settings.local.json"),
];

/**
 * Own tools are never called through npx: a bare `npx spec-sync` downloads the
 * unrelated public npm package of that name when the local bin is missing, and
 * `npx --no-install spec-sync` still runs a copy of it that already lies in the
 * npx cache. Scanned: the pre-push hook and what it calls, workflows,
 * `scripts/`, and the agent files (an allow rule `Bash(npx spec-sync *)` included).
 */
function checkNpxCalls(repoRoot: string, add: Add): void {
  // package.json entries of the hook are excerpts; the whole file is read below.
  const sources = prePushSources(repoRoot).filter(
    (source) => !source.file.startsWith("package.json"),
  );
  const seen = new Set(sources.map((source) => source.file));
  const files = [
    ...AGENT_FILES.filter((file) => existsSync(join(repoRoot, file))),
    ...filesBelow(repoRoot, WORKFLOWS_DIR).filter((file) => /\.ya?ml$/u.test(file)),
    ...filesBelow(repoRoot, "scripts").filter(
      (file) => !/(?:^|[\\/])node_modules[\\/]|\.md$/u.test(file),
    ),
  ];
  for (const file of files) {
    if (seen.has(file)) continue;
    seen.add(file);
    try {
      sources.push({ file, text: readFileSync(join(repoRoot, file), "utf8") });
    } catch {
      // An unreadable file is not this check's finding.
    }
  }
  for (const source of sources) {
    for (const line of npxSpecSyncLines(source.text)) {
      add(
        "npx",
        `${source.file}:${line} runs \`spec-sync\` through npx — call \`node_modules/.bin/spec-sync …\` (shell) or \`spawnSync(process.execPath, [fileURLToPath(import.meta.resolve("spec-sync-toolkit/dist/cli.js")), …])\` (Node); npx may run the unrelated public npm package of that name, even with --no-install`,
      );
    }
  }
}

/** Does an npx cache manifest name the public package `spec-sync`? */
function namesSpecSync(manifest: unknown): boolean {
  if (typeof manifest !== "object" || manifest === null) return false;
  const pkg = manifest as Record<string, unknown>;
  if (pkg.name === "spec-sync") return true;
  return ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].some(
    (field) => {
      const deps = pkg[field];
      return typeof deps === "object" && deps !== null && Object.hasOwn(deps, "spec-sync");
    },
  );
}

/**
 * A copy of the public npm package `spec-sync` in the npx cache
 * (`<cache>/_npx/<hash>/package.json`) is what `npx --no-install spec-sync`
 * runs when the local bin is missing. Each such folder is reported.
 */
function checkNpxCache(npmCache: string, add: Add): void {
  const npxDir = join(npmCache, "_npx");
  let entries: string[];
  try {
    entries = readdirSync(npxDir);
  } catch {
    return; // No npx cache, nothing cached.
  }
  for (const entry of entries.sort()) {
    const folder = join(npxDir, entry);
    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(join(folder, "package.json"), "utf8"));
    } catch {
      continue; // Not an npx install folder, or unreadable — not this check's finding.
    }
    if (namesSpecSync(manifest)) {
      add(
        "npx-cache",
        `${folder} holds the public npm package \`spec-sync\` — npx runs it in place of the toolkit when the local bin is missing; delete that folder`,
      );
    }
  }
}

/**
 * Open issue numbers, for the leftover checks. `undefined` when `gh` cannot
 * answer — the caller then judges nothing by ticket instead of guessing.
 */
function openIssues(tools: Tools): Set<number> | undefined {
  const result = tools.run("gh", [
    "issue",
    "list",
    "--state",
    "open",
    "--limit",
    "500",
    "--json",
    "number",
  ]);
  if (!result.ok) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as { number?: number }[];
    return new Set(parsed.flatMap((entry) => (entry.number === undefined ? [] : [entry.number])));
  } catch {
    return undefined;
  }
}

/** The full report goes to the log directory; the response carries the path (spec §3). */
function writeReport(
  repoRoot: string,
  findings: Finding[],
  details: string[],
  retention?: number,
): string {
  const logDir = createLogDir(repoRoot, {
    retention,
    keep: protectedLogDirs(readLedger(repoRoot).events),
  });
  const report = [
    `spec-sync doctor — ${findings.length} finding(s)`,
    "",
    ...findings.map((finding, index) => `${index + 1}. [${finding.check}] ${finding.detail}`),
    ...(details.length === 0 ? [] : ["", "--- details ---", "", ...details]),
    "",
  ].join("\n");
  writePhaseLog(repoRoot, logDir, "doctor", report);
  return logDir;
}
