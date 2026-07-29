/**
 * The output contract (spec §3) — the toolkit's most load-bearing promise.
 *
 *   stdout carries exactly one JSON object. Nothing else, not even progress.
 *   Progress and diagnosis go to stderr. Full command output never reaches
 *   stdout; it goes to a log file and the response carries only the path.
 *
 * This module owns the only stdout writer in the codebase. Two guards keep a
 * later command from breaking the contract:
 *
 *   1. ESLint bars `process.stdout` and `console` everywhere but this file.
 *   2. `emit()` refuses a second call at runtime.
 */

/** Exit codes (spec §4). Their meaning is part of the contract with callers. */
export const EXIT = {
  /** ok */
  OK: 0,
  /** red on the merits — gate failed, postcondition violated after execution */
  FAILED: 1,
  /** unprovable — aborted under foreign load. Not green. Repeat, do not debug. */
  UNPROVABLE: 2,
  /** ambiguous — the decision belongs to the model, not to the toolkit */
  AMBIGUOUS: 3,
  /** precondition violated — missing config, no branch, owner-hold, pause flag */
  PRECONDITION: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** The minimum every response carries (spec §3). Commands add their own fields. */
export interface BaseResponse {
  command: string;
  ok: boolean;
  exit: ExitCode;
  durationMs: number;
  /** Path of this run's log directory, relative to the repo root. */
  logDir?: string;
  /** Short plain-text hints for the model, e.g. why a phase was skipped. */
  notes: string[];
}

export type Response = BaseResponse & Record<string, unknown>;

/**
 * A failure a command can throw to end the run with a defined exit code. The
 * `field` carries the violated config path for exit 4 (spec §5).
 */
export class ToolkitError extends Error {
  readonly exit: ExitCode;
  readonly field?: string;
  readonly reason?: string;

  constructor(
    message: string,
    exit: ExitCode,
    options: { field?: string; reason?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ToolkitError";
    this.exit = exit;
    this.field = options.field;
    this.reason = options.reason;
  }
}

let emitted = false;

/** Test seam — resets the single-write guard. Never called by the CLI. */
export function resetEmitState(): void {
  emitted = false;
}

/** Whether the single JSON object has already been written. */
export function hasEmitted(): boolean {
  return emitted;
}

/** Progress and diagnosis. Always stderr, never part of the contract. */
export function progress(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * Writes the response — the single permitted stdout write of a process.
 *
 * `--human` swaps stdout for a compact text rendering (for the owner at the
 * terminal); the JSON form stays the contract.
 */
export function emit(response: Response, options: { human?: boolean } = {}): void {
  if (emitted) {
    throw new Error(
      `emit() called twice (command "${response.command}") — stdout carries exactly one JSON object (spec §3)`,
    );
  }
  emitted = true;
  process.stdout.write(
    options.human === true ? renderHuman(response) : `${formatJson(response)}\n`,
  );
}

/**
 * Formats the response so its size follows the structural bound of spec §3 (a
 * response grows with the number of phases, tickets or sections, never with the
 * size of their output): one line per top-level field, one line per array
 * element, nested objects compact. Plain `JSON.stringify(…, 2)` would spend six
 * lines on a single gate phase, so the shape of a value would start to count.
 */
export function formatJson(response: Response): string {
  const lines: string[] = ["{"];
  const entries = Object.entries(response).filter(([, value]) => value !== undefined);

  entries.forEach(([key, value], index) => {
    const comma = index === entries.length - 1 ? "" : ",";
    if (Array.isArray(value) && value.length > 0) {
      lines.push(`  ${JSON.stringify(key)}: [`);
      value.forEach((item, itemIndex) => {
        const itemComma = itemIndex === value.length - 1 ? "" : ",";
        lines.push(`    ${JSON.stringify(item)}${itemComma}`);
      });
      lines.push(`  ]${comma}`);
    } else {
      lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)}${comma}`);
    }
  });

  lines.push("}");
  return lines.join("\n");
}

/**
 * Compact text rendering for the terminal. Deliberately flat: one line per
 * scalar, arrays of objects as one line each, deep structures as JSON.
 */
export function renderHuman(response: Response): string {
  const { command, ok, exit, durationMs, logDir, notes, ...rest } = response;
  const lines: string[] = [
    `${ok ? "OK" : "FAIL"}  ${command}  exit ${exit}  ${formatDuration(durationMs)}`,
  ];

  for (const [key, value] of Object.entries(rest)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${formatValue(item)}`);
    } else if (value !== undefined) {
      lines.push(`${key}: ${formatValue(value)}`);
    }
  }

  if (logDir !== undefined) lines.push(`logs: ${logDir}`);
  for (const note of notes) lines.push(`note: ${note}`);

  return `${lines.join("\n")}\n`;
}

function formatValue(value: unknown): string {
  if (value === null || typeof value !== "object") return String(value);
  const entries = Object.entries(value as Record<string, unknown>);
  const flat = entries.every(([, v]) => v === null || typeof v !== "object");
  if (!flat) return JSON.stringify(value);
  return entries.map(([k, v]) => `${k}=${String(v)}`).join(" ");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${Math.round(seconds - minutes * 60)}s`;
}
