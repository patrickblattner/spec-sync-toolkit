/**
 * `prepush` — the light preflight of a pre-push hook (PROC-DEV-005 rev 7,
 * §Preflight on every push, light; register #1979).
 *
 *   <git pre-push stdin> | spec-sync prepush [--cap-min <minutes>]
 *
 * The repo's hook hands git's pre-push stdin on (`<local ref> <local sha>
 * <remote ref> <remote sha>` per line). A push that changes no code skips the
 * preflight with exit 0: only tags, only branch deletes, or commits that change
 * nothing but `spec-pins.json` and `.spec-sync/drift-coverage.jsonl` (diffed
 * against the remote sha, or against the merge-base with `origin/main` for a
 * new branch). Every other push runs `gate --profile merge --preflight
 * --changed` in the repo root, which the caller keeps at the pushed tree.
 *
 * The run has a hard cap (default 10 min). Past it the whole process group of
 * the gate is ended (SIGTERM, then SIGKILL), the gate.lock and box slot it held
 * are released, and the command says so and exits 0: the push goes through and
 * the runner's required check decides. A preflight that ends within the cap
 * passes its exit code through — a red one refuses the push.
 *
 * Without ref lines on stdin the preflight runs: a hook that forgot to hand its
 * stdin on must check more, never less. The WIP escape and the secret guard
 * stay in the repo's hook.
 */

import { execFileSync, spawn } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import type { Command, CommandContext, CommandResult } from "../cli.js";
import { EXIT, ToolkitError, passedExit, progress } from "../output.js";
import { checkFlags, valueFlag } from "../pack/args.js";
import { processAlive, readRecord } from "../gate/holder.js";
import { LOCK_FILE } from "../gate/lock.js";
import { boxDir, slotCount, slotPaths } from "../gate/slots.js";

const USAGE = "usage: <pre-push stdin> | spec-sync prepush [--cap-min <minutes>]";
/** The hard cap of PROC-DEV-005 rev 7. */
export const DEFAULT_CAP_MIN = 10;
/** After SIGTERM at the cap, the group gets this long before SIGKILL. */
const KILL_GRACE_MS = 5_000;
/** Files whose change alone is no code change (PROC-DEV-005 §Pins with the change). */
export const NO_CODE_FILES: ReadonlySet<string> = new Set([
  "spec-pins.json",
  ".spec-sync/drift-coverage.jsonl",
]);
/** The base a new branch is measured against, first candidate first. */
const NEW_BRANCH_BASES = ["origin/main", "main"];
const ZERO_SHA = /^0+$/u;

export interface PushedRef {
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
}

export interface Plan {
  run: boolean;
  reason: string;
}

export interface PrePushDeps {
  /** git's pre-push stdin. */
  readStdin: () => string;
  /** The gate invocation, without its arguments. */
  gate: string[];
  /** Length of a cap minute; tests shorten it. */
  minuteMs: number;
  graceMs: number;
}

const defaultDeps = (): PrePushDeps => ({
  readStdin: () => {
    if (process.stdin.isTTY) return "";
    try {
      return readFileSync(0, "utf8");
    } catch {
      return "";
    }
  },
  // The same binary that runs this command: node + the cli entry.
  gate: [process.execPath, process.argv[1] as string],
  minuteMs: 60_000,
  graceMs: KILL_GRACE_MS,
});

export const prepushCommand: Command = {
  name: "prepush",
  summary:
    "Light pre-push preflight (PROC-DEV-005 rev 7): skips code-free pushes, caps the run at 10 min",
  needsConfig: false,
  run: (ctx) => runPrePush(ctx),
};

export function parseRefLines(text: string): PushedRef[] {
  const refs: PushedRef[] = [];
  for (const raw of text.split("\n")) {
    const [localRef, localSha, remoteRef, remoteSha] = raw.trim().split(/\s+/u);
    if (localRef && localSha && remoteRef && remoteSha) {
      refs.push({ localRef, localSha, remoteRef, remoteSha });
    }
  }
  return refs;
}

const isDelete = (ref: PushedRef): boolean => ZERO_SHA.test(ref.localSha);
const isTag = (ref: PushedRef): boolean =>
  ref.localRef.startsWith("refs/tags/") || ref.remoteRef.startsWith("refs/tags/");

