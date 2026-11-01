import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../src/cli.js";
import {
  NPM_LS_ARGS,
  runLicenceInventory,
  type InventoryEntry,
  type NpmLs,
} from "../src/commands/licence-inventory.js";
import { matchLicenceText } from "../src/licence/texts.js";
import { parseSpdx, satisfiable } from "../src/licence/spdx.js";
import { EXIT } from "../src/output.js";

const MIT_TEXT = `MIT License

Copyright (c) 2020 Someone

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction.

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.`;

interface FakePackage {
  name: string;
  version: string;
  manifest?: Record<string, unknown>;
  files?: Record<string, string>;
  /** Install below this directory instead of the repo root (nested node_modules). */
  under?: string;
}

/** A fake repo: node_modules tree on disk, an allowlist, and nothing installed for real. */
function repo(packages: FakePackage[], allowlist?: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "licence-"));
  for (const pkg of packages) {
    const dir = join(root, pkg.under ?? "", "node_modules", pkg.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: pkg.name, version: pkg.version, ...pkg.manifest }),
    );
    for (const [file, text] of Object.entries(pkg.files ?? {})) {
      writeFileSync(join(dir, file), text);
    }
  }
  if (allowlist !== undefined) {
    writeFileSync(join(root, "licence-allowlist.json"), JSON.stringify(allowlist));
  }
  return root;
}

/** Stubbed `npm ls --omit=dev --all --json`: the tree is handed in, npm never runs. */
function npmLs(dependencies: Record<string, unknown>, code = 0): NpmLs {
  return () => ({
    ok: code === 0,
    code,
    stdout: JSON.stringify({ name: "fixture", version: "1.0.0", dependencies }),
    stderr: "",
  });
}

const ctxFor = (root: string, args: string[] = []): CommandContext => ({
  flags: { human: false, dryRun: false },
  args,
  repoRoot: root,
});

const ALLOW = { licenses: ["MIT", "Apache-2.0"] };

