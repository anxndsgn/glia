#!/usr/bin/env bun
import { homedir } from "node:os";
import { Command, CommanderError } from "commander";
import { buildIdentityLine, buildInfo } from "./core/build-info.ts";
import { runSkillInstall, runSkillRemove } from "./core/commands/skill.ts";
import { runStatus } from "./core/commands/status.ts";
import { runStoreRemoteSet, runStoreRemoteShow } from "./core/commands/store-remote.ts";
import { runSyncCommand } from "./core/commands/sync.ts";
import type { CommandRunContext } from "./core/session-module.ts";
import { toGliaError } from "./core/output/errors.ts";
import {
  renderError,
  renderSuccess,
  type CommandOutcome,
  type RenderTarget,
} from "./core/output/result.ts";
import { colorEnabled } from "./core/output/terminal.ts";
import { loadProject } from "./core/project/load.ts";
import { gliaHome } from "./core/project/paths.ts";
import { sessionModule } from "./session/module.ts";

const target: RenderTarget = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

const program = new Command();
program
  .name("glia")
  .description("Glia — capture, preserve, and read coding-agent Sessions")
  .version(buildIdentityLine(buildInfo()))
  .option("--json", "emit exactly one versioned JSON document on stdout")
  .option("--no-input", "disable interaction even on a TTY")
  .exitOverride();

interface GlobalFlags {
  jsonMode: boolean;
  inputDisabled: boolean;
}

function globalFlags(): GlobalFlags {
  const opts = program.opts<{ json?: boolean; input: boolean }>();
  const jsonMode = opts.json === true;
  const tty = process.stdin.isTTY === true && process.stdout.isTTY === true;
  return { jsonMode, inputDisabled: opts.input === false || jsonMode || !tty };
}

async function execute(
  commandPath: string,
  fn: (flags: GlobalFlags) => Promise<CommandOutcome> | CommandOutcome,
): Promise<void> {
  const flags = globalFlags();
  try {
    renderSuccess(commandPath, await fn(flags), flags.jsonMode, target);
    process.exitCode = 0;
  } catch (error) {
    renderError(commandPath, toGliaError(error), flags.jsonMode, target);
    process.exitCode = 1;
  }
}

async function loadRunContext(
  flags: GlobalFlags,
  options: { allowMissingStore?: boolean } = {},
): Promise<CommandRunContext> {
  const project = await loadProject(process.cwd(), gliaHome(), options);
  return {
    project,
    env: Bun.env,
    jsonMode: flags.jsonMode,
    inputDisabled: flags.inputDisabled,
    colors: !flags.jsonMode && colorEnabled(Bun.env, process.stdout.isTTY === true),
  };
}

// Session is built in and always enabled. Its verbs live directly at the
// root command surface rather than behind a namespace.
for (const definition of sessionModule.commands) {
  const command = program.command(definition.name).description(definition.description);
  for (const argument of definition.arguments ?? []) {
    command.argument(
      argument.name.startsWith("[") ? argument.name : `<${argument.name}>`,
      argument.description,
    );
  }
  for (const option of definition.options ?? []) {
    if (option.repeatable) {
      command.option(
        option.flags,
        option.description,
        (value: string, previous: string[]) => [...previous, value],
        [] as string[],
      );
    } else {
      command.option(option.flags, option.description);
    }
  }
  command.action(async (...invocation: unknown[]) => {
    const args = invocation
      .slice(0, -2)
      .flatMap((value) =>
        Array.isArray(value)
          ? value.map((item) => String(item))
          : [value === undefined || value === null ? undefined : String(value)],
      );
    const options = invocation[invocation.length - 2] as Record<string, unknown>;
    await execute(definition.name, async (flags) =>
      definition.run(await loadRunContext(flags), args, options),
    );
  });
}

