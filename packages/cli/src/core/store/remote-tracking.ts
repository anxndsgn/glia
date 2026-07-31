import { git, gitOrThrow } from "./git.ts";

/** The remote-tracking ref sessioning the last fetched remote state. */
export const REMOTE_TRACKING_REF = "refs/remotes/origin/main";

const REMOTE_TRACKING_URL_KEY = "glia.remoteTrackingUrl";

/**
 * Returns the last fetched head only when it belongs to the currently declared
 * remote. Missing association is deliberately conservative: no evidence is
 * safer than reusing evidence from a previous remote.
 */
export async function readRemoteTrackingHead(
  storeDir: string,
  remote: string,
): Promise<string | null> {
  const associated = await git(["config", "--local", "--get", REMOTE_TRACKING_URL_KEY], storeDir);
  if (associated.exitCode !== 0 || associated.stdout.trim() !== remote) return null;
  const tracking = await git(["rev-parse", "--verify", "--quiet", REMOTE_TRACKING_REF], storeDir);
  return tracking.exitCode === 0 ? tracking.stdout.trim() : null;
}

/**
 * Sessions a fetched head and associates that evidence with its credential-free
 * declaration. The ref moves first, so an interrupted association write can
 * only hide evidence, never attribute stale evidence to another remote.
 */
export async function writeRemoteTrackingHead(
  storeDir: string,
  remote: string,
  head: string,
): Promise<void> {
  await gitOrThrow(["update-ref", REMOTE_TRACKING_REF, head], storeDir);
  await gitOrThrow(["config", "--local", REMOTE_TRACKING_URL_KEY, remote], storeDir);
}
