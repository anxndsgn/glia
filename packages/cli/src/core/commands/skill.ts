import { lstat, mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { CLI_VERSION } from "../build-info.ts";
import { readFileIfPresent } from "../state/atomic-file.ts";
import { confirmProceed } from "../output/confirm.ts";
import { GliaError } from "../output/errors.ts";
import type { CommandOutcome } from "../output/result.ts";
import { resolveWorktreeTopLevel, worktreeTopLevelOrNull } from "../project/resolve.ts";
import { isManagedSkillContent, renderSkillContent, SKILL_NAME } from "../skill/content.ts";
import {
  ALL_HARNESSES,
  ALL_SCOPES,
  anyMatrixFlag,
  dedupeDestinations,
  harnessesFrom,
  matrixDestinations,
  scopesFrom,
  type MatrixFlags,
  type SkillDestination,
  type SkillHarness,
  type SkillScope,
} from "../skill/destinations.ts";

export interface SkillCommandContext {
  cwd: string;
  homeDir: string;
  inputDisabled: boolean;
  /** Test seam; the default prompts render with `@clack/prompts`. */
  prompts?: SkillPrompts;
}

/** Each returns null on cancel; the caller words the CANCELLED error. */
export interface SkillPrompts {
  pickScope(): Promise<SkillScope | null>;
  pickHarnesses(): Promise<SkillHarness[] | null>;
  pickRemovals(detected: SkillDestination[], homeDir: string): Promise<string[] | null>;
  confirmOverwrite(message: string): Promise<boolean>;
}

export interface SkillTargetFlags extends MatrixFlags {
  target: string | null;
}

export interface SkillInstallFlags extends SkillTargetFlags {
  force: boolean;
}

type InstallStatus = "created" | "updated" | "up_to_date";
type RemoveStatus = "removed" | "not_installed" | "unmanaged";

function cancelled(verb: string): GliaError {
  return new GliaError("CANCELLED", `skill ${verb} cancelled; nothing was changed`);
}

function targetDestination(cwd: string, target: string): SkillDestination {
  const trimmed = target.trim();
  if (trimmed.length === 0) {
    throw new GliaError("USAGE", "--target requires a non-empty skills directory path");
  }
  return { scope: null, harness: null, skillsDir: resolve(cwd, trimmed) };
}

function skillFile(destination: SkillDestination): string {
  return join(destination.skillsDir, SKILL_NAME, "SKILL.md");
}

/** A symlinked destination would redirect the write outside the chosen
 * directory (worse under --force / --no-input, where nothing confirms);
 * refuse it instead of following it. Absence is fine. */
async function assertNoSymlink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new GliaError("USAGE", `refusing to write through a symlink at ${path}`, { path });
    }
  } catch (error) {
    if (error instanceof GliaError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function displayPath(path: string, homeDir: string): string {
  return path === homeDir || path.startsWith(homeDir + sep)
    ? `~${path.slice(homeDir.length)}`
    : path;
}

function statusRows(
  rows: { destination: SkillDestination; status: string }[],
  homeDir: string,
  labels: Record<string, string>,
): string {
  const width = Math.max(...rows.map((row) => labels[row.status]!.length));
  return rows
    .map(
      (row) =>
        `  ${labels[row.status]!.padEnd(width)}  ${displayPath(join(row.destination.skillsDir, SKILL_NAME), homeDir)}`,
    )
    .join("\n");
}

function jsonRows(rows: { destination: SkillDestination; status: string }[]): object[] {
  return rows.map((row) => ({
    path: join(row.destination.skillsDir, SKILL_NAME),
    scope: row.destination.scope,
    harness: row.destination.harness,
    status: row.status,
  }));
}

async function defaultPrompts(): Promise<SkillPrompts> {
  const { select, multiselect, isCancel } = await import("@clack/prompts");
  return {
    async pickScope(): Promise<SkillScope | null> {
      const answer = await select({
        message: "Install the glia skill for which scope?",
        options: [
          { value: "global" as const, label: "Global", hint: "under your home directory" },
          { value: "project" as const, label: "This project", hint: "under the worktree root" },
        ],
        initialValue: "global" as const,
      });
      return isCancel(answer) ? null : answer;
    },
    async pickHarnesses(): Promise<SkillHarness[] | null> {
      const answer = await multiselect({
        message: "Into which skills directories?",
        options: [
          { value: "claude" as const, label: ".claude/skills", hint: "Claude Code" },
          { value: "agents" as const, label: ".agents/skills", hint: "Agent Skills standard" },
        ],
        initialValues: ["claude" as const, "agents" as const],
        required: true,
      });
      return isCancel(answer) ? null : answer;
    },
    async pickRemovals(detected, homeDir): Promise<string[] | null> {
      const answer = await multiselect({
        message: "Remove the glia skill from which locations?",
        options: detected.map((destination) => ({
          value: destination.skillsDir,
          label: displayPath(join(destination.skillsDir, SKILL_NAME), homeDir),
        })),
        initialValues: detected.map((destination) => destination.skillsDir),
        required: false,
      });
      return isCancel(answer) ? null : answer;
    },
    confirmOverwrite: confirmProceed,
  };
}

/**
 * Destinations the flags name outright — the scope × harness matrix plus
 * the `--target` escape hatch — or null when no flag was given and the
 * verb decides interactively.
 */
async function flaggedDestinations(
  ctx: SkillCommandContext,
  flags: SkillTargetFlags,
): Promise<SkillDestination[] | null> {
  const custom = flags.target === null ? [] : [targetDestination(ctx.cwd, flags.target)];
  if (anyMatrixFlag(flags)) {
    const scopes = scopesFrom(flags);
    const worktree = scopes.includes("project") ? await resolveWorktreeTopLevel(ctx.cwd) : null;
    return dedupeDestinations([
      ...matrixDestinations(scopes, harnessesFrom(flags), ctx.homeDir, worktree),
      ...custom,
    ]);
  }
  return custom.length > 0 ? custom : null;
}

/**
 * The scope × harness matrix, resolved from flags when any are given,
 * from the two-step prompt on a terminal, and from the defaults —
 * global × both harnesses — when input is disabled.
 */
async function installDestinations(
  ctx: SkillCommandContext,
  flags: SkillTargetFlags,
): Promise<SkillDestination[]> {
  const flagged = await flaggedDestinations(ctx, flags);
  if (flagged !== null) return flagged;
  if (ctx.inputDisabled) {
    return matrixDestinations(["global"], ALL_HARNESSES, ctx.homeDir, null);
  }
  const prompts = ctx.prompts ?? (await defaultPrompts());
  const scope = await prompts.pickScope();
  if (scope === null) throw cancelled("install");
  const harnesses = await prompts.pickHarnesses();
  if (harnesses === null || harnesses.length === 0) throw cancelled("install");
  const worktree = scope === "project" ? await resolveWorktreeTopLevel(ctx.cwd) : null;
  return matrixDestinations([scope], harnesses, ctx.homeDir, worktree);
}

export async function runSkillInstall(
  ctx: SkillCommandContext,
  flags: SkillInstallFlags,
): Promise<CommandOutcome> {
  const destinations = await installDestinations(ctx, flags);
  const content = renderSkillContent(CLI_VERSION);
  const plans: { destination: SkillDestination; status: InstallStatus }[] = [];
  for (const destination of destinations) {
    const existing = await readFileIfPresent(skillFile(destination));
    const status: InstallStatus =
      existing === null ? "created" : existing === content ? "up_to_date" : "updated";
    plans.push({ destination, status });
  }

  const overwrites = plans.filter((plan) => plan.status === "updated");
  if (overwrites.length > 0 && !flags.force && !ctx.inputDisabled) {
    const listing = overwrites
      .map((plan) => `  ${displayPath(skillFile(plan.destination), ctx.homeDir)}`)
      .join("\n");
    const noun = overwrites.length === 1 ? "file differs" : "files differ";
    const confirm = ctx.prompts?.confirmOverwrite ?? confirmProceed;
    const proceed = await confirm(
      `${overwrites.length} existing SKILL.md ${noun} from version ${CLI_VERSION} and will be overwritten:\n${listing}\n\nContinue?`,
    );
    if (!proceed) throw cancelled("install");
  }

  for (const plan of plans) {
    if (plan.status === "up_to_date") continue;
    const dir = join(plan.destination.skillsDir, SKILL_NAME);
    await assertNoSymlink(dir);
    await assertNoSymlink(join(dir, "SKILL.md"));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), content, "utf8");
  }

  return {
    json: { skill: SKILL_NAME, version: CLI_VERSION, results: jsonRows(plans) },
    human:
      `glia skill ${CLI_VERSION}\n` +
      statusRows(plans, ctx.homeDir, {
        created: "created",
        updated: "updated",
        up_to_date: "up to date",
      }),
  };
}

