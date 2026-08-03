import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { HARNESS_IDS, type HarnessId } from "../harnesses/ids.ts";
import { harnessHome } from "../harnesses/home.ts";
import type { CommandOutcome } from "../output/result.ts";
import { installHookConfig, removeHookConfig, type HookResult } from "../hooks/config.ts";

export interface HookCommandContext {
  env: Record<string, string | undefined>;
  executablePath: string;
  /** Bun + source script in development; one compiled binary in releases. */
  selfCommand?: readonly string[];
}

export interface HookCommandRow extends Omit<HookResult, "status"> {
  status: HookResult["status"] | "skipped_absent";
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Setup itself creates ~/.claude/skills/glia. That lone managed skill must
 * not make an absent Claude installation appear on the next setup run.
 */
export async function harnessIsPresent(
  harnessId: HarnessId,
  env: Record<string, string | undefined>,
): Promise<boolean> {
  const home = harnessHome(harnessId, env);
  if (!(await directoryExists(home))) return false;
  if (harnessId !== "claude-code") return true;
  const entries = await readdir(home);
  if (entries.length === 0 || entries.some((entry) => entry !== "skills")) return true;
  const skills = join(home, "skills");
  if (!(await directoryExists(skills))) return true;
  const skillEntries = await readdir(skills);
  return skillEntries.some((entry) => entry !== "glia");
}

function renderRows(verb: string, rows: readonly HookCommandRow[]): string {
  const labels: Record<HookCommandRow["status"], string> = {
    created: "created",
    updated: "updated",
    up_to_date: "up to date",
    removed: "removed",
    removed_with_unmanaged: "removed managed; left edited entry alone",
    not_installed: "not installed",
    unmanaged: "left alone (not positively glia-managed)",
    skipped_absent: "skipped (Harness home absent)",
  };
  return [
    `glia hook ${verb}`,
    ...rows.map((row) => `  ${labels[row.status]}  ${row.harnessId} ${row.path}`),
  ].join("\n");
}

export async function runHookInstall(
  ctx: HookCommandContext,
  presence?: ReadonlyMap<HarnessId, boolean>,
): Promise<CommandOutcome> {
  const rows: HookCommandRow[] = [];
  for (const harnessId of HARNESS_IDS) {
    const present = presence?.get(harnessId) ?? (await harnessIsPresent(harnessId, ctx.env));
    if (!present) {
      rows.push({
        harnessId,
        path: harnessHome(harnessId, ctx.env),
        status: "skipped_absent",
      });
      continue;
    }
    rows.push(await installHookConfig(harnessId, ctx.env, ctx.selfCommand ?? [ctx.executablePath]));
  }
  return {
    json: {
      executablePath: ctx.executablePath,
      commandPrefix: ctx.selfCommand ?? [ctx.executablePath],
      results: rows,
    },
    human: renderRows("install", rows),
  };
}

export async function runHookRemove(ctx: HookCommandContext): Promise<CommandOutcome> {
  const rows: HookCommandRow[] = [];
  for (const harnessId of HARNESS_IDS) {
    if (!(await directoryExists(harnessHome(harnessId, ctx.env)))) {
      rows.push({
        harnessId,
        path: harnessHome(harnessId, ctx.env),
        status: "skipped_absent",
      });
      continue;
    }
    rows.push(await removeHookConfig(harnessId, ctx.env));
  }
  return { json: { results: rows }, human: renderRows("remove", rows) };
}
