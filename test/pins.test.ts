import { describe, expect, it } from "vitest";
import { excludeMatcher, withoutExcluded } from "../src/pins.js";

describe("excludeMatcher (SST-DESIGN-025 rev 5, pinExclude)", () => {
  it("excludes nothing without patterns", () => {
    expect(excludeMatcher()("GL-UI-026")).toBe(false);
    expect(excludeMatcher([])("GL-UI-026")).toBe(false);
  });

  it("`*` matches any run of characters, including none", () => {
    const isExcluded = excludeMatcher(["GL-UI-*", "ADR-*-UI"]);
    expect(isExcluded("GL-UI-026")).toBe(true);
    expect(isExcluded("GL-UI-")).toBe(true);
    expect(isExcluded("ADR-007-UI")).toBe(true);
    expect(isExcluded("GL-UIX-026")).toBe(false);
  });

  it("is anchored to the whole key", () => {
    const isExcluded = excludeMatcher(["GL-020"]);
    expect(isExcluded("GL-020")).toBe(true);
    expect(isExcluded("GL-0201")).toBe(false);
    expect(isExcluded("XGL-020")).toBe(false);
  });

  it("treats regex metacharacters literally", () => {
    const isExcluded = excludeMatcher(["A.B+*"]);
    expect(isExcluded("A.B+1")).toBe(true);
    expect(isExcluded("AxB+1")).toBe(false);
  });
});

describe("withoutExcluded", () => {
  const isExcluded = excludeMatcher(["GL-UI-*"]);

  it("filters a fetched Map", () => {
    const result = withoutExcluded(
      new Map([
        ["GL-UI-026", 6],
        ["PROC-DEV-031", 2],
      ]),
      isExcluded,
    );
    expect([...result]).toEqual([["PROC-DEV-031", 2]]);
  });

  it("filters a pin-file object", () => {
    expect(withoutExcluded({ "GL-UI-026": 6, "PROC-DEV-031": 2 }, isExcluded)).toEqual({
      "PROC-DEV-031": 2,
    });
  });
});
