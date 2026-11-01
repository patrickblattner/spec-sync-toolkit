/**
 * A tiny SPDX licence-expression parser and evaluator (SST-FEATURE-001).
 *
 * Grammar (SPDX 2.3 Annex D, the part npm packages use):
 *
 *   or   := and ("OR" and)*
 *   and  := with ("AND" with)*
 *   with := atom ("WITH" exception-id)?
 *   atom := licence-id | "(" or ")"
 *
 * `AND` binds tighter than `OR`. A `WITH` exception is read as its base
 * licence. Operators are matched case-insensitively — legacy fields write
 * `MIT or Apache-2.0` — and licence ids are compared case-insensitively, as
 * SPDX defines them.
 */

export type SpdxNode =
  { kind: "id"; id: string } | { kind: "and" | "or"; left: SpdxNode; right: SpdxNode };

const TOKEN = /\s*(\(|\)|[A-Za-z0-9.+:-]+)/y;

function tokenize(expression: string): string[] | undefined {
  const tokens: string[] = [];
  let index = 0;
  while (index < expression.length) {
    if (expression.slice(index).trim() === "") break;
    TOKEN.lastIndex = index;
    const match = TOKEN.exec(expression);
    if (match === null) return undefined;
    tokens.push(match[1] as string);
    index = TOKEN.lastIndex;
  }
  return tokens;
}

const OPERATORS = new Set(["AND", "OR", "WITH"]);

/** Parses an expression; `undefined` when it is not a valid one. */
export function parseSpdx(expression: string): SpdxNode | undefined {
  const parsed = tokenize(expression);
  if (parsed === undefined || parsed.length === 0) return undefined;
  const tokens: string[] = parsed;
  let position = 0;
  const peek = (): string | undefined => tokens[position]?.toUpperCase();

  function parseOr(): SpdxNode | undefined {
    let left = parseAnd();
    while (left !== undefined && peek() === "OR") {
      position += 1;
      const right = parseAnd();
      left = right === undefined ? undefined : { kind: "or", left, right };
    }
    return left;
  }

  function parseAnd(): SpdxNode | undefined {
    let left = parseWith();
    while (left !== undefined && peek() === "AND") {
      position += 1;
      const right = parseWith();
      left = right === undefined ? undefined : { kind: "and", left, right };
    }
    return left;
  }

  function parseWith(): SpdxNode | undefined {
    const atom = parseAtom();
    if (atom === undefined || peek() !== "WITH") return atom;
    position += 1;
    const exception = tokens[position];
    if (exception === undefined || exception === "(" || exception === ")") return undefined;
    if (OPERATORS.has(exception.toUpperCase())) return undefined;
    position += 1;
    // A WITH exception is treated as its base licence.
    return atom.kind === "id" ? atom : undefined;
  }

  function parseAtom(): SpdxNode | undefined {
    const token = tokens[position];
    if (token === undefined || token === ")") return undefined;
    position += 1;
    if (token === "(") {
      const inner = parseOr();
      if (inner === undefined || tokens[position] !== ")") return undefined;
      position += 1;
      return inner;
    }
    if (OPERATORS.has(token.toUpperCase())) return undefined;
    return { kind: "id", id: token };
  }

  const tree = parseOr();
  return tree !== undefined && position === tokens.length ? tree : undefined;
}

/**
 * Whether the expression is satisfiable from the allowed ids: `OR` needs one
 * side, `AND` needs both. `allowed` holds upper-cased ids.
 */
export function satisfiable(node: SpdxNode, allowed: ReadonlySet<string>): boolean {
  if (node.kind === "id") return allowed.has(node.id.toUpperCase());
  if (node.kind === "or")
    return satisfiable(node.left, allowed) || satisfiable(node.right, allowed);
  return satisfiable(node.left, allowed) && satisfiable(node.right, allowed);
}
