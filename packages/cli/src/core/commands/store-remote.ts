import { writeDeclaration } from "../config/glia-json.ts";
import type { CommandRunContext } from "../session-module.ts";
import { confirmProceed } from "../output/confirm.ts";
import { GliaError } from "../output/errors.ts";
import type { CommandOutcome } from "../output/result.ts";
import { validateStoreRemoteUrl } from "../store/remote-url.ts";

export interface StoreRemoteSetOptions {
  dryRun: boolean;
  yes: boolean;
}

/**
 * `glia store remote set <url>` writes the optional `store.remote` field
 * of the tracked Project Declaration. Set is repeatable and previews the
 * declaration change like every other explicit declaration edit.
 * Validation is offline; reachability belongs to the first sync.
 */
export async function runStoreRemoteSet(
  ctx: CommandRunContext,
  url: string,
  options: StoreRemoteSetOptions,
): Promise<CommandOutcome> {
  if (options.dryRun && options.yes) {
    throw new GliaError("USAGE", "--dry-run and --yes are mutually exclusive");
  }
  validateStoreRemoteUrl(url);

  const previous = ctx.project.declaration.store.remote ?? null;
  if (previous === url) {
    return {
      json: { remote: url, previous, changed: false, applied: false },
      human: `store.remote is already ${url}. Nothing to do.`,
    };
  }

  const preview =
    `Declare the Store remote for project ${ctx.project.declaration.projectId}:\n` +
    `  store.remote: ${previous ?? "(none)"} -> ${url}\n` +
    `This edits the tracked glia.json only; nothing touches the network until \`glia sync\`.`;

  if (options.dryRun) {
    return {
      json: { remote: url, previous, changed: true, applied: false },
      human: preview,
    };
  }
  if (!options.yes) {
    if (ctx.jsonMode || ctx.inputDisabled) {
      throw new GliaError(
        "INPUT_REQUIRED",
        "store remote set needs confirmation; re-run with --yes to accept or --dry-run to preview",
        {
          remote: url,
          previous,
          nextSteps: [
            `glia store remote set ${url} --dry-run`,
            `glia store remote set ${url} --yes`,
          ],
        },
      );
    }
    if (!(await confirmProceed(`${preview}\n\nContinue?`))) {
      throw new GliaError("CANCELLED", "store remote set cancelled; the declaration is unchanged");
    }
  }

  ctx.project.declaration.store = { ...ctx.project.declaration.store, remote: url };
  await writeDeclaration(ctx.project.worktree, ctx.project.declaration);
  return {
    json: { remote: url, previous, changed: true, applied: true },
    human: `Declared store.remote ${url}. Run \`glia sync\` to synchronize.`,
  };
}

export function runStoreRemoteShow(ctx: CommandRunContext): CommandOutcome {
  const remote = ctx.project.declaration.store.remote ?? null;
  return {
    json: { remote, mode: remote ? "remote" : "local_only" },
    human:
      remote ??
      "(none) — this Project is local_only; declare one with `glia store remote set <url>`",
  };
}
