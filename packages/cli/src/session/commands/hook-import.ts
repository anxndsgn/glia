import { spawn } from "node:child_process";
import { basename, resolve } from "node:path";
import { GliaError, toGliaError } from "../../core/output/errors.ts";
import {
  recordHookRun,
  touchHookLiveness,
  type HookRunReport,
} from "../../core/hooks/run-state.ts";
import { loadExistingProject } from "../../core/project/load.ts";
import { gliaHome } from "../../core/project/paths.ts";
import { runImport } from "../domain/import.ts";

export interface HookInvocationContext {
  cwd: string;
  env: Record<string, string | undefined>;
  jsonMode: boolean;
  /** Test seam; defaults to the current compiled binary or Bun script. */
  selfCommand?: string[];
  /** Test seam for proving diagnostic-report failures stay best-effort. */
  recordRun?: typeof recordHookRun;
}

export function currentSelfCommand(): string[] {
  const executable = resolve(process.execPath);
  const script = process.argv[1];
  if (
    basename(executable).startsWith("bun") &&
    script !== undefined &&
    (script.endsWith(".ts") || script.endsWith(".js"))
  ) {
    return [executable, resolve(script)];
  }
  return [executable];
}

export function hookExecutablePath(): string {
  const command = currentSelfCommand();
  // Release builds have a one-element command. Source runs install the full
  // Bun + script prefix; this field remains the primary executable for output.
  return command[0]!;
}

export function hookRunsForeground(env: Record<string, string | undefined>): boolean {
  return env["GLIA_HOOK_FOREGROUND"] === "1";
}

export function spawnDetachedHook(
  cwd: string,
  env: Record<string, string | undefined>,
  selfCommand: string[] = currentSelfCommand(),
): void {
  const child = spawn(selfCommand[0]!, [...selfCommand.slice(1), "import", "--hook"], {
    cwd,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ...env, GLIA_HOOK_FOREGROUND: "1" },
  });
  // ENOENT and similar launch failures arrive asynchronously on ChildProcess.
  // The hook contract is fire-and-forget and must still exit successfully.
  child.once("error", () => {});
  child.unref();
}

/**
 * Stable hook entrypoint. Apart from the explicit --json usage error, every
 * outcome is quiet and successful from the Harness's perspective.
 */
export async function runHookInvocation(ctx: HookInvocationContext): Promise<void> {
  if (ctx.jsonMode) {
    throw new GliaError("USAGE", "--hook cannot be combined with --json");
  }
  const home = gliaHome(ctx.env);
  try {
    // Liveness is diagnostic state; a locked or damaged stamp must not stop
    // the actual import hook from running.
    await touchHookLiveness(home).catch(() => {});
    if (!hookRunsForeground(ctx.env)) {
      spawnDetachedHook(ctx.cwd, ctx.env, ctx.selfCommand);
      return;
    }

    let project;
    try {
      project = await loadExistingProject(ctx.cwd, home);
    } catch (error) {
      if (error instanceof GliaError && error.code === "NOT_A_GIT_WORKTREE") return;
      return;
    }
    if (project === null) return;

    const startedAt = new Date().toISOString();
    let runRecord: HookRunReport;
    try {
      const report = await runImport(project, ctx.env, {
        harness: null,
        dryRun: false,
        onlyCandidateIds: null,
      });
      runRecord = {
        schemaVersion: 1,
        startedAt,
        finishedAt: new Date().toISOString(),
        outcome: "success" as const,
        summary: report as unknown as Record<string, unknown>,
      };
    } catch (error) {
      const gliaError = toGliaError(error);
      runRecord = {
        schemaVersion: 1,
        startedAt,
        finishedAt: new Date().toISOString(),
        outcome: (gliaError.code === "PROJECT_BUSY" ? "busy" : "error") as "busy" | "error",
        summary: {
          error: { code: gliaError.code, message: gliaError.message, details: gliaError.details },
        },
      };
    }
    // Reporting is diagnostic and best-effort. Its own lock or I/O failure
    // never reclassifies an import that already changed the Store.
    await (ctx.recordRun ?? recordHookRun)(project, runRecord).catch(() => {});
  } catch {
    // A SessionEnd hook is observational automation. It must never delay or
    // fail the Harness because machine-local state is unavailable.
  }
}
