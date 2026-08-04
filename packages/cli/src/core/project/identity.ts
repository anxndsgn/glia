import { identityFile } from "./paths.ts";
import { GliaError } from "../output/errors.ts";
import { writeJsonAtomic } from "../state/atomic-file.ts";
import { requireSupportedSchemaVersion } from "../state/schema-version.ts";

export const IDENTITY_SCHEMA_VERSION = 1;

export interface ReplicaIdentity {
  schemaVersion: number;
  replicaId: string;
}

/**
 * The Replica ID is one random identity per Glia installation. It is never
 * derived from hardware, hostname, user identity, Project identity, Session
 * identity, or Revision content.
 */
export async function readReplicaIdentity(home: string): Promise<ReplicaIdentity | null> {
  const file = Bun.file(identityFile(home));
  if (!(await file.exists())) return null;
  const raw = JSON.parse(await file.text()) as Record<string, unknown>;
  requireSupportedSchemaVersion(
    "Replica identity",
    identityFile(home),
    raw["schemaVersion"],
    IDENTITY_SCHEMA_VERSION,
  );
  if (typeof raw["replicaId"] !== "string" || raw["replicaId"].length === 0) {
    throw new GliaError("INTERNAL", `${identityFile(home)} is malformed`);
  }
  return { schemaVersion: IDENTITY_SCHEMA_VERSION, replicaId: raw["replicaId"] };
}

export async function createReplicaIdentity(home: string): Promise<ReplicaIdentity> {
  const identity: ReplicaIdentity = {
    schemaVersion: IDENTITY_SCHEMA_VERSION,
    replicaId: `rpl_${crypto.randomUUID()}`,
  };
  await writeJsonAtomic(identityFile(home), identity);
  return identity;
}
