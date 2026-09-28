/**
 * `measure` — changes a tracked file a gate step measures against and binds
 * every change to a decision in the register (SST-DESIGN-002, PROC-DEV-047).
 *
 * `spec-sync measure set <file> <pointer> <value> --register <n> [--server <url>]`
 * `spec-sync measure remove <file> <pointer> --register <n> [--server <url>]`
 *
 * `--set <pointer>=<value>` and `--remove <pointer>` add further changes to the
 * same file and may each be repeated; all changes apply in argument order,
 * positional one first, as a whole or not at all. `<value>` is taken as JSON
 * when it parses, otherwise as a plain string.
 *
 * Before any write: the file is listed under `measureFiles`, every pointer
 * resolves in the current file, and decision `<n>` is readable from the spec
 * server (`GET /api/decisions/<n>`). Any of these fails ⇒ exit 4, nothing
 * written. The command never judges whether the decision covers the change —
 * it proves that one exists and records which one was named. It writes the
 * working tree only: never commits, never pushes, never touches the gate.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  applyEdits,
  findNodeAtLocation,
  modify,
  parseTree,
  type Edit,
  type Node,
} from "jsonc-parser";
import type { Command, CommandContext, CommandResult } from "../cli.js";
import type { Config } from "../config.js";
import { EXIT, ToolkitError } from "../output.js";
import { checkFlags, positionals, valueFlag } from "../pack/args.js";
import { resolveServer } from "./repin.js";

export const MEASURE_LEDGER = ".spec-sync/measure-changes.jsonl";

const DECISION_TIMEOUT_MS = 10_000;

export const measureCommand: Command = {
  name: "measure",
  summary: "Change a measure file, bound to a decision in the register",
  needsConfig: true,
  run: (ctx) => runMeasure(ctx),
};

const VALUE_FLAGS = ["--set", "--remove", "--register", "--server"];

interface Change {
  op: "set" | "remove";
  pointer: string;
  from: unknown;
  to: unknown;
}

type Container = Record<string, unknown> | unknown[];

export async function runMeasure(ctx: CommandContext): Promise<CommandResult> {
  checkFlags(ctx.args, VALUE_FLAGS);
  const config = ctx.config as Config;

  const register = valueFlag(ctx.args, "--register");
  if (register === undefined || !/^[1-9]\d*$/.test(register)) {
    throw new ToolkitError(
      "measure needs --register <n>, the number of a decision in the register",
      EXIT.PRECONDITION,
      { field: "--register" },
    );
  }

  const [verb, fileArg, ...rest] = positionals(ctx.args, VALUE_FLAGS);
  if ((verb !== "set" && verb !== "remove") || fileArg === undefined) {
    throw new ToolkitError(
      "usage: measure set <file> <pointer> <value> | measure remove <file> <pointer>",
      EXIT.PRECONDITION,
      { field: "command" },
    );
  }
  const requested = requestedChanges(verb, rest, ctx.args);

  const file = relative(ctx.repoRoot, resolve(ctx.repoRoot, fileArg));
  const listed = config.measureFiles.map((entry) =>
    relative(ctx.repoRoot, resolve(ctx.repoRoot, entry)),
  );
  if (!listed.includes(file)) {
    throw new ToolkitError(
      `${file} is not listed under measureFiles — nothing written`,
      EXIT.PRECONDITION,
      { field: "measureFiles" },
    );
  }

  const path = join(ctx.repoRoot, file);
  let text: string;
  let doc: unknown;
  try {
    text = readFileSync(path, "utf8");
    doc = JSON.parse(text);
  } catch (error) {
    throw new ToolkitError(
      `${file} is not a readable JSON file — nothing written`,
      EXIT.PRECONDITION,
      {
        field: "file",
        cause: error,
      },
    );
  }

  // Minimal text edits, never a reserialisation: every byte outside the touched
  // values stays as it was, so a formatter-shaped file does not turn into a diff.
  const indent = /^[ \t]+/m.exec(text)?.[0] ?? "  ";
  const formattingOptions = {
    insertSpaces: !indent.startsWith("\t"),
    tabSize: indent.startsWith("\t") ? 1 : indent.length,
    eol: text.includes("\r\n") ? "\r\n" : "\n",
  };
  let next = text;
  const changes: Change[] = requested.map(({ op, pointer, value }) => {
    const { parent, key, path } = locate(doc, pointer, op === "remove", file);
    const from = (parent as Record<string | number, unknown>)[key];
    if (op === "set") {
      (parent as Record<string | number, unknown>)[key] = value;
    } else if (Array.isArray(parent)) {
      parent.splice(key as number, 1);
    } else {
      delete parent[key as string];
    }
    // Formatting applies to a set value only: on a removal jsonc-parser reformats
    // the whole line and would explode a one-line array.
    const edits =
      op === "set" ? modify(next, path, value, { formattingOptions }) : removal(next, path);
    next = applyEdits(next, edits);
    // A later change may reach into the value set here — record it as it was set.
    return { op, pointer, from, to: op === "set" ? structuredClone(value) : null };
  });

  let result: unknown;
  try {
    result = JSON.parse(next);
  } catch {
    // Falls through to the comparison below.
  }
  if (!isDeepStrictEqual(result, doc)) {
    throw new ToolkitError(
      `editing ${file} did not produce the expected JSON — nothing written`,
      EXIT.PRECONDITION,
      { field: "file" },
    );
  }

  const title = await fetchDecisionTitle(resolveServer(ctx.repoRoot, ctx.args), register);

  const notes: string[] = [];
  if (ctx.flags.dryRun) {
    notes.push(`dry run: ${file} and ${MEASURE_LEDGER} were not written`);
  } else {
    writeFileSync(path, next, "utf8");
    const ledger = join(ctx.repoRoot, MEASURE_LEDGER);
    mkdirSync(dirname(ledger), { recursive: true });
    const receipt = { ts: new Date().toISOString(), file, register: Number(register), changes };
    appendFileSync(ledger, `${JSON.stringify(receipt)}\n`, "utf8");
  }

  return {
    ok: true,
    notes,
    data: { file, register: Number(register), title, changes, ledger: MEASURE_LEDGER },
  };
}

/** The positional change first, then every `--set`/`--remove` in argument order. */
function requestedChanges(
  verb: "set" | "remove",
  rest: string[],
  args: string[],
): { op: "set" | "remove"; pointer: string; value?: unknown }[] {
  const requested: { op: "set" | "remove"; pointer: string; value?: unknown }[] = [];
  const arity = verb === "set" ? 2 : 1;
  if (rest.length === arity) {
    const [pointer, value] = rest as [string, string];
    requested.push(
      verb === "set" ? { op: verb, pointer, value: parseValue(value) } : { op: verb, pointer },
    );
  } else if (rest.length !== 0) {
    throw new ToolkitError(
      `measure ${verb} takes <file> ${verb === "set" ? "<pointer> <value>" : "<pointer>"}`,
      EXIT.PRECONDITION,
      { field: "pointer" },
    );
  }

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] as string;
    const name = token.split("=")[0] as string;
    if (name !== "--set" && name !== "--remove") continue;
    let operand: string;
    if (token.includes("=")) {
      operand = token.slice(name.length + 1);
    } else {
      i += 1;
      operand = args[i] as string;
    }
    if (name === "--remove") {
      requested.push({ op: "remove", pointer: operand });
      continue;
    }
    const split = operand.indexOf("=");
    if (split === -1) {
      throw new ToolkitError(`--set needs <pointer>=<value>, got "${operand}"`, EXIT.PRECONDITION, {
        field: "--set",
      });
    }
    requested.push({
      op: "set",
      pointer: operand.slice(0, split),
      value: parseValue(operand.slice(split + 1)),
    });
  }

  if (requested.length === 0) {
    throw new ToolkitError("measure names no change", EXIT.PRECONDITION, { field: "pointer" });
  }
  return requested;
}

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/**
 * Resolves a JSON pointer (RFC 6901) to the container holding its target, the
 * key inside it and the resolved path from the root. `byString` lets the last token of a removal name an array
 * element by its string value (`/entries/ad-catalog-filter-help`); an index
 * always wins over a string that looks like one.
 */
