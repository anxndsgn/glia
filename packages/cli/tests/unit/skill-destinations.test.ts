import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CLI_VERSION } from "../../src/core/build-info.ts";
import { renderSkillContent, SKILL_NAME } from "../../src/core/skill/content.ts";
import {
  anyMatrixFlag,
  dedupeDestinations,
  harnessesFrom,
  matrixDestinations,
  scopesFrom,
  type MatrixFlags,
} from "../../src/core/skill/destinations.ts";

const HOME = "/home/user";
const WORKTREE = "/repos/project";

function flags(partial: Partial<MatrixFlags>): MatrixFlags {
  return { global: false, project: false, claude: false, agents: false, ...partial };
}

describe("skill destination matrix", () => {
  test("no flags means no matrix", () => {
    expect(anyMatrixFlag(flags({}))).toBe(false);
  });

  test("scope defaults to global, harness defaults to both", () => {
    expect(scopesFrom(flags({ claude: true }))).toEqual(["global"]);
    expect(harnessesFrom(flags({ project: true }))).toEqual(["claude", "agents"]);
  });

  test("flags within one axis combine", () => {
    expect(scopesFrom(flags({ global: true, project: true }))).toEqual(["global", "project"]);
    expect(harnessesFrom(flags({ claude: true, agents: true }))).toEqual(["claude", "agents"]);
  });

  test("the cross product resolves the four known skills directories", () => {
    const destinations = matrixDestinations(
      ["global", "project"],
      ["claude", "agents"],
      HOME,
      WORKTREE,
    );
    expect(destinations.map((d) => d.skillsDir)).toEqual([
      join(HOME, ".claude", "skills"),
      join(HOME, ".agents", "skills"),
      join(WORKTREE, ".claude", "skills"),
      join(WORKTREE, ".agents", "skills"),
    ]);
  });

  test("project rows are skipped without a worktree", () => {
    const destinations = matrixDestinations(["global", "project"], ["claude"], HOME, null);
    expect(destinations).toHaveLength(1);
    expect(destinations[0]!.scope).toBe("global");
  });

  test("duplicate skills directories collapse", () => {
    const twice = [
      ...matrixDestinations(["global"], ["claude"], HOME, null),
      ...matrixDestinations(["global"], ["claude"], HOME, null),
    ];
    expect(dedupeDestinations(twice)).toHaveLength(1);
  });
});

describe("skill content", () => {
  test("renders the CLI version into the frontmatter", () => {
    const content = renderSkillContent(CLI_VERSION);
    expect(content).toContain(`name: ${SKILL_NAME}`);
    expect(content).toContain(`glia_version: ${CLI_VERSION}`);
    expect(content).not.toContain("__GLIA_VERSION__");
  });
});