function inventoryOf(root: string, path: unknown): InventoryEntry[] {
  return (
    JSON.parse(readFileSync(join(root, path as string), "utf8")) as { packages: InventoryEntry[] }
  ).packages;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("licence-inventory (SST-FEATURE-001)", () => {
  it("AC1: MIT, Apache-2.0 and (MIT OR GPL-3.0) against MIT + Apache-2.0 → exit 0", async () => {
    const root = repo(
      [
        { name: "a", version: "1.0.0", manifest: { license: "MIT" } },
        { name: "b", version: "2.0.0", manifest: { license: "Apache-2.0" } },
        { name: "c", version: "3.0.0", manifest: { license: "(MIT OR GPL-3.0)" } },
      ],
      ALLOW,
    );
    const ls = npmLs({
      a: { version: "1.0.0", dependencies: { c: { version: "3.0.0" } } },
      b: { version: "2.0.0" },
    });
    const result = await runLicenceInventory(ctxFor(root), ls);
    expect(result).toMatchObject({ ok: true, exit: EXIT.OK });
    expect(result.data).toMatchObject({ packages: 3, findings: 0, first: [] });
    const inventory = inventoryOf(root, result.data?.inventory);
    expect(inventory.map((entry) => [entry.name, entry.licence, entry.source])).toEqual([
      ["a", "MIT", "package.json"],
      ["b", "Apache-2.0", "package.json"],
      ["c", "(MIT OR GPL-3.0)", "package.json"],
    ]);
    expect(String(result.data?.inventory)).toMatch(
      /^\.spec-sync\/logs\/.+\/licence-inventory\.json$/,
    );
  });

  it("AC2: a GPL-3.0-only package → exit 1, named with its licence", async () => {
    const root = repo(
      [
        { name: "a", version: "1.0.0", manifest: { license: "MIT" } },
        { name: "gpl", version: "0.1.0", manifest: { license: "GPL-3.0" } },
      ],
      ALLOW,
    );
    const result = await runLicenceInventory(
      ctxFor(root),
      npmLs({ a: { version: "1.0.0" }, gpl: { version: "0.1.0" } }),
    );
    expect(result).toMatchObject({ ok: false, exit: EXIT.FAILED });
    expect(result.data).toMatchObject({
      packages: 2,
      findings: 1,
      first: ["gpl@0.1.0: GPL-3.0 — not satisfiable from the allowed licences"],
    });
  });

  it("AC3: no license field + MIT LICENSE file → MIT; unrecognisable file → unreadable", async () => {
    const root = repo(
      [
        { name: "filed", version: "1.0.0", files: { LICENSE: MIT_TEXT } },
        {
          name: "star",
          version: "1.0.0",
          manifest: { license: "*" },
          files: { "LICENCE.md": MIT_TEXT },
        },
        { name: "odd", version: "1.0.0", files: { COPYING: "All rights reserved. Ask me." } },
        { name: "bare", version: "1.0.0" },
      ],
      ALLOW,
    );
    const result = await runLicenceInventory(
      ctxFor(root),
      npmLs({
        filed: { version: "1.0.0" },
        star: { version: "1.0.0" },
        odd: { version: "1.0.0" },
        bare: { version: "1.0.0" },
      }),
    );
    expect(result.exit).toBe(EXIT.FAILED);
    expect(result.data).toMatchObject({ packages: 4, findings: 2 });
    expect(result.data?.first).toEqual([
      "bare@1.0.0: unreadable — no licence field and no LICENSE/LICENCE/COPYING file",
      "odd@1.0.0: unreadable — no licence field and COPYING matches no known licence text",
    ]);
    const byName = new Map(inventoryOf(root, result.data?.inventory).map((e) => [e.name, e]));
    expect(byName.get("filed")).toMatchObject({
      licence: "MIT",
      source: "LICENSE",
      verdict: "allowed",
    });
    expect(byName.get("star")).toMatchObject({ licence: "MIT", source: "LICENCE.md" });
  });

  it("AC4: dev-only dependencies are not in the population", async () => {
    // `dev-tool` is installed but npm ls --omit=dev does not list it.
    const root = repo(
      [
        { name: "a", version: "1.0.0", manifest: { license: "MIT" } },
        { name: "dev-tool", version: "1.0.0", manifest: { license: "GPL-3.0" } },
      ],
      ALLOW,
    );
    const calls: string[][] = [];
    const ls: NpmLs = (cwd) => {
      expect(cwd).toBe(root);
      calls.push(NPM_LS_ARGS);
      return npmLs({ a: { version: "1.0.0" } })(cwd);
    };
    const result = await runLicenceInventory(ctxFor(root), ls);
    expect(NPM_LS_ARGS).toEqual(["ls", "--omit=dev", "--all", "--json"]);
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ exit: EXIT.OK, data: { packages: 1, findings: 0 } });
  });

  it("AC5: runs without network access", async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("network forbidden")));
    vi.stubGlobal("fetch", fetchSpy);
    const root = repo([{ name: "a", version: "1.0.0", manifest: { license: "MIT" } }], ALLOW);
    const result = await runLicenceInventory(ctxFor(root), npmLs({ a: { version: "1.0.0" } }));
    expect(result.exit).toBe(EXIT.OK);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a missing allowlist → exit 4 naming the file", async () => {
    const root = repo([]);
    await expect(runLicenceInventory(ctxFor(root), npmLs({}))).rejects.toMatchObject({
      exit: EXIT.PRECONDITION,
      field: "licence-allowlist.json",
      message: expect.stringContaining("licence-allowlist.json") as unknown,
    });
    await expect(
      runLicenceInventory(ctxFor(root, ["--allowlist", "ops/licences.json"]), npmLs({})),
    ).rejects.toMatchObject({ exit: EXIT.PRECONDITION, field: "ops/licences.json" });
  });

  it("an exception without a reason → exit 4", async () => {
    const root = repo([], { licenses: ["MIT"], exceptions: [{ package: "x" }] });
    await expect(runLicenceInventory(ctxFor(root), npmLs({}))).rejects.toMatchObject({
      exit: EXIT.PRECONDITION,
    });
  });

  it("--allowlist reads another file", async () => {
    const root = repo([{ name: "a", version: "1.0.0", manifest: { license: "ISC" } }]);
    writeFileSync(join(root, "other.json"), JSON.stringify({ licenses: ["ISC"] }));
    const result = await runLicenceInventory(
      ctxFor(root, ["--allowlist", "other.json"]),
      npmLs({ a: { version: "1.0.0" } }),
    );
    expect(result.exit).toBe(EXIT.OK);
  });

  it("UNLICENSED passes only when the allowlist names the package", async () => {
    const packages = [
      { name: "private-a", version: "1.0.0", manifest: { license: "UNLICENSED" } },
      { name: "private-b", version: "1.0.0", manifest: { license: "UNLICENSED" } },
    ];
    const root = repo(packages, {
      licenses: ["MIT", "UNLICENSED"],
      exceptions: [{ package: "private-a", reason: "our own closed package" }],
    });
    const result = await runLicenceInventory(
      ctxFor(root),
      npmLs({ "private-a": { version: "1.0.0" }, "private-b": { version: "1.0.0" } }),
    );
    expect(result.data).toMatchObject({
      findings: 1,
      first: ["private-b@1.0.0: UNLICENSED — UNLICENSED and not named in the allowlist"],
    });
    const byName = new Map(inventoryOf(root, result.data?.inventory).map((e) => [e.name, e]));
    expect(byName.get("private-a")).toMatchObject({
      verdict: "exception",
      why: "our own closed package",
    });
  });

  it("an exception may name name@version only", async () => {
    const root = repo([{ name: "g", version: "2.0.0", manifest: { license: "GPL-2.0" } }], {
      licenses: ["MIT"],
      exceptions: [{ package: "g@1.0.0", reason: "old one" }],
    });
    const result = await runLicenceInventory(ctxFor(root), npmLs({ g: { version: "2.0.0" } }));
    expect(result.data).toMatchObject({ findings: 1 });
  });

  it("reads the legacy licenses array and the legacy license object", async () => {
    const root = repo(
      [
        {
          name: "legacy",
          version: "1.0.0",
          manifest: { licenses: [{ type: "GPL-2.0" }, { type: "MIT" }] },
        },
        { name: "obj", version: "1.0.0", manifest: { license: { type: "Apache-2.0" } } },
      ],
      ALLOW,
    );
    const result = await runLicenceInventory(
      ctxFor(root),
      npmLs({ legacy: { version: "1.0.0" }, obj: { version: "1.0.0" } }),
    );
    expect(result).toMatchObject({ exit: EXIT.OK, data: { packages: 2 } });
    const byName = new Map(inventoryOf(root, result.data?.inventory).map((e) => [e.name, e]));
    expect(byName.get("legacy")?.licence).toBe("(GPL-2.0 OR MIT)");
  });

  it("dedupes by name@version, skips workspace packages, follows nested node_modules", async () => {
    const root = repo(
      [
        { name: "dup", version: "1.0.0", manifest: { license: "MIT" } },
        { name: "dup", version: "2.0.0", manifest: { license: "GPL-3.0" }, under: "ws" },
        { name: "deep", version: "1.0.0", manifest: { license: "MIT" }, under: "ws" },
      ],
      ALLOW,
    );
    // The workspace package lives at ws/, linked from node_modules/@me/ws.
    writeFileSync(join(root, "ws", "package.json"), JSON.stringify({ name: "@me/ws" }));
    mkdirSync(join(root, "node_modules", "@me"), { recursive: true });
    symlinkSync(join(root, "ws"), join(root, "node_modules", "@me", "ws"));
    const result = await runLicenceInventory(
      ctxFor(root),
      npmLs({
        "@me/ws": {
          version: "0.0.0",
          resolved: "file:../../ws",
          dependencies: {
            dup: { version: "2.0.0" },
            deep: {
              version: "1.0.0",
              // A deduped reference back to the workspace carries no `resolved`.
              dependencies: { dup: { version: "2.0.0" }, "@me/ws": { version: "0.0.0" } },
            },
          },
        },
        dup: { version: "1.0.0" },
        optional: {},
      }),
    );
    expect(result.data).toMatchObject({
      packages: 3,
      findings: 1,
      first: ["dup@2.0.0: GPL-3.0 — not satisfiable from the allowed licences"],
    });
    expect(result.notes).toEqual([
      "1 workspace package(s) of the repo skipped",
      "1 optional or peer dependency(ies) not installed, not in the closure",
    ]);
  });

  it("a package npm reports missing, or whose directory is absent, is a finding", async () => {
    const root = repo([], ALLOW);
    const result = await runLicenceInventory(
      ctxFor(root),
      npmLs({ gone: { version: "1.0.0" }, req: { required: "^1.0.0", missing: true } }, 1),
    );
    expect(result.data).toMatchObject({ packages: 2, findings: 2 });
  });

  it("an invalid SPDX expression is a finding", async () => {
    const root = repo(
      [{ name: "see", version: "1.0.0", manifest: { license: "SEE LICENSE IN LICENSE.md" } }],
      ALLOW,
    );
    const result = await runLicenceInventory(ctxFor(root), npmLs({ see: { version: "1.0.0" } }));
    expect(result.data?.first).toEqual([
      "see@1.0.0: SEE LICENSE IN LICENSE.md — not a valid SPDX expression",
    ]);
  });

  it("lists at most 10 findings and counts the rest", async () => {
    const names = Array.from({ length: 12 }, (_, i) => `p${String(i).padStart(2, "0")}`);
    const root = repo(
      names.map((name) => ({ name, version: "1.0.0", manifest: { license: "GPL-3.0" } })),
      ALLOW,
    );
    const result = await runLicenceInventory(
      ctxFor(root),
      npmLs(Object.fromEntries(names.map((name) => [name, { version: "1.0.0" }]))),
    );
    expect(result.data).toMatchObject({ findings: 12, more: 2 });
    expect(result.data?.first).toHaveLength(10);
  });

  it("no readable tree from npm ls → exit 4", async () => {
    const root = repo([], ALLOW);
    const broken: NpmLs = () => ({ ok: false, code: 127, stdout: "", stderr: "spawn npm ENOENT" });
    await expect(runLicenceInventory(ctxFor(root), broken)).rejects.toMatchObject({
      exit: EXIT.PRECONDITION,
    });
  });

  it("an unknown option → exit 4", async () => {
    const root = repo([], ALLOW);
    await expect(runLicenceInventory(ctxFor(root, ["--allow"]), npmLs({}))).rejects.toMatchObject({
      exit: EXIT.PRECONDITION,
    });
  });
});

