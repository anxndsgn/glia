import { describe, expect, test } from "bun:test";
import {
  BindingIndex,
  bindingsBindWorktree,
  bindingsRootWorktree,
  type Bindings,
} from "../../src/core/project/bindings.ts";
import { makeSecondWorktree, makeTestEnv } from "../helpers.ts";

describe("Project Binding semantics", () => {
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
