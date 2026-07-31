/**
 * Build provenance is injected at compile time and only there: the build
 * script passes `--define` values for the commit and build time. An
 * uninjected run — a binary built without the injection, or source run
 * directly under the development toolchain — reports an explicit
 * `unknown` for both fields, never a fabricated or stale-cached value:
 * the process has no build identity, and probing git at runtime would
 * report whatever repository the working directory happens to contain.
 */

declare const GLIA_BUILD_COMMIT: string;
declare const GLIA_BUILD_TIME: string;

export const CLI_VERSION = "0.0.1";

export interface BuildInfo {
  version: string;
  /** Short commit hash, `-dirty` suffixed for an uncommitted tree; `unknown` when uninjected. */
  commit: string;
  /** UTC build time to minute precision; `unknown` when uninjected. */
  builtAt: string;
}

export function buildInfo(): BuildInfo {
  return {
    version: CLI_VERSION,
    commit: typeof GLIA_BUILD_COMMIT === "string" ? GLIA_BUILD_COMMIT : "unknown",
    builtAt: typeof GLIA_BUILD_TIME === "string" ? GLIA_BUILD_TIME : "unknown",
  };
}

/** The one-line human rendering shared by `--version` and `status`. */
export function buildIdentityLine(info: BuildInfo): string {
  return `${info.version} (${info.commit} ${info.builtAt})`;
}
