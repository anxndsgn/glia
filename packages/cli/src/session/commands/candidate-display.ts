import type { SessionCandidate } from "../adapters/types.ts";

/** Width of the `MM-DD HH:mm` column, for padding rows with no time. */
export const SHORT_TIME_WIDTH = 11;

/** Session time as a local `MM-DD HH:mm`; blank-padded when absent or unreadable. */
export function shortSessionTime(iso: string | null): string {
  if (iso !== null) {
    const time = new Date(iso);
    if (!Number.isNaN(time.getTime())) {
      const pad = (n: number) => String(n).padStart(2, "0");
      return (
        `${pad(time.getMonth() + 1)}-${pad(time.getDate())} ` +
        `${pad(time.getHours())}:${pad(time.getMinutes())}`
      );
    }
  }
  return " ".repeat(SHORT_TIME_WIDTH);
}

/** The Session Label when the source sessions one, else the Source Identity. */
export function candidateDisplayLabel(candidate: SessionCandidate): string {
  return (
    candidate.label ?? `(${candidate.identity.harnessId} ${candidate.identity.sourceSessionId})`
  );
}
