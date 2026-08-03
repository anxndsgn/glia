import type { HarnessId } from "../harnesses/ids.ts";
import type { CommandOutcome } from "../output/result.ts";
import { confirmProceed } from "../output/confirm.ts";
import { gliaHome } from "../project/paths.ts";
import { loadProject } from "../project/load.ts";
import { resolveWorktreeTopLevel } from "../project/resolve.ts";
import { runImport, type ImportReport } from "../../session/domain/import.ts";
import { humanImportReport } from "../../session/commands/import.ts";
import { runSkillInstall, runSkillRemove } from "./skill.ts";
import {
  harnessIsPresent,
  runHookInstall,
  runHookRemove,
  type HookCommandContext,
} from "./hook.ts";

export interface SetupCommandContext extends HookCommandContext {
  cwd: string;
  homeDir: string;
  inputDisabled: boolean;
  /** Test seam for the optional backlog offer. */
  confirmImport?: (message: string) => Promise<boolean>;
}

async function worktreeOrNull(cwd: string): Promise<string | null> {
  try {
    return await resolveWorktreeTopLevel(cwd);
  } catch {
    return null;
  }
}

export async function runSetup(ctx: SetupCommandContext): Promise<CommandOutcome> {
  const presence = new Map<HarnessId, boolean>();
  for (const harnessId of ["codex", "claude-code"] as const) {
    presence.set(harnessId, await harnessIsPresent(harnessId, ctx.env));
  }
  // Snapshot presence before installing ~/.claude/skills/glia, which must
  // not manufacture a Claude Code installation on an otherwise absent machine.
  const hooks = await runHookInstall(ctx, presence);
  const skill = await runSkillInstall(
    { cwd: ctx.cwd, homeDir: ctx.homeDir, inputDisabled: true },
    {
      global: true,
      project: false,
      claude: true,
      agents: true,
      target: null,
      force: false,
    },
  );

  const worktree = await worktreeOrNull(ctx.cwd);
  let importReport: ImportReport | null = null;
  let backlogGuidance: string | null = null;
  if (worktree !== null && ctx.inputDisabled) {
    backlogGuidance =
      "Backlog import skipped because input is disabled; run `glia import` here to opt in this repository.";
  } else if (worktree !== null) {
    const confirm = ctx.confirmImport ?? confirmProceed;
    if (await confirm("Import this repository's existing Session backlog now?")) {
      const project = await loadProject(worktree, gliaHome(ctx.env));
      importReport = await runImport(project, ctx.env, {
        harness: null,
        dryRun: false,
        onlyCandidateIds: null,
      });
    } else {
      backlogGuidance = "Backlog import skipped; run `glia import` here whenever you are ready.";
    }
  }

  const trustNotice =
    "On next launch, each installed Harness will ask you to trust/confirm the new SessionEnd hook; automation is inert until approved.";
  const pathNotice =
    `The hook depends on ${(ctx.selfCommand ?? [ctx.executablePath]).join(" ")}; ` +
    "re-run `glia setup` after moving or replacing that command.";
  const lines = [hooks.human, skill.human];
  if (importReport !== null) lines.push(humanImportReport(importReport));
  if (backlogGuidance !== null) lines.push(backlogGuidance);
  lines.push(trustNotice, pathNotice);
  return {
    json: {
      hooks: hooks.json,
      skill: skill.json,
      backlog: {
        worktree,
        imported: importReport,
        guidance: backlogGuidance,
      },
      trustRequired: true,
      executablePath: ctx.executablePath,
    },
    human: lines.join("\n"),
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
