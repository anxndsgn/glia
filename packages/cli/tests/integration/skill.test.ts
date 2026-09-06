import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CLI_VERSION } from "../../src/core/build-info.ts";
import {
  runSkillInstall,
  runSkillRemove,
  type SkillCommandContext,
  type SkillPrompts,
} from "../../src/core/commands/skill.ts";
import { renderSkillContent } from "../../src/core/skill/content.ts";
import { makeTestEnv, type TestEnv } from "../helpers.ts";

let env: TestEnv;
let home: string;
beforeEach(async () => {
  env = await makeTestEnv();
  home = join(env.root, "skill-home");
});
afterEach(async () => {
  await env.cleanup();
});

function ctx(overrides: Partial<SkillCommandContext> = {}): SkillCommandContext {
  return { cwd: env.worktree, homeDir: home, inputDisabled: true, ...overrides };
}

function noFlags() {
  return { global: false, project: false, claude: false, agents: false, target: null };
}

const skillFileAt = (skillsDir: string) => join(skillsDir, "glia", "SKILL.md");
const globalClaude = () => join(home, ".claude", "skills");
const globalAgents = () => join(home, ".agents", "skills");

async function exists(path: string): Promise<boolean> {
  return await Bun.file(path).exists();
}

describe("skill install", () => {
  test("non-interactive default installs both global harness paths", async () => {
    const outcome = await runSkillInstall(ctx(), { ...noFlags(), force: false });
    const result = outcome.json as { version: string; results: { status: string }[] };
    expect(result.version).toBe(CLI_VERSION);
    expect(result.results.map((r) => r.status)).toEqual(["created", "created"]);
    const content = await readFile(skillFileAt(globalClaude()), "utf8");
    expect(content).toBe(renderSkillContent(CLI_VERSION));
    expect(await exists(skillFileAt(globalAgents()))).toBe(true);
  });

  test("reinstall is idempotent and reports up to date", async () => {
    await runSkillInstall(ctx(), { ...noFlags(), force: false });
    const outcome = await runSkillInstall(ctx(), { ...noFlags(), force: false });
    const result = outcome.json as { results: { status: string }[] };
    expect(result.results.map((r) => r.status)).toEqual(["up_to_date", "up_to_date"]);
  });

  test("a differing file is overwritten without prompting when input is disabled", async () => {
    await runSkillInstall(ctx(), { ...noFlags(), force: false });
    await writeFile(skillFileAt(globalClaude()), "edited by hand", "utf8");
    const outcome = await runSkillInstall(ctx(), { ...noFlags(), force: false });
    const result = outcome.json as { results: { status: string }[] };
    expect(result.results.map((r) => r.status)).toEqual(["updated", "up_to_date"]);
    expect(await readFile(skillFileAt(globalClaude()), "utf8")).toBe(
      renderSkillContent(CLI_VERSION),
    );
  });

  test("harness flags default the scope to global", async () => {
    await runSkillInstall(ctx(), { ...noFlags(), claude: true, force: false });
    expect(await exists(skillFileAt(globalClaude()))).toBe(true);
    expect(await exists(skillFileAt(globalAgents()))).toBe(false);
  });

  test("--project installs both harness paths under the worktree root", async () => {
    await runSkillInstall(ctx(), { ...noFlags(), project: true, force: false });
    expect(await exists(skillFileAt(join(env.worktree, ".claude", "skills")))).toBe(true);
    expect(await exists(skillFileAt(join(env.worktree, ".agents", "skills")))).toBe(true);
    expect(await exists(skillFileAt(globalClaude()))).toBe(false);
  });

  test("--target alone installs only into the named skills directory", async () => {
    const target = join(env.root, "custom-skills");
    const outcome = await runSkillInstall(ctx(), { ...noFlags(), target, force: false });
    const result = outcome.json as { results: { path: string; scope: null }[] };
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.scope).toBeNull();
    expect(await exists(skillFileAt(target))).toBe(true);
    expect(await exists(skillFileAt(globalClaude()))).toBe(false);
  });

  test("interactive two-step selection installs the chosen scope and harness", async () => {
    const prompts: SkillPrompts = {
      pickScope: async () => "project",
      pickHarnesses: async () => ["claude"],
      pickRemovals: async () => null,
      confirmOverwrite: async () => true,
    };
    await runSkillInstall(ctx({ inputDisabled: false, prompts }), { ...noFlags(), force: false });
    expect(await exists(skillFileAt(join(env.worktree, ".claude", "skills")))).toBe(true);
    expect(await exists(skillFileAt(join(env.worktree, ".agents", "skills")))).toBe(false);
    expect(await exists(skillFileAt(globalClaude()))).toBe(false);
  });

  test("a blank --target is a USAGE error, not an install into the cwd", async () => {
    await expect(
      runSkillInstall(ctx(), { ...noFlags(), target: "  ", force: false }),
    ).rejects.toMatchObject({ code: "USAGE" });
    expect(await exists(join(env.worktree, "glia", "SKILL.md"))).toBe(false);
  });

  test("a symlinked skill directory is replaced without changing its target", async () => {
    const elsewhere = join(env.root, "elsewhere");
    await mkdir(join(home, ".claude", "skills"), { recursive: true });
    await mkdir(elsewhere, { recursive: true });
    await writeFile(join(elsewhere, "SKILL.md"), "original skill");
    await writeFile(join(elsewhere, "notes.md"), "keep me");
    await symlink(elsewhere, join(home, ".claude", "skills", "glia"));
    await runSkillInstall(ctx(), { ...noFlags(), claude: true, force: false });
    expect((await lstat(join(globalClaude(), "glia"))).isDirectory()).toBe(true);
    expect(await readFile(skillFileAt(globalClaude()), "utf8")).toBe(
      renderSkillContent(CLI_VERSION),
    );
    expect(await readFile(join(elsewhere, "SKILL.md"), "utf8")).toBe("original skill");
    expect(await readFile(join(elsewhere, "notes.md"), "utf8")).toBe("keep me");
  });

  for (const dangling of [false, true]) {
    test(`a ${dangling ? "dangling" : "valid"} SKILL.md symlink is replaced without writing through`, async () => {
      const elsewhere = join(env.root, "external-skill.md");
      const dir = join(globalClaude(), "glia");
      await mkdir(dir, { recursive: true });
      if (!dangling) await writeFile(elsewhere, "original skill");
      await symlink(elsewhere, skillFileAt(globalClaude()));
      await writeFile(join(dir, "notes.md"), "keep me");
      await runSkillInstall(ctx(), { ...noFlags(), claude: true, force: false });
      expect((await lstat(skillFileAt(globalClaude()))).isSymbolicLink()).toBe(false);
      expect(await readFile(skillFileAt(globalClaude()), "utf8")).toBe(
        renderSkillContent(CLI_VERSION),
      );
      expect(await readFile(join(dir, "notes.md"), "utf8")).toBe("keep me");
      if (dangling) expect(await exists(elsewhere)).toBe(false);
      else expect(await readFile(elsewhere, "utf8")).toBe("original skill");
    });
  }

  test("an up-to-date directory symlink is left intact", async () => {
    await runSkillInstall(ctx(), { ...noFlags(), agents: true, force: false });
    await mkdir(globalClaude(), { recursive: true });
    const dir = join(globalClaude(), "glia");
    await symlink(join(globalAgents(), "glia"), dir);
    const outcome = await runSkillInstall(ctx(), { ...noFlags(), force: false });
    expect(
      (outcome.json as { results: { status: string }[] }).results.map((r) => r.status),
    ).toEqual(["up_to_date", "up_to_date"]);
    expect((await lstat(dir)).isSymbolicLink()).toBe(true);
  });

  test("declining replacement leaves a directory symlink and its target intact", async () => {
    const elsewhere = join(env.root, "elsewhere");
    await mkdir(globalClaude(), { recursive: true });
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, "SKILL.md"), "original skill");
    const dir = join(globalClaude(), "glia");
    await symlink(elsewhere, dir);
    const prompts: SkillPrompts = {
      pickScope: async () => null,
      pickHarnesses: async () => null,
      pickRemovals: async () => null,
      confirmOverwrite: async () => false,
    };
    await expect(
      runSkillInstall(ctx({ inputDisabled: false, prompts }), {
        ...noFlags(),
        claude: true,
        force: false,
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect((await lstat(dir)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(elsewhere, "SKILL.md"), "utf8")).toBe("original skill");
  });

  test("declining the overwrite confirmation cancels and changes nothing", async () => {
    await runSkillInstall(ctx(), { ...noFlags(), force: false });
    await writeFile(skillFileAt(globalClaude()), "edited by hand", "utf8");
    const prompts: SkillPrompts = {
      pickScope: async () => "global",
      pickHarnesses: async () => ["claude", "agents"],
      pickRemovals: async () => null,
      confirmOverwrite: async () => false,
    };
    await expect(
      runSkillInstall(ctx({ inputDisabled: false, prompts }), { ...noFlags(), force: false }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(await readFile(skillFileAt(globalClaude()), "utf8")).toBe("edited by hand");
  });
});

describe("skill remove", () => {
  test("no flags removes every detected install when input is disabled", async () => {
    await runSkillInstall(ctx(), { ...noFlags(), global: true, project: true, force: false });
    const outcome = await runSkillRemove(ctx(), noFlags());
    const result = outcome.json as { results: { status: string }[] };
    expect(result.results).toHaveLength(4);
    expect(result.results.every((r) => r.status === "removed")).toBe(true);
    expect(await exists(skillFileAt(globalClaude()))).toBe(false);
    expect(await exists(skillFileAt(join(env.worktree, ".agents", "skills")))).toBe(false);
  });

  test("flagged removal reports a location that was never installed", async () => {
    await runSkillInstall(ctx(), { ...noFlags(), claude: true, force: false });
    const outcome = await runSkillRemove(ctx(), { ...noFlags(), claude: true, agents: true });
    const result = outcome.json as { results: { harness: string; status: string }[] };
    expect(result.results.map((r) => [r.harness, r.status])).toEqual([
      ["claude", "removed"],
      ["agents", "not_installed"],
    ]);
  });

  test("nothing installed anywhere is a normal outcome, not an error", async () => {
    const outcome = await runSkillRemove(ctx(), noFlags());
    const result = outcome.json as { results: unknown[] };
    expect(result.results).toEqual([]);
    expect(outcome.human).toContain("not installed");
  });

  test("a hand-written skill named glia is left alone, files intact", async () => {
    const foreignDir = join(globalClaude(), "glia");
    await mkdir(foreignDir, { recursive: true });
    await writeFile(join(foreignDir, "SKILL.md"), "---\nname: glia\n---\nmy own skill", "utf8");
    await writeFile(join(foreignDir, "reference.md"), "keep me", "utf8");

    const noFlagOutcome = await runSkillRemove(ctx(), noFlags());
    expect((noFlagOutcome.json as { results: unknown[] }).results).toEqual([]);

    const flagged = await runSkillRemove(ctx(), { ...noFlags(), claude: true });
    const result = flagged.json as { results: { status: string }[] };
    expect(result.results.map((r) => r.status)).toEqual(["unmanaged"]);
    expect(await exists(join(foreignDir, "SKILL.md"))).toBe(true);
    expect(await exists(join(foreignDir, "reference.md"))).toBe(true);
  });

  test("removal keeps sibling files the user added beside glia's SKILL.md", async () => {
    await runSkillInstall(ctx(), { ...noFlags(), claude: true, force: false });
    const dir = join(globalClaude(), "glia");
    await writeFile(join(dir, "notes.md"), "user notes", "utf8");
    const outcome = await runSkillRemove(ctx(), { ...noFlags(), claude: true });
    const result = outcome.json as { results: { status: string }[] };
    expect(result.results[0]!.status).toBe("removed");
    expect(await exists(join(dir, "SKILL.md"))).toBe(false);
    expect(await exists(join(dir, "notes.md"))).toBe(true);
  });

  test("interactive removal honors the picked subset", async () => {
    await runSkillInstall(ctx(), { ...noFlags(), global: true, force: false });
    const prompts: SkillPrompts = {
      pickScope: async () => null,
      pickHarnesses: async () => null,
      pickRemovals: async (detected) =>
        detected.filter((d) => d.harness === "claude").map((d) => d.skillsDir),
      confirmOverwrite: async () => true,
    };
    const outcome = await runSkillRemove(ctx({ inputDisabled: false, prompts }), noFlags());
    const result = outcome.json as { results: { status: string }[] };
    expect(result.results).toHaveLength(1);
    expect(await exists(skillFileAt(globalClaude()))).toBe(false);
    expect(await exists(skillFileAt(globalAgents()))).toBe(true);
  });
});
