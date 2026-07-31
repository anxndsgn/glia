import { dirname, join } from "node:path";
import { mkdir, readdir } from "node:fs/promises";
import { GliaError } from "../../core/output/errors.ts";
import type {
  BundleFile,
  CapturedBundle,
  FileTouch,
  SessionCandidate,
  StagingArea,
} from "./types.ts";

/** Discovery probes Harness roots that legitimately may not exist. */
export async function directoryExists(path: string): Promise<boolean> {
  try {
    await readdir(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The one File Touch normalization rule, shared by every adapter: a path is
 * normalized only when the source states it absolutely. It must not diverge
 * per Harness.
 */
export function touch(operation: FileTouch["operation"], sourcePath: string): FileTouch {
  return {
    operation,
    sourcePath,
    normalizedPath: sourcePath.startsWith("/") ? sourcePath : null,
  };
}

export async function sha256File(path: string): Promise<{ sha256: string; size: number }> {
  const file = Bun.file(path);
  const bytes = await file.arrayBuffer();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return { sha256: hasher.digest("hex"), size: bytes.byteLength };
}

/**
 * Copies a candidate's allowlisted source files into staging byte-for-byte.
 * Adapters never follow arbitrary paths or symlinks beyond the allowlist.
 * A missing required artifact is SOURCE_INCOMPLETE, never a partial Session.
 */
export async function captureAllowlisted(
  candidate: SessionCandidate,
  staging: StagingArea,
): Promise<CapturedBundle> {
  const files: BundleFile[] = [];
  for (const ref of candidate.sourceFiles) {
    const source = Bun.file(ref.absolutePath);
    if (!(await source.exists())) {
      throw new GliaError(
        "SOURCE_INCOMPLETE",
        `required source artifact is missing: ${ref.absolutePath}`,
        {
          candidateId: candidate.candidateId,
          path: ref.absolutePath,
        },
      );
    }
    const destination = join(staging.dir, ref.bundlePath);
    await mkdir(dirname(destination), { recursive: true });
    await Bun.write(destination, source);
    const { sha256, size } = await sha256File(destination);
    files.push({ path: ref.bundlePath, size, mediaType: ref.mediaType, sha256 });
  }
  return { files };
}

/** Re-hashes the live source files and compares them to a captured manifest. */
export async function sourcesMatchCapture(
  candidate: SessionCandidate,
  captured: CapturedBundle,
): Promise<boolean> {
  for (const ref of candidate.sourceFiles) {
    const capturedFile = captured.files.find((f) => f.path === ref.bundlePath);
    if (!capturedFile) return false;
    if (!(await Bun.file(ref.absolutePath).exists())) return false;
    const { sha256 } = await sha256File(ref.absolutePath);
    if (sha256 !== capturedFile.sha256) return false;
  }
  return true;
}
