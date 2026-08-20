import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandContext } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import { EXIT, ToolkitError } from "../src/output.js";
import type { RunResult, Tools } from "../src/pack/exec.js";
import { runPack } from "../src/commands/pack.js";

/**
 * Nothing here touches a real issue, a real index or the real spec server: `gh`,
 * `codegraph` and the spec-mcp calls all arrive through the `Tools` seam.
 */

const PACK_KEY = "SST-DESIGN-018";
const LENSES_KEY = "SST-DESIGN-020";

const SPECS: Record<string, { title: string; status: string; rev: number; body: string }> = {
  [PACK_KEY]: {
    title: "Befehl: pack",
    status: "approved",
    rev: 2,
    body: "`pack` erzeugt `.spec-sync/ticket-<nr>.md`, das Wissenspaket.",
  },
  [LENSES_KEY]: {
    title: "Befehl: lenses",
    status: "approved",
    rev: 2,
    body: "Leitet das Lens-Set aus dem Diff ab.",
  },
};

function blockFor(key: string): string {
  const spec = SPECS[key];
  if (spec === undefined) return `Spec "${key}" nicht gefunden.`;
  return `# ${key} — ${spec.title}\n\nStatus: ${spec.status} · Art: design · rev ${spec.rev} · Projekt: spec-sync-toolkit\n\n${spec.body}`;
}

const config = {
  project: "spec-sync-toolkit",
  gate: {
    profiles: { local: ["lint", "unit"], merge: ["lint", "unit"] },
    phases: [
      { name: "lint", cmd: "npm run lint" },
      { name: "unit", cmd: "npm test" },
    ],
  },
  lenses: { acceptance: ["**"] },
};

const issueBody = [
  "## Befund",
  "",
  "`pack` fehlt noch.",
  "",
  "## Abnahmekriterien",
  "",
  "1. `spec-sync pack 142` schreibt das Wissenspaket.",
  "2. Jeder referenzierte Spec trägt `key@rev`.",
  "",
  "## Spec-Bezug",
  "",
  `\`${PACK_KEY}\` und \`${LENSES_KEY}\`.`,
].join("\n");

interface Fakes {
  issue?: Record<string, unknown>;
  ghFails?: boolean;
  openIssues?: number[];
  openIssuesFail?: boolean;
  impact?: Record<string, string[]>;
  codegraphMissing?: boolean;
}

function fakeTools(fakes: Fakes = {}): Tools {
  const ok = (stdout: string): RunResult => ({ ok: true, code: 0, stdout, stderr: "" });
  const fail = (code: number, stderr: string): RunResult => ({
    ok: false,
    code,
    stdout: "",
    stderr,
  });

  return {
    run(file, args) {
      if (file === "gh" && args[1] === "view") {
        if (fakes.ghFails === true) return fail(1, "could not resolve to an Issue");
        return ok(
          JSON.stringify(
            fakes.issue ?? {
              number: 142,
              title: "`pack` bauen",
              body: issueBody,
              url: "https://example.invalid/142",
              labels: [{ name: "spec-sync" }],
              comments: [{ body: "Phase: aktuell — Querschnitt" }],
            },
          ),
        );
      }
      if (file === "gh" && args[1] === "list") {
        if (fakes.openIssuesFail === true) return fail(1, "no default remote repository");
        return ok(JSON.stringify((fakes.openIssues ?? [141, 142]).map((number) => ({ number }))));
      }
      if (file === "codegraph") {
        if (fakes.codegraphMissing === true) return fail(127, "spawn codegraph ENOENT");
        const term = args[args.length - 1] as string;
        const files = fakes.impact?.[term];
        if (files === undefined) return fail(1, `no symbol "${term}"`);
        return ok(JSON.stringify({ affected: files.map((filePath) => ({ filePath })) }));
      }
      throw new Error(`unexpected process: ${file} ${args.join(" ")}`);
    },

    async spec(tool: string, args: Record<string, unknown>): Promise<string> {
      expect(tool).toBe("spec_get_many");
      const keys = args.keys as string[];
      return keys.map(blockFor).join("\n\n---\n\n");
    },
  };
}

function scratchRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "spec-sync-pack-"));
  writeFileSync(join(root, "spec-sync.config.json"), JSON.stringify(config));
  return root;
}

function context(root: string, args: string[] = ["142"], dryRun = false): CommandContext {
  return {
    flags: { human: false, dryRun },
    args,
    repoRoot: root,
    config: loadConfig(root),
  };
}

async function expectExit(promise: Promise<unknown>, exit: number): Promise<ToolkitError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ToolkitError);
    expect((error as ToolkitError).exit).toBe(exit);
    return error as ToolkitError;
  }
  throw new Error("expected the call to throw");
}

