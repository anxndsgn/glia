/** The `Continue?` gate ahead of a mutating apply.
 *
 * Core owns it for the same reason it owns the picker: the preview is
 * arbitrary prose, and any of its lines may be wider than the terminal.
 * `@clack/prompts` repaints by counting the frame's logical lines, so one
 * wrapped row shifts every repaint below it — toggling yes/no then leaves
 * a stale duplicate of the toggle on screen. The message is wrapped here
 * so every logical line fits one terminal row.
 */

import {
  DEFAULT_COLUMNS,
  hardWrap,
  MIN_DESCRIPTION_COLUMN,
  viewportOf,
  type Viewport,
} from "./terminal.ts";

/** `◆  ` — the prompt's own prefix ahead of the message's first line. */
const PROMPT_PREFIX = 4;

/** Present `message` with a yes/no toggle. True only on an explicit yes;
 * cancelling reads as no — the caller words its own CANCELLED error. */
export async function confirmProceed(
  message: string,
  viewport: Viewport = viewportOf(),
): Promise<boolean> {
  const { confirm, isCancel } = await import("@clack/prompts");
  const columns = viewport.columns ?? DEFAULT_COLUMNS;
  const answer = await confirm({
    message: hardWrap(message, Math.max(MIN_DESCRIPTION_COLUMN, columns - PROMPT_PREFIX)),
    initialValue: false,
  });
  return !isCancel(answer) && answer === true;
}