describe("SPDX expressions", () => {
  const allowed = new Set(["MIT", "APACHE-2.0"]);
  const ok = (expression: string): boolean | undefined => {
    const tree = parseSpdx(expression);
    return tree === undefined ? undefined : satisfiable(tree, allowed);
  };

  it("OR needs one, AND needs all, parentheses and precedence", () => {
    expect(ok("MIT")).toBe(true);
    expect(ok("mit")).toBe(true);
    expect(ok("MIT OR GPL-3.0")).toBe(true);
    expect(ok("MIT AND GPL-3.0")).toBe(false);
    expect(ok("MIT AND Apache-2.0")).toBe(true);
    expect(ok("GPL-3.0 OR MIT AND Apache-2.0")).toBe(true);
    expect(ok("(GPL-3.0 OR MIT) AND GPL-2.0")).toBe(false);
    expect(ok("((MIT))")).toBe(true);
    expect(ok("MIT or Apache-2.0")).toBe(true);
  });

  it("WITH is read as the base licence", () => {
    expect(ok("Apache-2.0 WITH LLVM-exception")).toBe(true);
    expect(ok("GPL-2.0 WITH Classpath-exception-2.0")).toBe(false);
  });

  it("rejects malformed expressions", () => {
    for (const bad of ["", "MIT OR", "(MIT", "MIT)", "AND MIT", "MIT WITH", "MIT, ISC", "a b"]) {
      expect(parseSpdx(bad)).toBeUndefined();
    }
  });
});