type InstallState = "managed" | "foreign" | "absent";

/** What sits at the destination: a glia-written SKILL.md, someone else's
 * skill that merely shares the name, or nothing. */
async function installState(destination: SkillDestination): Promise<InstallState> {
  const content = await readFileIfPresent(skillFile(destination));
  if (content === null) return "absent";
  return isManagedSkillContent(content) ? "managed" : "foreign";
}

export async function runSkillRemove(
  ctx: SkillCommandContext,
  flags: SkillTargetFlags,
): Promise<CommandOutcome> {
  const flagged = await flaggedDestinations(ctx, flags);
  let selected: SkillDestination[];
  if (flagged !== null) {
    selected = flagged;
  } else {
    // No flags: offer exactly what is installed across the known matrix.
    const candidates = dedupeDestinations(
      matrixDestinations(
        ALL_SCOPES,
        ALL_HARNESSES,
        ctx.homeDir,
        await worktreeTopLevelOrNull(ctx.cwd),
      ),
    );
    const detected: SkillDestination[] = [];
    for (const candidate of candidates) {
      if ((await installState(candidate)) === "managed") detected.push(candidate);
    }
    if (detected.length === 0) {
      return {
        json: { skill: SKILL_NAME, results: [] },
        human: "The glia skill is not installed in any known location.",
      };
    }
    if (ctx.inputDisabled) {
      selected = detected;
    } else {
      const prompts = ctx.prompts ?? (await defaultPrompts());
      const chosen = await prompts.pickRemovals(detected, ctx.homeDir);
      if (chosen === null) throw cancelled("remove");
      selected = detected.filter((destination) => chosen.includes(destination.skillsDir));
      if (selected.length === 0) {
        return {
          json: { skill: SKILL_NAME, results: [] },
          human: "Nothing selected; nothing was removed.",
        };
      }
    }
  }

  const results: { destination: SkillDestination; status: RemoveStatus }[] = [];
  for (const destination of selected) {
    const state = await installState(destination);
    if (state !== "managed") {
      results.push({ destination, status: state === "foreign" ? "unmanaged" : "not_installed" });
      continue;
    }
    // Delete only the file glia wrote; the directory goes only once empty,
    // so anything else living beside the SKILL.md survives the removal.
    const dir = join(destination.skillsDir, SKILL_NAME);
    await assertNoSymlink(dir);
    await rm(join(dir, "SKILL.md"), { force: true });
    await rmdir(dir).catch(() => {});
    results.push({ destination, status: "removed" });
  }

  return {
    json: { skill: SKILL_NAME, results: jsonRows(results) },
    human:
      "glia skill removal\n" +
      statusRows(results, ctx.homeDir, {
        removed: "removed",
        not_installed: "not installed",
        unmanaged: "left alone (not glia-managed)",
      }),
  };
}
