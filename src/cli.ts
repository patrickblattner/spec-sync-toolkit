/**
 * CLI entry point and command dispatch (spec §7).
 *
 * Common flags: `--human` · `--json` (default) · `--config <path>` ·
 * `--dry-run` (where mutating) · `--repo <path>` (default: cwd).
 *
 * Commands register themselves in `COMMANDS`. The dispatcher owns the whole
 * envelope — timing, exit code, the single `emit()` — so a command returns data
 * and never touches stdout itself (spec §3).
 */

import { resolve } from "node:path";
import { loadConfig, type Config } from "./config.js";
import { loadNorms } from "./norms.js";
import { EXIT, ToolkitError, emit, progress, type ExitCode, type Response } from "./output.js";

export interface Flags {
  human: boolean;
  dryRun: boolean;
  config?: string;
  repo?: string;
}

export interface ParsedArgv {
  command?: string;
  flags: Flags;
  args: string[];
}

export interface CommandContext {
  flags: Flags;
  args: string[];
  repoRoot: string;
  /** Validated config. Only present for commands declaring `needsConfig`. */
  config?: Config;
}

/** What a command returns; the dispatcher wraps it into the response envelope. */
export interface CommandResult {
  ok: boolean;
  exit?: ExitCode;
  notes?: string[];
  logDir?: string;
  data?: Record<string, unknown>;
}

export interface Command {
  name: string;
  summary: string;
  needsConfig: boolean;
  run(ctx: CommandContext): Promise<CommandResult> | CommandResult;
}

/**
 * The registration point. M2–M4 add `gate`, `queue`, `pack`, `merge`, `lenses`,
 * `report` and `doctor` here; nothing else about dispatch has to change.
 */
export const COMMANDS = new Map<string, Command>();

export function registerCommand(command: Command): void {
  COMMANDS.set(command.name, command);
}

/**
 * Dummy command proving dispatch and the output contract end to end: it loads
 * the config (so an invalid one surfaces as exit 4 with the field) and reports
 * the runtime facts a caller can verify — Node version, norm source, project.
 */
registerCommand({
  name: "ping",
  summary: "Verify config, runtime and output contract without touching the repo",
  needsConfig: true,
  run(ctx) {
    const { norms, source, pinnedHash } = loadNorms();
    return {
      ok: true,
      notes: source === "defaults" ? ["norms come from the built-in defaults (spec §6)"] : [],
      data: {
        project: ctx.config?.project,
        node: process.version,
        repoRoot: ctx.repoRoot,
        norms: { source, hold: norms.hold, buildLabel: norms.buildLabel, pinnedHash },
      },
    };
  },
});

// Wired last, after COMMANDS exists. `commands/index.ts` imports only the
// `Command` type from here, so this is not a runtime cycle.
const { ALL_COMMANDS } = await import("./commands/index.js");
for (const command of ALL_COMMANDS) registerCommand(command);

const FLAGS_WITH_VALUE = new Set(["--config", "--repo"]);

export function parseArgv(argv: string[]): ParsedArgv {
  const flags: Flags = { human: false, dryRun: false };
  const args: string[] = [];
  let command: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (FLAGS_WITH_VALUE.has(token)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new ToolkitError(`${token} needs a value`, EXIT.PRECONDITION, { field: token });
      }
      if (token === "--config") flags.config = value;
      else flags.repo = value;
      i += 1;
    } else if (token === "--human") {
      flags.human = true;
    } else if (token === "--json") {
      flags.human = false;
    } else if (token === "--dry-run") {
      flags.dryRun = true;
    } else if (token.startsWith("-")) {
      // Command-specific flags (`--profile`, `--check`, `--branch`, `--base`, `--run`, …)
      // are passed through untouched. The dispatcher deliberately does NOT know them:
      // a central flag catalogue would make cli.ts a file every command has to edit.
      // Each command parses and validates its own options and raises exit 4 with the
      // offending field — typo detection stays, ownership moves to where it belongs.
      args.push(token);
    } else if (command === undefined) {
      command = token;
    } else {
      args.push(token);
    }
  }

  return { command, flags, args };
}

/**
 * Runs one invocation: parse, dispatch, emit exactly once. Returns the exit
 * code instead of calling `process.exit`, so stdout is flushed by Node itself
 * and tests can drive the same path the binary takes.
 */
export async function run(argv: string[]): Promise<ExitCode> {
  const startedAt = Date.now();
  let commandName = "spec-sync";

  try {
    const { command, flags, args } = parseArgv(argv);
    if (command === undefined) {
      throw new ToolkitError(
        `no command given — known: ${[...COMMANDS.keys()].join(", ")}`,
        EXIT.PRECONDITION,
        { field: "command" },
      );
    }
    commandName = command;

    const entry = COMMANDS.get(command);
    if (entry === undefined) {
      throw new ToolkitError(
        `unknown command "${command}" — known: ${[...COMMANDS.keys()].join(", ")}`,
        EXIT.PRECONDITION,
        { field: "command" },
      );
    }

    const repoRoot = resolve(flags.repo ?? process.cwd());
    progress(`spec-sync ${command} — ${repoRoot}`);

    const ctx: CommandContext = {
      flags,
      args,
      repoRoot,
      config: entry.needsConfig ? loadConfig(repoRoot, flags.config) : undefined,
    };

    const result = await entry.run(ctx);
    const exit = result.exit ?? (result.ok ? EXIT.OK : EXIT.FAILED);
    emit(
      envelope(command, result.ok, exit, startedAt, result.notes ?? [], result.logDir, result.data),
      {
        human: flags.human,
      },
    );
    return exit;
  } catch (error) {
    const exit = error instanceof ToolkitError ? error.exit : EXIT.FAILED;
    const message = error instanceof Error ? error.message : String(error);
    const data: Record<string, unknown> = { error: message };
    if (error instanceof ToolkitError) {
      if (error.field !== undefined) data.field = error.field;
      if (error.reason !== undefined) data.reason = error.reason;
    }
    emit(envelope(commandName, false, exit, startedAt, [], undefined, data), {
      human: isHumanFlag(argv),
    });
    return exit;
  }
}

function envelope(
  command: string,
  ok: boolean,
  exit: ExitCode,
  startedAt: number,
  notes: string[],
  logDir: string | undefined,
  data: Record<string, unknown> | undefined,
): Response {
  const response: Response = {
    command,
    ok,
    exit,
    durationMs: Date.now() - startedAt,
    notes,
    ...(data ?? {}),
  };
  if (logDir !== undefined) response.logDir = logDir;
  return response;
}

/** `--human` has to be honoured even when argv parsing itself failed. */
function isHumanFlag(argv: string[]): boolean {
  const human = argv.lastIndexOf("--human");
  const json = argv.lastIndexOf("--json");
  return human !== -1 && human > json;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${resolve(process.argv[1])}`;

if (invokedDirectly) {
  process.exitCode = await run(process.argv.slice(2));
}
