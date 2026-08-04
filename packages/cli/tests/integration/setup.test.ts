import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
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
  test("installs both present Harness hooks and both skill conventions idempotently", async () => {
    await mkdir(env.claudeHome, { recursive: true });
    await mkdir(env.codexHome, { recursive: true });

    const first = await runSetup(setupContext());
    expect(first.human).toContain("automation is inert until approved");
    expect(first.human).toContain("Backlog import skipped");
    expect(await Bun.file(join(env.claudeHome, "settings.json")).exists()).toBeTrue();
    expect(await Bun.file(join(env.codexHome, "hooks.json")).exists()).toBeTrue();
    expect(
      await Bun.file(join(userHome, ".claude", "skills", "glia", "SKILL.md")).exists(),
    ).toBeTrue();
    expect(
      await Bun.file(join(userHome, ".agents", "skills", "glia", "SKILL.md")).exists(),
    ).toBeTrue();

    const before = await Promise.all([
      readFile(join(env.claudeHome, "settings.json"), "utf8"),
      readFile(join(env.codexHome, "hooks.json"), "utf8"),
      readFile(join(userHome, ".claude", "skills", "glia", "SKILL.md"), "utf8"),
    ]);
    const second = await runSetup(setupContext());
    expect(second.human).toContain("up to date");
    expect(
      await Promise.all([
        readFile(join(env.claudeHome, "settings.json"), "utf8"),
        readFile(join(env.codexHome, "hooks.json"), "utf8"),
        readFile(join(userHome, ".claude", "skills", "glia", "SKILL.md"), "utf8"),
      ]),
    ).toEqual(before);

    const removed = await runSetupRemove(setupContext());
    expect(removed.human).toContain("removed");
    expect(await readFile(join(env.claudeHome, "settings.json"), "utf8")).not.toContain(
      "import --hook",
    );
    expect(
      await Bun.file(join(userHome, ".agents", "skills", "glia", "SKILL.md")).exists(),
    ).toBeFalse();
  });

  test("absent Harnesses are skipped without creating their hook homes", async () => {
    const outcome = await runSetup(setupContext());
    const rows = (outcome.json as { hooks: { results: { status: string }[] } }).hooks.results;
    expect(rows.map((row) => row.status)).toEqual(["skipped_absent", "skipped_absent"]);
    expect(await Bun.file(join(env.codexHome, "hooks.json")).exists()).toBeFalse();
    expect(await Bun.file(join(env.claudeHome, "settings.json")).exists()).toBeFalse();
  });

  test("interactive consent imports the current repository backlog and creates its Binding", async () => {
    await mkdir(env.claudeHome, { recursive: true });
    await writeClaudeSession(env.claudeHome, { sessionId: "setup-backlog", cwd: env.worktree });
    const phases: { message: string; done: string }[] = [];
    const outcome = await runSetup(
      setupContext({
        inputDisabled: false,
        confirmImport: async () => true,
        progress: async (_ctx, message, done, step) => {
          const result = await step();
          phases.push({ message, done: done(result) });
          return result;
        },
      }),
    );
    const backlog = (outcome.json as { backlog: { imported: { accepted: unknown[] } } }).backlog;
    expect(backlog.imported.accepted).toHaveLength(1);
    const projects = await readdir(join(env.home, "projects"));
    expect(projects).toHaveLength(1);
    expect(await listSessionIds(projectPaths(env.home, projects[0]!).storeDir)).toHaveLength(1);
    expect(phases).toEqual([
      { message: "Installing SessionEnd hooks", done: "SessionEnd hooks configured" },
      { message: "Installing Glia skill", done: "Glia skill configured" },
      {
        message: "Importing existing Session backlog",
        done: "Backlog import complete: 1 accepted, 0 unchanged",
      },
    ]);
  });
});
