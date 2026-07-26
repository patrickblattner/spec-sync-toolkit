/**
 * Reading a command's own flags out of `ctx.args`.
 *
 * The dispatcher (`src/cli.ts`) parses the common flags and passes everything
 * else through untouched — deliberately, so no command has to edit a central
 * flag catalogue. The other half of that deal lives here: each command declares
 * its options and `checkFlags` rejects anything else, because a silently
 * ignored `--bse develop` would run against the default base and report success.
 */

import { EXIT, ToolkitError } from "../output.js";

/**
 * Validates a command's options: an unknown one, and a value flag without a
 * value, both end as exit 4 naming the offending option (spec §4).
 */
export function checkFlags(
  args: string[],
  valueFlags: string[],
  booleanFlags: string[] = [],
): void {
  const known = new Set([...valueFlags, ...booleanFlags]);

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] as string;
    if (!token.startsWith("-")) continue;

    const name = token.split("=")[0] as string;
    if (!known.has(name)) {
      throw new ToolkitError(
        `unknown option ${name} — this command knows ${[...known].sort().join(", ") || "no options"}`,
        EXIT.PRECONDITION,
        { field: name },
      );
    }

    if (!valueFlags.includes(name)) continue;
    if (token.includes("=")) {
      if (token.slice(name.length + 1) === "") {
        throw new ToolkitError(`${name} needs a value`, EXIT.PRECONDITION, { field: name });
      }
      continue;
    }
    const value = args[i + 1];
    if (value === undefined || value.startsWith("-")) {
      throw new ToolkitError(`${name} needs a value`, EXIT.PRECONDITION, { field: name });
    }
    i += 1;
  }
}

/** `--base main` and `--base=main`; the last occurrence wins. */
export function valueFlag(args: string[], flag: string): string | undefined {
  let found: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] as string;
    if (token === flag) {
      const value = args[i + 1];
      if (value !== undefined && !value.startsWith("-")) found = value;
    } else if (token.startsWith(`${flag}=`)) {
      found = token.slice(flag.length + 1);
    }
  }
  return found;
}

/**
 * The positional arguments. `valueFlags` names the flags that take a value, so
 * `pack --profile merge 142` keeps `142` as the positional instead of losing it
 * to a guess about which flags consume what.
 */
export function positionals(args: string[], valueFlags: string[] = []): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] as string;
    if (token.startsWith("-")) {
      if (valueFlags.includes(token)) i += 1;
      continue;
    }
    out.push(token);
  }
  return out;
}
