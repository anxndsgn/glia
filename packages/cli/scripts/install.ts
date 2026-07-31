#!/usr/bin/env bun
/**
 * Compiles the CLI and installs the resulting binary onto PATH, so a
 * development build can be exercised as `glia` anywhere. The binary keeps
 * the same build provenance the release build injects — including the
 * `-dirty` commit suffix for an unclean working tree.
 *
 * Usage: bun run scripts/install.ts [--prefix <dir>] [--name <bin-name>]
 * Env:   GLIA_INSTALL_DIR overrides the default install directory.
 */
import { constants } from "node:fs";
import { access, chmod, mkdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const pkgDir = join(import.meta.dir, "..");

function flag(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1]! : null;
}

const prefix = resolve(
  flag("prefix") ?? process.env.GLIA_INSTALL_DIR ?? join(homedir(), ".local", "bin"),
);
const binName = flag("name") ?? "glia";
const dest = join(prefix, binName);
const staged = `${dest}.new`;

await mkdir(prefix, { recursive: true });

// Compile through the release build script so provenance stays in one place.
const build = Bun.spawn(["bun", "run", "scripts/build.ts", "--outfile", staged], {
  cwd: pkgDir,
  stdout: "inherit",
  stderr: "inherit",
});
const buildExit = await build.exited;
if (buildExit !== 0) {
  await rm(staged, { force: true });
  process.exit(buildExit);
}

// Rename over the old binary: atomic, and safe while an older copy runs.
await chmod(staged, 0o755);
await rename(staged, dest);

console.log(`installed ${dest}`);

// Installing is not the same as being reachable: an earlier PATH entry —
// typically a stale global shim from another package manager — silently wins
// the `glia` name. Resolve the name the way a shell would and say so.
const entries = (process.env.PATH ?? "")
  .split(delimiter)
  .filter(Boolean)
  .map((e) => resolve(e));

let winner: string | null = null;
for (const entry of entries) {
  const candidate = join(entry, binName);
  if (await isExecutable(candidate)) {
    winner = candidate;
    break;
  }
}

if (winner === null) {
  console.log(`warning: ${prefix} is not on PATH — \`${binName}\` will not resolve`);
} else if (winner !== dest) {
  console.log(`warning: \`${binName}\` resolves to ${winner}, not the binary just installed`);
  console.log(`         remove it, or put ${prefix} earlier on PATH`);
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