/**
 * Does the push carry code? `changedFiles(ref)` lists the files the ref's
 * commits change, or `undefined` when there is no base to diff against — then
 * the preflight runs.
 */
export function planPrePush(
  refs: PushedRef[],
  changedFiles: (ref: PushedRef) => string[] | undefined,
): Plan {
  if (refs.length === 0) {
    return {
      run: true,
      reason: "no ref lines on stdin — the hook must hand git's pre-push stdin on",
    };
  }
  const content = refs.filter((ref) => !isDelete(ref) && !isTag(ref));
  if (content.length === 0) {
    return { run: false, reason: "only tags and branch deletes are pushed" };
  }
  for (const ref of content) {
    const files = changedFiles(ref);
    if (files === undefined) {
      return { run: true, reason: `no base to diff ${ref.remoteRef} against` };
    }
    const code = files.find((file) => !NO_CODE_FILES.has(file));
    if (code !== undefined) {
      return { run: true, reason: `${ref.remoteRef} changes code (${code})` };
    }
  }
  return {
    run: false,
    reason: "the pushed commits change only spec pins and drift coverage",
  };
}

function git(repoRoot: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/** The files `ref` changes against what the remote has, or `undefined` without a base. */
export function changedFilesOf(repoRoot: string, ref: PushedRef): string[] | undefined {
  let base: string | undefined;
  if (
    !ZERO_SHA.test(ref.remoteSha) &&
    git(repoRoot, ["cat-file", "-e", `${ref.remoteSha}^{commit}`]) !== undefined
  ) {
    base = ref.remoteSha;
  } else {
    for (const candidate of NEW_BRANCH_BASES) {
      base = git(repoRoot, ["merge-base", candidate, ref.localSha]);
      if (base) break;
    }
  }
  if (!base) return undefined;
  const out = git(repoRoot, ["diff", "--name-only", "--no-renames", base, ref.localSha]);
  if (out === undefined) return undefined;
  return out.split("\n").filter((line) => line !== "");
}

export async function runPrePush(
  ctx: CommandContext,
  deps: PrePushDeps = defaultDeps(),
): Promise<CommandResult> {
  checkFlags(ctx.args, ["--cap-min"]);
  const cap = valueFlag(ctx.args, "--cap-min") ?? String(DEFAULT_CAP_MIN);
  if (!/^\d+$/u.test(cap) || Number(cap) < 1) {
    throw new ToolkitError(`--cap-min must be a whole number ≥ 1 — ${USAGE}`, EXIT.PRECONDITION, {
      field: "--cap-min",
    });
  }
  const capMin = Number(cap);

  const refs = parseRefLines(deps.readStdin());
  const plan = planPrePush(refs, (ref) => changedFilesOf(ctx.repoRoot, ref));
  if (!plan.run) {
    progress(`• pre-push: preflight skipped — ${plan.reason}`);
    return {
      ok: true,
      notes: [`preflight skipped: ${plan.reason}`],
      data: { preflight: "skipped", reason: plan.reason },
    };
  }

  progress(`• pre-push: light preflight (cap ${capMin} min) — ${plan.reason}`);
  const [cmd, ...pre] = deps.gate;
  const outcome = await runCapped(
    cmd as string,
    [...pre, "gate", "--profile", "merge", "--preflight", "--changed"],
    ctx.repoRoot,
    capMin * deps.minuteMs,
    deps.graceMs,
  );

  if (outcome.capped) {
    const released = outcome.pid === undefined ? [] : releaseHeldBy(outcome.pid, ctx.repoRoot);
    const notice = `preflight passed its cap of ${capMin} min and was ended with all its child processes — the push goes through, the runner's required check decides (PROC-DEV-005 rev 7)`;
    progress(`• pre-push: ${notice}`);
    return {
      ok: true,
      exit: EXIT.OK,
      notes: [notice, ...(released.length > 0 ? [`released ${released.join(", ")}`] : [])],
      data: { preflight: "capped", reason: plan.reason, cap_min: capMin, released },
    };
  }

  const gate = parseGateResponse(outcome.stdout);
  const notes = [...(gate.notes ?? [])];
  if (outcome.error !== undefined) notes.push(`preflight could not run: ${outcome.error}`);
  return {
    ok: outcome.code === 0,
    exit: outcome.code === 0 ? EXIT.OK : passedExit(outcome.code),
    notes,
    ...(gate.logDir === undefined ? {} : { logDir: gate.logDir }),
    data: {
      preflight: "ran",
      reason: plan.reason,
      cap_min: capMin,
      gate_exit: outcome.code,
      ...(gate.failures === undefined ? {} : { failures: gate.failures }),
      ...(gate.error === undefined ? {} : { error: gate.error }),
    },
  };
}

interface GateResponse {
  notes?: string[];
  logDir?: string;
  failures?: unknown[];
  error?: string;
}

function parseGateResponse(stdout: string): GateResponse {
  try {
    const parsed = JSON.parse(stdout) as GateResponse | null;
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface Outcome {
  code: number;
  capped: boolean;
  stdout: string;
  pid?: number;
  error?: string;
}

/**
 * Runs the gate in its own process group. At the cap the whole group gets
 * SIGTERM, after `graceMs` SIGKILL; the promise settles only once the group is
 * gone, so no eslint or npm child outlives the hook. Signals sent to this
 * process are passed on to the group — a detached group no longer gets the
 * terminal's Ctrl-C by itself.
 */
function runCapped(
  cmd: string,
  args: string[],
  cwd: string,
  capMs: number,
  graceMs: number,
): Promise<Outcome> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, detached: true, stdio: ["ignore", "pipe", "inherit"] });
    const pid = child.pid;
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    const signalGroup = (signal: NodeJS.Signals): void => {
      try {
        if (pid !== undefined) process.kill(-pid, signal);
      } catch {
        // the group is gone already
      }
    };
    const forward = (signal: NodeJS.Signals): void => signalGroup(signal);
    const forwarded: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
    for (const signal of forwarded) process.on(signal, forward);

    let settled = false;
    let capped = false;
    let exited = false;
    const timers: NodeJS.Timeout[] = [];
    const done = (outcome: Outcome): void => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      for (const signal of forwarded) process.off(signal, forward);
      child.stdout?.destroy();
      resolve(outcome);
    };
    const settleWhenGone = (): void => {
      if (!exited || pid === undefined) return;
      if (!groupAlive(pid)) {
        done({ code: 0, capped: true, stdout, pid });
        return;
      }
      timers.push(setTimeout(settleWhenGone, 100));
    };

    timers.push(
      setTimeout(() => {
        capped = true;
        signalGroup("SIGTERM");
        timers.push(setTimeout(() => signalGroup("SIGKILL"), graceMs));
        settleWhenGone();
      }, capMs),
    );
    child.on("error", (error) => {
      exited = true;
      done({ code: 127, capped: false, stdout, error: error.message });
    });
    child.on("exit", (code, signal) => {
      exited = true;
      if (capped) {
        settleWhenGone();
        return;
      }
      done({
        code: code ?? 128 + (signal === null ? 0 : (constants.signals[signal] ?? 0)),
        capped: false,
        stdout,
        ...(pid === undefined ? {} : { pid }),
      });
    });
  });
}

