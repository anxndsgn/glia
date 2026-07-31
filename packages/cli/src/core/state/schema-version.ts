import { GliaError } from "../output/errors.ts";

/**
 * The uniform state-loading contract, read side: every persisted state
 * kind carrying a `schemaVersion` checks it on load. A version greater
 * than this binary supports is `STATE_TOO_NEW` — the state is newer, not
 * corrupt, and the remedy is a newer CLI. An in-range version whose
 * contents are still invalid keeps each kind's invalid-content error.
 *
 * Write side of the same contract: any change to a persisted state
 * kind's format or identifier semantics must bump that kind's
 * `schemaVersion`; without the bump this error can never fire.
 *
 * The SQLite projection is exempt: it is a disposable cache whose remedy
 * for skew in either direction is a transparent rebuild.
 */
export function requireSupportedSchemaVersion(
  kind: string,
  path: string,
  found: unknown,
  supported: number,
): void {
  if (typeof found === "number" && found > supported) {
    throw new GliaError(
      "STATE_TOO_NEW",
      `${kind} at ${path} has schemaVersion ${found}, newer than this Glia supports (${supported}); upgrade or rebuild the Glia CLI`,
      { stateKind: kind, path, foundVersion: found, supportedVersion: supported },
    );
  }
}
