import type { CommandOutcome } from "../output/result.ts";
import { withProgress } from "../output/progress.ts";
import { runSkillInstall, runSkillRemove } from "./skill.ts";
import { runHookRemove, type HookCommandContext } from "./hook.ts";

export interface SetupCommandContext extends HookCommandContext {
  cwd: string;
  homeDir: string;
  jsonMode: boolean;
  inputDisabled: boolean;
  /** Test seam for observing progress phase boundaries without drawing. */
  progress?: typeof withProgress;
}

export async function runSetup(ctx: SetupCommandContext): Promise<CommandOutcome> {
  const progress = ctx.progress ?? withProgress;
  const skill = await progress(
    ctx,
    "Installing Glia skill",
    () => "Glia skill configured",
    () =>
      runSkillInstall(
        { cwd: ctx.cwd, homeDir: ctx.homeDir, inputDisabled: true },
        {
          global: true,
          project: false,
          claude: true,
          agents: true,
          target: null,
          force: false,
        },
      ),
  );
  return {
    json: { skill: skill.json },
    human: `${skill.human}\nSearch local Sessions immediately with \`glia search\`.\nRun \`glia import\` to save existing Sessions, or \`glia import --auto-save on\` to also save future Sessions automatically.`,
  };
}

export async function runSetupRemove(ctx: SetupCommandContext): Promise<CommandOutcome> {
  const hooks = await runHookRemove(ctx);
  const skill = await runSkillRemove(
    { cwd: ctx.cwd, homeDir: ctx.homeDir, inputDisabled: true },
    {
      global: true,
      project: false,
      claude: true,
      agents: true,
      target: null,
    },
  );
  return {
    json: { hooks: hooks.json, skill: skill.json },
    human: `${hooks.human}\n${skill.human}`,
  };
}
