import { join, relative } from "node:path";
import { lstat, readdir } from "node:fs/promises";

export interface ContentTreeFile {
  path: string;
  executable: boolean;
  bytes: number;
}

function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Collects a deterministic opaque file tree. The owning domain supplies
 * the typed error because invalid-unit vocabulary belongs to the module. */
export async function collectContentTree(
  root: string,
  symbolicLinkError: (path: string) => Error,
): Promise<ContentTreeFile[]> {
  const files: ContentTreeFile[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => comparePaths(a.name, b.name))) {
      const full = join(dir, entry.name);
      const path = relative(root, full).replaceAll("\\", "/");
      if (entry.isSymbolicLink()) throw symbolicLinkError(path);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const stat = await lstat(full);
        files.push({
          path,
          executable: (stat.mode & 0o100) !== 0,
          bytes: stat.size,
        });
      }
    }
  }
  await walk(root);
  return files.sort((a, b) => comparePaths(a.path, b.path));
}

export interface ContentTreeAnalysis {
  digest: string;
  signatures: Map<string, string>;
}

/** Reads each file once while producing the canonical tree digest and
 * per-file signatures. Callers may inspect those same bytes for
 * category-specific acceptance gates. */
export async function analyzeContentTree(
  files: { path: string; executable: boolean; source: string }[],
  inspect?: (file: { path: string; bytes: Uint8Array }) => void,
): Promise<ContentTreeAnalysis> {
  const hasher = new Bun.CryptoHasher("sha256");
  const signatures = new Map<string, string>();
  for (const file of [...files].sort((a, b) => comparePaths(a.path, b.path))) {
    const bytes = await Bun.file(file.source).bytes();
    hasher.update(`${file.path}\0${file.executable ? "100755" : "100644"}\0${bytes.byteLength}\0`);
    hasher.update(bytes);
    const fileDigest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    signatures.set(file.path, `${file.executable ? "x" : "-"}:${fileDigest}`);
    inspect?.({ path: file.path, bytes });
  }
  return { digest: `sha256:${hasher.digest("hex")}`, signatures };
}

/** The canonical digest shared by every content-addressed opaque tree. */
export async function computeContentTreeDigest(
  files: { path: string; executable: boolean; source: string }[],
): Promise<string> {
  return (await analyzeContentTree(files)).digest;
}