/**
 * Removes the gate.lock, box slots and box queue entries a killed gate of
 * `pid` still held — the gate never reached its own `finally`. Returns their
 * labels.
 */
export function releaseHeldBy(pid: number, repoRoot: string): string[] {
  if (processAlive(pid)) return [];
  const released: string[] = [];
  const box = boxDir();
  const locks: [string, string][] = [
    ["gate.lock", join(repoRoot, LOCK_FILE)],
    ...slotPaths(box, slotCount(box)).map((path): [string, string] => [
      path
        .split(/[\\/]/u)
        .pop()
        ?.replace(/\.lock$/u, "") ?? path,
      path,
    ]),
  ];
  for (const [label, path] of locks) {
    const read = readRecord(path);
    if (read.state === "held" && read.record.pid === pid) {
      rmSync(path, { force: true });
      released.push(label);
    }
  }
  let names: string[] = [];
  try {
    names = readdirSync(box);
  } catch {
    // no box directory, nothing queued
  }
  for (const name of names) {
    if (!name.startsWith("queue-") || !name.endsWith(".json")) continue;
    const path = join(box, name);
    try {
      const entry = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown } | null;
      if (entry?.pid === pid) {
        rmSync(path, { force: true });
        released.push(`queue entry ${name}`);
      }
    } catch {
      // gone or unreadable
    }
  }
  return released;
}
