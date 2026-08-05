import { GliaError } from "./errors.ts";

export const JSON_FORMAT_VERSION = 1;

/** A command handler's result: one machine payload, one concise human text. */
export interface CommandOutcome {
  json: unknown;
  human: string;
}

export interface RenderTarget {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export function renderSuccess(
  command: string,
  outcome: CommandOutcome,
  jsonMode: boolean,
  target: RenderTarget,
): void {
  if (jsonMode) {
    target.stdout(
      JSON.stringify({
        formatVersion: JSON_FORMAT_VERSION,
        command,
        ok: true,
        result: outcome.json,
      }) + "\n",
    );
    return;
  }
  if (outcome.human.length > 0)
    target.stdout(outcome.human.endsWith("\n") ? outcome.human : outcome.human + "\n");
}

export function renderError(
  command: string,
  error: GliaError,
  jsonMode: boolean,
  target: RenderTarget,
): void {
  if (jsonMode) {
    target.stdout(
      JSON.stringify({
        formatVersion: JSON_FORMAT_VERSION,
        command,
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
          nextSteps: error.nextSteps,
        },
      }) + "\n",
    );
    return;
  }
  const steps = error.nextSteps.map((step) => `  next: ${step}`);
  target.stderr([`error (${error.code}): ${error.message}`, ...steps].join("\n") + "\n");
}