describe("licence texts", () => {
  const texts: Record<string, string> = {
    MIT: MIT_TEXT,
    ISC: "Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.",
    "0BSD":
      "Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted.\n\nTHE SOFTWARE IS PROVIDED AS IS",
    "BSD-2-Clause":
      "Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:",
    "BSD-3-Clause":
      "Redistribution and use in source and binary forms, with or without modification, are permitted provided that ... 3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software",
    "Apache-2.0": "Apache License\n Version 2.0, January 2004\n http://www.apache.org/licenses/",
    "MPL-2.0": "Mozilla Public License Version 2.0\n==================================",
    "BlueOak-1.0.0": "# Blue Oak Model License\n\nVersion 1.0.0",
    "CC0-1.0": "Creative Commons Legal Code\n\nCC0 1.0 Universal",
    Unlicense:
      "This is free and unencumbered software released into the public domain.\n\nAnyone is free to copy",
    "Python-2.0": "PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2\n----",
    "CC-BY-4.0": "Creative Commons\nAttribution 4.0 International Public License",
  };

  it.each(Object.entries(texts))("recognises %s", (id, text) => {
    expect(matchLicenceText(text)).toBe(id);
  });

  it("returns undefined for an unknown text", () => {
    expect(matchLicenceText("Proprietary. All rights reserved.")).toBeUndefined();
  });
});
