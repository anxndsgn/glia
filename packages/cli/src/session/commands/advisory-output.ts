import type { CommandOutcome } from "../../core/output/result.ts";
import type { CommandRunContext } from "../../core/session-module.ts";
import {
  renderWithheldBanner,
  storedWithheldAdvisory,
  type SessionAdvisory,
} from "../domain/advisories.ts";

type WithheldAdvisory = Extract<SessionAdvisory, { kind: "withheld" }>;

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Adds cheap, persisted withheld facts without running Harness discovery. */
export async function readSessionOpeningAdvisory(
  ctx: CommandRunContext,
): Promise<WithheldAdvisory | null> {
  // Advisories are additive diagnostics. An unreadable or newer disposable
  // discovery state must not block an otherwise valid command.
  return await storedWithheldAdvisory(ctx.project).catch(() => null);
}

interface DecorateOptions {
  openingRendered?: boolean;
}

/** Adds an advisory snapshot to the completed outcome. */
export async function decorateSessionOutcome(
  ctx: CommandRunContext,
  outcome: CommandOutcome,
  snapshot?: WithheldAdvisory | null,
  options: DecorateOptions = {},
): Promise<CommandOutcome> {
  const withheld = snapshot === undefined ? await readSessionOpeningAdvisory(ctx) : snapshot;
  if (withheld === null) return outcome;

  const json = asObject(outcome.json);
  const existing = Array.isArray(json?.["advisories"])
    ? (json!["advisories"] as SessionAdvisory[])
    : [];
  const advisories = [...existing.filter((advisory) => advisory.kind !== "withheld"), withheld];
  const banner = renderWithheldBanner(withheld);
  let human = outcome.human;
  if (!ctx.inputDisabled) {
    // Search's zero-result explanation may already carry the same line at
    // the end; move it to the opening banner instead of printing it twice.
    human = human
      .split("\n")
      .filter((line) => line !== banner)
      .join("\n");
    if (options.openingRendered !== true) {
      human = human.length > 0 ? `${banner}\n${human}` : banner;
    }
  }
  return {
    json: json === null ? outcome.json : { ...json, advisories },
    human,
  };
}

/** Renders the human warning before any spinner or prompt, then runs the command. */
export async function runWithSessionAdvisory(
  ctx: CommandRunContext,
  run: () => Promise<CommandOutcome> | CommandOutcome,
  write: (text: string) => void,
): Promise<CommandOutcome> {
  const snapshot = await readSessionOpeningAdvisory(ctx);
  const openingRendered = snapshot !== null && !ctx.inputDisabled;
  if (openingRendered) write(`${renderWithheldBanner(snapshot)}\n`);
  const outcome = await run();
  // Human output keeps the opening snapshot already rendered before any
  // prompt or spinner. Machine output reflects the command's completed state
  // so a successful accept/ignore does not keep reporting resolved debt.
  const completed = await readSessionOpeningAdvisory(ctx);
  return await decorateSessionOutcome(ctx, outcome, completed, { openingRendered });
}
