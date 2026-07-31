import type { HarnessId } from "../../core/harnesses/ids.ts";

export interface SourceIdentity {
  harnessId: HarnessId;
  sourceSessionId: string;
}

/**
 * The Session ID is a deterministic opaque encoding of the Source Identity.
 * It does not depend on file paths or Session contents. The Candidate ID
 * uses the same encoding, so it is stable across discovery runs. The
 * `ses_` type prefix makes the ID self-describing in output and scripts;
 * revision digests stay bare because they are digests, not identifiers.
 */
export function sessionIdOf(identity: SourceIdentity): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(`${identity.harnessId}\n${identity.sourceSessionId}`);
  return `ses_${hasher.digest("hex").slice(0, 32)}`;
}

export const candidateIdOf = sessionIdOf;