function locate(
  doc: unknown,
  pointer: string,
  byString: boolean,
  file: string,
): { parent: Container; key: string | number; path: (string | number)[] } {
  const unresolved = new ToolkitError(
    `pointer ${pointer} does not resolve in ${file} — nothing written`,
    EXIT.PRECONDITION,
    { field: "pointer" },
  );
  if (!pointer.startsWith("/")) throw unresolved;

  const tokens = pointer
    .slice(1)
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
  let node = doc;
  const path: (string | number)[] = [];
  for (const [index, token] of tokens.entries()) {
    const last = index === tokens.length - 1;
    let key: string | number | undefined;
    if (Array.isArray(node)) {
      if (/^(0|[1-9]\d*)$/.test(token) && Number(token) < node.length) key = Number(token);
      else if (last && byString && node.includes(token)) key = node.indexOf(token);
    } else if (typeof node === "object" && node !== null && Object.hasOwn(node, token)) {
      key = token;
    }
    if (key === undefined) throw unresolved;
    path.push(key);
    if (last) return { parent: node as Container, key, path };
    node = (node as Record<string | number, unknown>)[key];
  }
  throw unresolved;
}

/**
 * The text edit removing the element at `path` — an array element or an object
 * property — together with exactly one separating comma. Not `modify`:
 * jsonc-parser 3.3.1 cuts the last array element short (`["a", "b""]`) and
 * eats the whitespace before a first property (`{"y": 2 }`).
 */
