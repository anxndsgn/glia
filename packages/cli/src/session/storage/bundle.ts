import type { BundleFile, BundleManifest, CapturedBundle } from "../adapters/types.ts";

export const MANIFEST_SCHEMA_VERSION = 1;

export function manifestOf(captured: CapturedBundle): BundleManifest {
  const files = [...captured.files].sort((a, b) => a.path.localeCompare(b.path));
  return { schemaVersion: MANIFEST_SCHEMA_VERSION, files };
}

/**
 * A Session Revision is identified by a SHA-256 digest of its complete
 * Source Bundle: the digest of the canonical, sorted manifest entries.
 */
export function bundleDigest(manifest: BundleManifest): string {
  const canonical = manifest.files
    .map((f: BundleFile) => `${f.path}\n${f.size}\n${f.sha256}`)
    .join("\n---\n");
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(canonical);
  return hasher.digest("hex");
}
