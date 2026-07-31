/** Progress reporting for steps that take visible time.
 *
 * Core's, like the rest of output rendering: a clone, a push or a Store
 * rewrite must never read as a hung terminal, and every module with a slow
 * step needs the same affordance.
 */

/** The part of a run context this needs: whether anything may be drawn. */
export interface ProgressContext {
  jsonMode: boolean;
  inputDisabled: boolean;
}

/**
 * Runs `step` behind a progress indicator. Purely a rendering affordance: the
 * step is unchanged, and nothing is drawn where there is no terminal to draw
 * in — under `--json`, stdout still carries exactly one document.
 */
export async function withProgress<T>(
  ctx: ProgressContext,
  message: string,
  done: (result: T) => string,
  step: () => Promise<T>,
): Promise<T> {
  if (ctx.jsonMode || ctx.inputDisabled) return await step();
  const { spinner } = await import("@clack/prompts");
  const indicator = spinner({ indicator: "timer" });
  indicator.start(message);
  try {
    const result = await step();
    indicator.stop(done(result));
    return result;
  } catch (err) {
    indicator.stop(`${message} — failed`, 2);
    throw err;
  }
}
