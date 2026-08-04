import { describe, expect, test } from "bun:test";
import {
  BindingIndex,
  bindingsBindWorktree,
  bindingsContain,
  bindingsRootWorktree,
  normalizeBoundPath,
  type Bindings,
} from "../../src/core/project/bindings.ts";
import { makeSecondWorktree, makeTestEnv } from "../helpers.ts";

describe("Project Binding semantics", () => {
  test("bindings contain roots and aliases with their subpaths, never sibling prefixes", () => {
    const bindings: Bindings = {
      schemaVersion: 1,
      projectId: "p",
      roots: ["/work/proj"],
      aliases: ["/old/proj"],
    };
    expect(bindingsContain(bindings, "/work/proj")).toBeTrue();
    expect(bindingsContain(bindings, "/work/proj/sub/dir")).toBeTrue();
    expect(bindingsContain(bindings, "/old/proj/deep")).toBeTrue();
    expect(bindingsContain(bindings, "/work/proj-other")).toBeFalse();
    expect(bindingsContain(bindings, "/work")).toBeFalse();
  });

  test("normalization strips trailing separators", () => {
    expect(normalizeBoundPath("/work/proj/")).toBe("/work/proj");
  });

  test("roots admit capture while roots and aliases both claim history", () => {
    const bindings: Bindings = {
      schemaVersion: 1,
      projectId: "prj_test",
      roots: ["/work/live"],
      aliases: ["/work/retired"],
    };

    expect(bindingsRootWorktree(bindings, "/work/live")).toBeTrue();
    expect(bindingsRootWorktree(bindings, "/work/retired")).toBeFalse();
    expect(bindingsBindWorktree(bindings, "/work/live")).toBeTrue();
    expect(bindingsBindWorktree(bindings, "/work/retired")).toBeTrue();
  });

  test("an overlay participates in exact and most-specific ownership resolution", async () => {
    const env = await makeTestEnv();
    try {
      const nested = await makeSecondWorktree(env, "overlay");
      const index = new BindingIndex(env.home, {
        worktree: nested,
        projectId: "prj_overlay",
      });

      expect(await index.mapWorktree(nested)).toEqual({ projectId: "prj_overlay" });
      expect(await index.mapPath(`${nested}/src/index.ts`)).toEqual({
        projectId: "prj_overlay",
      });
      expect(await index.mapPath(env.worktree)).toBeNull();
    } finally {
      await env.cleanup();
    }
  });
});
