import { describe, expect, it } from "vitest";
import { gatherMaterial, REVIEWED_FILES } from "../../src/keepalive/tasks.js";

const source = (files: Record<string, string>, gitLog = "abc123 a commit") => ({
  readText: (p: string) => files[p] ?? null,
  gitLog: () => gitLog,
});

describe("gatherMaterial", () => {
  it("reads the reviewed files through the injected source", () => {
    const m = gatherMaterial(source({ [REVIEWED_FILES[0]!]: "export const a = 1;" }));
    expect(m.files[REVIEWED_FILES[0]!]).toBe("export const a = 1;");
    expect(m.gitLog).toBe("abc123 a commit");
  });

  it("skips files the source cannot read rather than failing the round", () => {
    const m = gatherMaterial(source({}));
    expect(m.files).toEqual({});
  });

  it("tolerates having no history, which is the container's normal state", () => {
    const m = gatherMaterial(source({ [REVIEWED_FILES[0]!]: "x" }, ""));
    expect(m.gitLog).toBe("");
  });

  it("names at least a few files worth reviewing", () => {
    expect(REVIEWED_FILES.length).toBeGreaterThanOrEqual(3);
    expect(REVIEWED_FILES.every((p) => p.startsWith("src/"))).toBe(true);
  });
});
