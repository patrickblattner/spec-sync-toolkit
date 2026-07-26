import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { COMMANDS, parseArgv, registerCommand, run } from "../src/cli.js";
import { EXIT, resetEmitState } from "../src/output.js";

const repoRoot = process.cwd();
const binary = join(repoRoot, "dist", "cli.js");

function captureStdout() {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return chunks;
}

/** A repo with a valid config, so `ping` reaches its happy path. */
function scratchRepo(config: unknown = undefined): string {
  const root = mkdtempSync(join(tmpdir(), "spec-sync-cli-"));
  if (config === undefined) {
    cpSync(join(repoRoot, "spec-sync.config.json.example"), join(root, "spec-sync.config.json"));
  } else {
    writeFileSync(join(root, "spec-sync.config.json"), JSON.stringify(config));
  }
  return root;
}

afterEach(() => {
  resetEmitState();
  vi.restoreAllMocks();
});

describe("parseArgv (spec §7, common flags)", () => {
  it("reads command, flags and positional arguments", () => {
    const parsed = parseArgv(["merge", "142", "--human", "--dry-run", "--repo", "/tmp/x"]);
    expect(parsed.command).toBe("merge");
    expect(parsed.args).toEqual(["142"]);
    expect(parsed.flags).toEqual({ human: true, dryRun: true, repo: "/tmp/x" });
  });

  it("defaults to JSON and lets --json win over an earlier --human", () => {
    expect(parseArgv(["ping"]).flags.human).toBe(false);
    expect(parseArgv(["ping", "--human", "--json"]).flags.human).toBe(false);
  });

  it("rejects a value flag without a value", () => {
    expect(() => parseArgv(["ping", "--config"])).toThrow(/--config needs a value/);
  });

  it("rejects an unknown flag instead of ignoring it", () => {
    expect(() => parseArgv(["ping", "--force"])).toThrow(/unknown flag --force/);
  });
});

describe("dispatch", () => {
  it("offers a registration point commands hook into", async () => {
    registerCommand({
      name: "__probe",
      summary: "test",
      needsConfig: false,
      run: () => ({ ok: true, notes: ["probed"], data: { value: 7 } }),
    });
    const chunks = captureStdout();
    const exit = await run(["__probe"]);
    COMMANDS.delete("__probe");
    expect(exit).toBe(EXIT.OK);
    const parsed = JSON.parse(chunks[0] as string) as Record<string, unknown>;
    expect(parsed).toMatchObject({ command: "__probe", ok: true, exit: 0, value: 7 });
    expect(parsed.notes).toEqual(["probed"]);
  });

  it("answers an unknown command with exit 4 and still emits one JSON object", async () => {
    const chunks = captureStdout();
    const exit = await run(["nope"]);
    expect(exit).toBe(EXIT.PRECONDITION);
    expect(chunks).toHaveLength(1);
    expect(JSON.parse(chunks[0] as string)).toMatchObject({
      command: "nope",
      ok: false,
      exit: 4,
      field: "command",
    });
  });

  it("turns an invalid config into exit 4 naming the field", async () => {
    const root = scratchRepo({ project: "x", gate: { profiles: {}, phases: [{ name: "lint" }] } });
    const chunks = captureStdout();
    const exit = await run(["ping", "--repo", root]);
    expect(exit).toBe(EXIT.PRECONDITION);
    expect(JSON.parse(chunks[0] as string)).toMatchObject({
      ok: false,
      exit: 4,
      field: "gate.phases[0].cmd",
    });
  });

  it("emits human text for a failure too", async () => {
    const chunks = captureStdout();
    await run(["nope", "--human"]);
    expect(chunks[0]).toContain("FAIL  nope  exit 4");
  });
});

describe("the built binary (process boundary)", () => {
  beforeAll(() => {
    execFileSync("npx", ["tsup"], { cwd: repoRoot, stdio: "pipe" });
  }, 120_000);

  /** Runs the binary and captures stdout, stderr and the exit code. */
  function invoke(args: string[], cwd: string) {
    const result = spawnSync(process.execPath, [binary, ...args], { cwd, encoding: "utf8" });
    return { stdout: result.stdout, stderr: result.stderr, status: result.status };
  }

  it("puts exactly one JSON object on stdout and progress on stderr", () => {
    const { stdout, stderr, status } = invoke(["ping"], scratchRepo());
    expect(status).toBe(EXIT.OK);
    expect(JSON.parse(stdout)).toMatchObject({ command: "ping", ok: true, exit: 0 });
    // No stray line before or after the object — the whole of stdout is the object.
    expect(stdout.trimStart().startsWith("{")).toBe(true);
    expect(stdout.trimEnd().endsWith("}")).toBe(true);
    expect(stderr).toContain("spec-sync ping");
    expect(stderr).not.toContain("{");
  });

  it("renders --human as text rather than JSON", () => {
    const { stdout } = invoke(["ping", "--human"], scratchRepo());
    expect(() => JSON.parse(stdout)).toThrow();
    expect(stdout).toContain("OK  ping  exit 0");
    expect(stdout).toContain("node: v");
  });

  it("exits 4 with the violated field when the config is missing", () => {
    const empty = mkdtempSync(join(tmpdir(), "spec-sync-noconfig-"));
    const { stdout, status } = invoke(["ping"], empty);
    expect(status).toBe(EXIT.PRECONDITION);
    expect(JSON.parse(stdout)).toMatchObject({ exit: 4, field: "spec-sync.config.json" });
  });

  it("runs on the Node version pinned in mise.toml", () => {
    const pin = /^\s*node\s*=\s*"([^"]+)"/m.exec(readFileSync(join(repoRoot, "mise.toml"), "utf8"));
    expect(pin?.[1]).toBeDefined();
    const { stdout } = invoke(["ping"], scratchRepo());
    expect((JSON.parse(stdout) as { node: string }).node).toBe(`v${pin?.[1]}`);
  });
});
