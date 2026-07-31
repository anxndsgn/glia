import { GliaError } from "../output/errors.ts";

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GitOptions {
  /** Extra environment entries (e.g. GIT_INDEX_FILE for aside index work). */
  env?: Record<string, string>;
  /** Bytes fed to stdin (e.g. a raw commit object for hash-object). */
  stdin?: string;
}

/** Runs git with an argument array, never through a shell. */
export async function git(
  args: string[],
  cwd: string,
  options: GitOptions = {},
): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
    env: options.env ? { ...process.env, ...options.env } : undefined,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** Like git(), but returns stdout as exact bytes for content extraction. */
export async function gitBytes(args: string[], cwd: string): Promise<Uint8Array> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new GliaError("GIT_FAILED", `git ${args[0] ?? ""} failed: ${stderr.trim()}`, {
      args,
      exitCode,
    });
  }
  return new Uint8Array(stdout);
}

export async function gitOrThrow(
  args: string[],
  cwd: string,
  options: GitOptions = {},
): Promise<string> {
  const result = await git(args, cwd, options);
  if (result.exitCode !== 0) {
    throw new GliaError(
      "GIT_FAILED",
      `git ${args[0] ?? ""} failed: ${result.stderr.trim() || result.stdout.trim()}`,
      {
        args,
        exitCode: result.exitCode,
      },
    );
  }
  return result.stdout;
}