function removal(text: string, path: (string | number)[]): Edit[] {
  const value = findNodeAtLocation(parseTree(text) as Node, path) as Node;
  const target = value.parent?.type === "property" ? value.parent : value;
  const container = target.parent as Node;
  const siblings = container.children as Node[];
  const index = siblings.indexOf(target);
  const end = (node: Node): number => node.offset + node.length;

  let offset: number;
  let until: number;
  if (siblings.length === 1) {
    // The only element: the container becomes empty, `[]` / `{}`.
    offset = container.offset + 1;
    until = end(container) - 1;
  } else if (index < siblings.length - 1) {
    // Up to the next element: takes the following comma and the whitespace before it.
    offset = target.offset;
    until = (siblings[index + 1] as Node).offset;
  } else {
    // The last element: from the end of its predecessor, taking the preceding comma.
    offset = end(siblings[index - 1] as Node);
    until = end(target);
  }
  return [{ offset, length: until - offset, content: "" }];
}

/**
 * Reads decision `<n>` over the spec server's token-free read route. Anything
 * but a 200 carrying a decision — 404, other status, network error, timeout,
 * unparsable body — is exit 4: without a readable decision nothing is written.
 */
async function fetchDecisionTitle(server: string, register: string): Promise<string> {
  const url = `${server}/api/decisions/${register}`;
  let status: number | undefined;
  let title: unknown;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(DECISION_TIMEOUT_MS) });
    status = response.status;
    const body = (await response.json()) as { decision?: { title?: unknown } } | null;
    title = body?.decision?.title;
  } catch (error) {
    throw new ToolkitError(
      `decision #${register} not readable at ${url} — nothing written`,
      EXIT.PRECONDITION,
      { field: "--register", cause: error },
    );
  }
  if (status !== 200 || typeof title !== "string") {
    throw new ToolkitError(
      `decision #${register} not found at ${url} (HTTP ${status}) — nothing written`,
      EXIT.PRECONDITION,
      { field: "--register" },
    );
  }
  return title;
}
