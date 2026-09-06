import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installHookConfig, removeHookConfig } from "../../src/core/hooks/config.ts";
import {
  runSetup,
  runSetupRemove,
  type SetupCommandContext,
} from "../../src/core/commands/setup.ts";
import { makeTestEnv, writeClaudeSession, type TestEnv } from "../helpers.ts";
import { listSessionIds } from "../../src/session/storage/store-layout.ts";
import { projectPaths } from "../../src/core/project/paths.ts";

let env: TestEnv;
let userHome: string;

beforeEach(async () => {
  env = await makeTestEnv();
  userHome = join(env.root, "user-home");
});

afterEach(async () => {
  await env.cleanup();
});

function setupContext(overrides: Partial<SetupCommandContext> = {}): SetupCommandContext {
  return {
    cwd: env.worktree,
    homeDir: userHome,
    env: env.env,
    executablePath: "/opt/glia/bin/glia",
    jsonMode: false,
    inputDisabled: true,
    ...overrides,
  };
}

describe("hook config merge", () => {
  test("preserves unrelated settings and foreign hook bytes, refreshes the binary path, and removes only glia", async () => {
    await mkdir(env.claudeHome, { recursive: true });
    const path = join(env.claudeHome, "settings.json");
    const foreign =
      '{"matcher":"foreign","hooks":[{"type":"command","command":"do-something","timeout":9}]}';
    const original = `{
  "theme": { "keep": "exact spacing" },
  "hooks": {
    "SessionEnd": [
      ${foreign}
    ],
    "Stop": []
  }
}
`;
    await writeFile(path, original, "utf8");
    await chmod(path, 0o600);

    expect((await installHookConfig("claude-code", env.env, "/old/glia")).status).toBe("updated");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const installed = await readFile(path, "utf8");
    expect(installed).toContain('"theme": { "keep": "exact spacing" }');
    expect(installed).toContain(foreign);
    expect((await installHookConfig("claude-code", env.env, "/old/glia")).status).toBe(
      "up_to_date",
    );
    expect(await readFile(path, "utf8")).toBe(installed);

    expect((await installHookConfig("claude-code", env.env, "/new/glia")).status).toBe("updated");
    const refreshed = await readFile(path, "utf8");
    expect(refreshed).toContain("'/new/glia' import --hook");
    expect(refreshed).not.toContain("'/old/glia' import --hook");
    expect(refreshed).toContain(foreign);

    expect((await removeHookConfig("claude-code", env.env)).status).toBe("removed");
    const removed = await readFile(path, "utf8");
    expect(removed).not.toContain("import --hook");
    expect(removed).toContain(foreign);
    expect(removed).toContain('"theme": { "keep": "exact spacing" }');
  });

  test("a user-edited glia-looking entry is reported and left untouched", async () => {
    await mkdir(env.codexHome, { recursive: true });
    const path = join(env.codexHome, "hooks.json");
    const edited = {
      hooks: {
        SessionEnd: [
          {
            hooks: [{ type: "command", command: "'/old/glia' import --hook", timeout: 5 }],
          },
        ],
      },
    };
    await writeFile(path, JSON.stringify(edited, null, 2) + "\n", "utf8");
    const before = await readFile(path, "utf8");

    expect((await removeHookConfig("codex", env.env)).status).toBe("unmanaged");
    expect((await installHookConfig("codex", env.env, "/new/glia")).status).toBe("unmanaged");
    expect(await readFile(path, "utf8")).toBe(before);
  });

  test("a foreign import --hook command is never treated as glia-managed", async () => {
    await mkdir(env.codexHome, { recursive: true });
    const path = join(env.codexHome, "hooks.json");
    const foreign =
      '{"hooks":[{"type":"command","command":"\'/opt/acme\' import --hook","timeout":1}]}';
    const original = `{
  "hooks": {
    "SessionEnd": [
      ${foreign}
    ]
  }
}
`;
    await writeFile(path, original, "utf8");

    expect((await removeHookConfig("codex", env.env)).status).toBe("not_installed");
    expect(await readFile(path, "utf8")).toBe(original);

    expect((await installHookConfig("codex", env.env, "/new/glia")).status).toBe("updated");
    const installed = await readFile(path, "utf8");
    expect(installed).toContain(foreign);
    expect(installed).toContain("'/new/glia' import --hook");

    expect((await removeHookConfig("codex", env.env)).status).toBe("removed");
    const removed = await readFile(path, "utf8");
    expect(removed).toContain(foreign);
    expect(removed).not.toContain("'/new/glia' import --hook");
  });

  test("removal deletes an exact managed entry but preserves an edited sibling", async () => {
    await mkdir(env.codexHome, { recursive: true });
    const path = join(env.codexHome, "hooks.json");
    await installHookConfig("codex", env.env, "/opt/glia");
    const config = JSON.parse(await readFile(path, "utf8")) as {
      hooks: { SessionEnd: unknown[] };
    };
    config.hooks.SessionEnd.push({
      hooks: [{ type: "command", command: "'/custom/glia' import --hook", timeout: 5 }],
    });
    await writeFile(path, JSON.stringify(config, null, 2) + "\n", "utf8");

    expect((await removeHookConfig("codex", env.env)).status).toBe("removed_with_unmanaged");
    const removed = await readFile(path, "utf8");
    expect(removed).not.toContain("'/opt/glia' import --hook");
    expect(removed).toContain("'/custom/glia' import --hook");
  });

  test("a Bun source invocation installs and recognizes the complete command prefix", async () => {
    await mkdir(env.claudeHome, { recursive: true });
    const prefix = ["/opt/bun/bin/bun", "/workspace/packages/cli/src/cli.ts"];

    expect((await installHookConfig("claude-code", env.env, prefix)).status).toBe("created");
    const installed = await readFile(join(env.claudeHome, "settings.json"), "utf8");
    expect(installed).toContain(
      "'/opt/bun/bin/bun' '/workspace/packages/cli/src/cli.ts' import --hook",
    );
    expect((await installHookConfig("claude-code", env.env, prefix)).status).toBe("up_to_date");
    expect((await removeHookConfig("claude-code", env.env)).status).toBe("removed");
  });
});

