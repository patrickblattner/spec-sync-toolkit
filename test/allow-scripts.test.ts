import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** GL-CODE-004: a repo consumed as a git dependency lists every install-script package of its lockfile. */
const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as {
  packages: Record<string, { version?: string; hasInstallScript?: boolean }>;
};
const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
  allowScripts?: Record<string, boolean>;
};

const withScript = new Set(
  Object.entries(lock.packages)
    .filter(([, entry]) => entry.hasInstallScript === true)
    .map(([path, entry]) => `${path.replace(/.*node_modules\//, "")}@${entry.version ?? ""}`),
);
const listed = new Set(Object.keys(manifest.allowScripts ?? {}));

describe("allowScripts covers the lockfile in both directions (GL-CODE-004)", () => {
  it("lists every lockfile package with an install script", () => {
    expect([...withScript].filter((key) => !listed.has(key))).toEqual([]);
  });

  it("lists nothing that is not an install-script package of the lockfile", () => {
    expect([...listed].filter((key) => !withScript.has(key))).toEqual([]);
  });
});