program
  .command("sync")
  .description("synchronize the whole Store with its declared remote (explicit, idempotent)")
  .action(async () => {
    await execute("sync", async (flags) =>
      runSyncCommand(await loadRunContext(flags, { allowMissingStore: true }), [sessionModule]),
    );
  });

const storeRemote = program
  .command("store")
  .description("manage the Project Store")
  .command("remote")
  .description("declare or show the Store's credential-free Git remote");
storeRemote
  .command("set")
  .description("declare the Store remote in glia.json (offline; repeatable)")
  .argument("<url>", "credential-free Git URL or absolute path")
  .option("--dry-run", "print the declaration change without writing")
  .option("--yes", "accept the declaration change without prompting")
  .action(async (url: string, opts: { dryRun?: boolean; yes?: boolean }) => {
    await execute("store.remote.set", async (flags) =>
      runStoreRemoteSet(await loadRunContext(flags, { allowMissingStore: true }), url, {
        dryRun: opts.dryRun === true,
        yes: opts.yes === true,
      }),
    );
  });
storeRemote
  .command("show")
  .description("show the declared Store remote")
  .action(async () => {
    await execute("store.remote.show", async (flags) =>
      runStoreRemoteShow(await loadRunContext(flags, { allowMissingStore: true })),
    );
  });

interface SkillCliOptions {
  global?: boolean;
  project?: boolean;
  claude?: boolean;
  agents?: boolean;
  target?: string;
  force?: boolean;
}

function skillTargetFlags(opts: SkillCliOptions) {
  return {
    global: opts.global === true,
    project: opts.project === true,
    claude: opts.claude === true,
    agents: opts.agents === true,
    target: opts.target ?? null,
  };
}

function addSkillTargetOptions(command: Command): Command {
  return command
    .option("--global", "target the home directory (~/.claude, ~/.agents)")
    .option("--project", "target the current Git worktree root")
    .option("--claude", "target .claude/skills (Claude Code)")
    .option("--agents", "target .agents/skills (Agent Skills standard)")
    .option("--target <path>", "also use this skills directory (it holds glia/SKILL.md)");
}

const skill = program
  .command("skill")
  .description("install or remove the bundled glia agent skill (SKILL.md)");
addSkillTargetOptions(
  skill
    .command("install")
    .description("install the glia SKILL.md so coding agents know how to use glia"),
)
  .option("--force", "overwrite a differing SKILL.md without prompting")
  .action(async (opts: SkillCliOptions) => {
    await execute("skill.install", (flags) =>
      runSkillInstall(
        { cwd: process.cwd(), homeDir: homedir(), inputDisabled: flags.inputDisabled },
        { ...skillTargetFlags(opts), force: opts.force === true },
      ),
    );
  });
addSkillTargetOptions(
  skill.command("remove").description("remove installed glia SKILL.md copies"),
).action(async (opts: SkillCliOptions) => {
  await execute("skill.remove", (flags) =>
    runSkillRemove(
      { cwd: process.cwd(), homeDir: homedir(), inputDisabled: flags.inputDisabled },
      skillTargetFlags(opts),
    ),
  );
});

program
  .command("status")
  .description("report Project, Store, Binding, and Session state (read-only)")
  .action(async () => {
    await execute("status", async (flags) => {
      const ctx = await loadRunContext(flags, { allowMissingStore: true });
      return runStatus(ctx.project, [sessionModule], ctx.env);
    });
  });

const argv = process.argv.slice(2);
if (argv.includes("--version") || argv.includes("-V")) {
  const info = buildInfo();
  renderSuccess(
    "version",
    { json: info, human: buildIdentityLine(info) },
    argv.includes("--json"),
    target,
  );
  process.exitCode = 0;
} else {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      process.exitCode =
        error.code === "commander.helpDisplayed" ||
        error.code === "commander.version" ||
        error.code === "commander.help"
          ? 0
          : 2;
    } else {
      renderError("glia", toGliaError(error), argv.includes("--json"), target);
      process.exitCode = 1;
    }
  }
}
