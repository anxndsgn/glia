import { describe, expect, test } from "bun:test";
import { GliaError } from "../../src/core/output/errors.ts";
import {
  renderError,
  JSON_FORMAT_VERSION,
  type RenderTarget,
} from "../../src/core/output/result.ts";

function capture(): { target: RenderTarget; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    target: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
    stdout,
    stderr,
  };
}

describe("renderError", () => {
  const error = new GliaError(
    "NOT_ENROLLED",
    "repository /w is not enrolled with Glia",
    { worktree: "/w" },
    ["glia import"],
  );

  test("human output states the error and every next step", () => {
    const { target, stdout, stderr } = capture();
    renderError("show", error, false, target);
    expect(stdout).toEqual([]);
    expect(stderr.join("")).toBe(
      "error (NOT_ENROLLED): repository /w is not enrolled with Glia\n  next: glia import\n",
    );
  });

  test("human output stays a single line when there are no next steps", () => {
    const { target, stderr } = capture();
    renderError("show", new GliaError("INTERNAL", "boom"), false, target);
    expect(stderr.join("")).toBe("error (INTERNAL): boom\n");
  });

  test("JSON output carries nextSteps as a first-class error field", () => {
    const { target, stdout, stderr } = capture();
    renderError("show", error, true, target);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join(""))).toEqual({
      formatVersion: JSON_FORMAT_VERSION,
      command: "show",
      ok: false,
      error: {
        code: "NOT_ENROLLED",
        message: "repository /w is not enrolled with Glia",
        details: { worktree: "/w" },
        nextSteps: ["glia import"],
      },
    });
  });
});