describe("setup umbrella", () => {
  test("repairs a dangling skill directory symlink and remains idempotent", async () => {
    const skillsDir = join(userHome, ".claude", "skills");
    const dir = join(skillsDir, "glia");
    await mkdir(skillsDir, { recursive: true });
    await symlink("../../.agents/skills/glia", dir);
    const first = await runSetup(setupContext());
    const skillResults = (outcome: typeof first) =>
      (outcome.json as { skill: { results: { status: string }[] } }).skill.results.map(
        (row) => row.status,
      );
    expect(skillResults(first)).toEqual(["created", "created"]);
    expect((await lstat(dir)).isDirectory()).toBe(true);
    expect(
      await Bun.file(join(userHome, ".claude", ".agents", "skills", "glia", "SKILL.md")).exists(),
    ).toBe(false);
    expect(skillResults(await runSetup(setupContext()))).toEqual(["up_to_date", "up_to_date"]);
  });

  test("installs both skill conventions without hooks, prompts, or enrollment", async () => {
    await mkdir(env.claudeHome, { recursive: true });
    await mkdir(env.codexHome, { recursive: true });
    await writeClaudeSession(env.claudeHome, { sessionId: "setup-local", cwd: env.worktree });
    const phases: string[] = [];
    const outcome = await runSetup(
      setupContext({
        inputDisabled: false,
        progress: async (_ctx, message, _done, step) => {
          phases.push(message);
          return await step();
        },
      }),
    );
    expect(outcome.human).toContain("Search local Sessions immediately");
    expect(outcome.human).toContain("--auto-save on");
    expect(phases).toEqual(["Installing Glia skill"]);
    for (const path of [
      join(env.claudeHome, "settings.json"),
      join(env.codexHome, "hooks.json"),
      join(env.home, "projects"),
    ]) {
      expect(await Bun.file(path).exists()).toBeFalse();
    }
    for (const convention of [".claude", ".agents"]) {
      expect(
        await Bun.file(join(userHome, convention, "skills", "glia", "SKILL.md")).exists(),
      ).toBeTrue();
    }
    expect((await runSetup(setupContext())).human).toContain("up to date");
  });

  test("setup preserves existing hooks; explicit removal removes only managed integration", async () => {
    await mkdir(env.codexHome, { recursive: true });
    await installHookConfig("codex", env.env, "/opt/glia/bin/glia");
    const path = join(env.codexHome, "hooks.json");
    const before = await readFile(path, "utf8");
    await runSetup(setupContext());
    expect(await readFile(path, "utf8")).toBe(before);
    await runSetupRemove(setupContext());
    expect(await readFile(path, "utf8")).not.toContain("import --hook");
    expect(
      await Bun.file(join(userHome, ".agents", "skills", "glia", "SKILL.md")).exists(),
    ).toBeFalse();
  });

  test("setup works outside Git without creating a Glia Project", async () => {
    await runSetup(setupContext({ cwd: env.root }));
    expect(await Bun.file(join(env.home, "projects")).exists()).toBeFalse();
    expect(await Bun.file(join(env.codexHome, "hooks.json")).exists()).toBeFalse();
    expect(await Bun.file(join(env.claudeHome, "settings.json")).exists()).toBeFalse();
  });
});
