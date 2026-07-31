#!/usr/bin/env bun
/**
 * Compiles the release binary with build provenance injected as
 * compile-time defines — the only place provenance enters the binary.
 * A working tree with uncommitted changes gets a `-dirty` commit suffix:
 * claiming to be commit X while embedding more than commit X is the
 * dishonesty build legibility exists to end.
 *
 * Usage: bun run scripts/build.ts [--outfile <path>]
 */
import { join } from "node:path";

const pkgDir = join(import.meta.dir, "..");

async function git(args: string[]): Promise<string | null> {
  const proc = Bun.spawn(["git", ...args], { cwd: pkgDir, stdout: "pipe", stderr: "ignore" });
  const stdout = await new Response(proc.stdout).text();
  return (await proc.exited) === 0 ? stdout.trim() : null;
}

const outfileFlag = process.argv.indexOf("--outfile");
const outfile =
  outfileFlag !== -1 && process.argv[outfileFlag + 1]
    ? process.argv[outfileFlag + 1]!
    : join("dist", "glia");

const shortCommit = await git(["rev-parse", "--short", "HEAD"]);
const porcelain = await git(["status", "--porcelain"]);
const dirty = porcelain !== null && porcelain.length > 0;
const commit = shortCommit === null ? "unknown" : dirty ? `${shortCommit}-dirty` : shortCommit;
const builtAt = new Date().toISOString().slice(0, 16) + "Z";

const proc = Bun.spawn(
  [
    "bun",
    "build",
    "--compile",
    "--outfile",
    outfile,
    "--define",
    `GLIA_BUILD_COMMIT=${JSON.stringify(commit)}`,
    "--define",
    `GLIA_BUILD_TIME=${JSON.stringify(builtAt)}`,
    "src/cli.ts",
  ],
  { cwd: pkgDir, stdout: "inherit", stderr: "inherit" },
);
const exitCode = await proc.exited;
if (exitCode !== 0) process.exit(exitCode);
console.log(`built ${outfile} (${commit} ${builtAt})`);