describe("pack (spec §7.3, SST-DESIGN-018)", () => {
  it("packs every referenced spec resolved, with key@rev", async () => {
    const root = scratchRepo();
    const result = await runPack(
      context(root),
      fakeTools({ impact: { pack: ["src/commands/pack.ts", "src/cli.ts"] } }),
    );

    expect(result.ok).toBe(true);
    expect(result.data?.pack).toBe(".spec-sync/ticket-142.md");

    const pack = readFileSync(join(root, ".spec-sync", "ticket-142.md"), "utf8");
    expect(pack).toContain(`### ${PACK_KEY}@2`);
    expect(pack).toContain(`### ${LENSES_KEY}@2`);
  });

  it("carries what a sub-agent would otherwise have to search for", async () => {
    const root = scratchRepo();
    await runPack(context(root), fakeTools({ impact: { pack: ["src/commands/pack.ts"] } }));
    const pack = readFileSync(join(root, ".spec-sync", "ticket-142.md"), "utf8");

    // acceptance criteria, spec content, candidate files, gate command
    expect(pack).toContain("1. `spec-sync pack 142` schreibt das Wissenspaket.");
    expect(pack).toContain("`pack` erzeugt `.spec-sync/ticket-<nr>.md`, das Wissenspaket.");
    expect(pack).toContain("`src/commands/pack.ts` — impact: pack");
    expect(pack).toContain("spec-sync gate --profile local");
    expect(pack).toContain("1. lint — `npm run lint`");
  });

  it("exits 3 with reason no-spec-reference when the ticket names no key", async () => {
    const root = scratchRepo();
    const error = await expectExit(
      runPack(
        context(root),
        fakeTools({
          issue: {
            number: 142,
            title: "public-Lane prüft ein stale dist",
            body: "Kein Spec-Bezug.",
            labels: [],
          },
        }),
      ),
      EXIT.AMBIGUOUS,
    );
    expect(error.reason).toBe("no-spec-reference");
    expect(existsSync(join(root, ".spec-sync", "ticket-142.md"))).toBe(false);
  });

  it("exits 3 with reason no-spec-reference when the referenced key is unknown to the server", async () => {
    const root = scratchRepo();
    const error = await expectExit(
      runPack(
        context(root),
        fakeTools({
          issue: {
            number: 142,
            title: "Angleichung",
            body: "Reine Doku-Angleichung an `SST-DESIGN-999`.",
            labels: [],
          },
        }),
      ),
      EXIT.AMBIGUOUS,
    );
    expect(error.reason).toBe("no-spec-reference");
    expect(error.message).toContain("SST-DESIGN-999");
  });

  it("names the overlap with another open ticket's file set", async () => {
    const root = scratchRepo();
    const tools = fakeTools({
      impact: {
        pack: ["src/commands/pack.ts", "src/cli.ts"],
        lenses: ["src/commands/lenses.ts", "src/cli.ts"],
      },
    });

    await runPack(
      {
        ...context(root, ["141"]),
        // #141 is the lenses ticket: different key, shares src/cli.ts
      },
      {
        ...tools,
        run: (file, args) =>
          file === "gh" && args[1] === "view"
            ? {
                ok: true,
                code: 0,
                stderr: "",
                stdout: JSON.stringify({
                  number: 141,
                  title: "`lenses` bauen",
                  body: `\`${LENSES_KEY}\`.`,
                  labels: [],
                }),
              }
            : tools.run(file, args),
      },
    );

    const result = await runPack(context(root), tools);
    expect(result.data?.overlaps).toEqual(["#141: 1 file(s)"]);
    expect(readFileSync(join(root, ".spec-sync", "ticket-142.md"), "utf8")).toContain(
      "- #141: `src/cli.ts`",
    );
  });

  it("keeps a closed ticket out of the overlap list", async () => {
    const root = scratchRepo();
    const tools = fakeTools({ impact: { pack: ["src/cli.ts"] }, openIssues: [142] });
    await runPack(context(root), tools);

    // A pack of the now-closed #141 sharing the same file — then pack again.
    const seeded = readFileSync(join(root, ".spec-sync", "ticket-142.md"), "utf8").replace(
      '"issue": 142',
      '"issue": 141',
    );
    writeFileSync(join(root, ".spec-sync", "ticket-141.md"), seeded);

    const result = await runPack(context(root), tools);
    expect(result.data?.overlaps).toEqual([]);
  });

  it("degrades to no candidates when CodeGraph is not installed", async () => {
    const root = scratchRepo();
    const result = await runPack(context(root), fakeTools({ codegraphMissing: true }));
    expect(result.data?.candidateFiles).toBe(0);
    expect(result.notes?.join(" ")).toContain("codegraph unavailable");
  });

  it("writes nothing on --dry-run", async () => {
    const root = scratchRepo();
    const result = await runPack(context(root, ["142"], true), fakeTools());
    expect(result.ok).toBe(true);
    expect(existsSync(join(root, ".spec-sync", "ticket-142.md"))).toBe(false);
    expect(result.notes?.join(" ")).toContain("dry run");
  });

  it("ends as a violated precondition when gh cannot read the issue", async () => {
    const root = scratchRepo();
    const error = await expectExit(
      runPack(context(root), fakeTools({ ghFails: true })),
      EXIT.PRECONDITION,
    );
    expect(error.message).toContain("could not resolve to an Issue");
  });

  it("insists on an issue number", async () => {
    const root = scratchRepo();
    await expectExit(runPack(context(root, []), fakeTools()), EXIT.PRECONDITION);
  });

  it("takes --profile in both spellings and rejects a mistyped option", async () => {
    const root = scratchRepo();
    const withFlag = await runPack(context(root, ["142", "--profile", "merge"]), fakeTools());
    expect(withFlag.data?.gate).toBe("spec-sync gate --profile merge");

    const withEquals = await runPack(context(root, ["--profile=merge", "142"]), fakeTools());
    expect(withEquals.data?.issue).toBe(142);
    expect(withEquals.data?.gate).toBe("spec-sync gate --profile merge");

    const typo = await expectExit(
      runPack(context(root, ["142", "--profil", "merge"]), fakeTools()),
      EXIT.PRECONDITION,
    );
    expect(typo.field).toBe("--profil");

    const missing = await expectExit(
      runPack(context(root, ["142", "--profile"]), fakeTools()),
      EXIT.PRECONDITION,
    );
    expect(missing.field).toBe("--profile");
  });
});
