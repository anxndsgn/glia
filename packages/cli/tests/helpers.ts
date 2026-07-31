import { cp, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProject } from "../src/core/project/load.ts";
import { ProjectStore } from "../src/core/store/store.ts";
import { runSync } from "../src/core/store/sync.ts";
import { sessionModule } from "../src/session/module.ts";
import { readDeclaration, writeDeclaration } from "../src/core/config/glia-json.ts";
import type { LoadedProject } from "../src/core/session-module.ts";

export interface TestEnv {
  root: string;
  home: string;
  claudeHome: string;
  codexHome: string;
  worktree: string;
  env: Record<string, string | undefined>;
  cleanup(): Promise<void>;
}

async function gitInit(dir: string): Promise<void> {
  const proc = Bun.spawn(["git", "init", "-q", "--initial-branch=main", dir], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await proc.exited) !== 0) throw new Error(`git init failed for ${dir}`);
}

/** Isolated Project, Harness, and GLIA_HOME fixtures for one test. */
export async function makeTestEnv(): Promise<TestEnv> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "glia-test-")));
  const home = join(root, "glia-home");
  const claudeHome = join(root, "claude-home");
  const codexHome = join(root, "codex-home");
  const worktree = join(root, "work", "my-project");
  await mkdir(worktree, { recursive: true });
  await gitInit(worktree);
  return {
    root,
    home,
    claudeHome,
    codexHome,
    worktree,
    env: { CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome, GLIA_HOME: home },
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function makeSecondWorktree(testEnv: TestEnv, name: string): Promise<string> {
  const dir = join(testEnv.root, "work", name);
  await mkdir(dir, { recursive: true });
  await gitInit(dir);
  return dir;
}

/** A realized local Project with a declaration for multi-replica fixtures. */
export async function initAt(worktree: string, home: string): Promise<LoadedProject> {
  const project = await loadProject(worktree, home, { allowMissingStore: true });
  if (!(await new ProjectStore(project.paths.storeDir).exists())) {
    await runSync(project, { GLIA_HOME: home }, [sessionModule]);
  }
  await writeDeclaration(worktree, project.declaration);
  return project;
}

/** Realize machine-local identity and bindings without contacting a remote. */
export async function installAt(worktree: string, home: string): Promise<void> {
  await loadProject(worktree, home, { allowMissingStore: true });
}

export async function initProject(
  testEnv: TestEnv,
  worktree = testEnv.worktree,
): Promise<LoadedProject> {
  return await initAt(worktree, testEnv.home);
}

/** A bare local Git repository standing in for the Store remote. */
export async function makeBareRemote(testEnv: TestEnv, name = "store-remote"): Promise<string> {
  const dir = join(testEnv.root, `${name}.git`);
  const proc = Bun.spawn(["git", "init", "-q", "--bare", "--initial-branch=main", dir], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await proc.exited) !== 0) throw new Error(`git init --bare failed for ${dir}`);
  return Bun.pathToFileURL(dir).href;
}

export async function setDeclaredRemote(worktree: string, url: string): Promise<void> {
  const declaration = await readDeclaration(worktree);
  if (!declaration) throw new Error(`no glia.json in ${worktree}`);
  declaration.store = { remote: url };
  await writeDeclaration(worktree, declaration);
}

export interface ReplicaEnv {
  home: string;
  worktree: string;
  claudeHome: string;
  codexHome: string;
  env: Record<string, string | undefined>;
}

/**
 * A second machine: its own GLIA_HOME and Harness homes, holding a
 * checkout of the same code repository (glia.json copied across). Pass
 * `shareWorktree` to model two Replicas over one checkout instead.
 */
export async function makeSecondReplica(
  testEnv: TestEnv,
  name: string,
  options: { shareWorktree?: boolean } = {},
): Promise<ReplicaEnv> {
  const home = join(testEnv.root, `glia-home-${name}`);
  const claudeHome = join(testEnv.root, `claude-home-${name}`);
  const codexHome = join(testEnv.root, `codex-home-${name}`);
  let worktree = testEnv.worktree;
  if (options.shareWorktree !== true) {
    worktree = await makeSecondWorktree(testEnv, `replica-${name}`);
    await cp(join(testEnv.worktree, "glia.json"), join(worktree, "glia.json"));
  }
  return {
    home,
    worktree,
    claudeHome,
    codexHome,
    env: { CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome, GLIA_HOME: home },
  };
}

/**
 * A clearly fake Anthropic-format key, assembled at runtime. No file in
 * this repository may contain a token the secret-detection rules can
 * match: coding-agent transcripts capture read source bytes verbatim, so
 * a matchable literal here would flag every Session that touches this
 * repo when that transcript is itself imported.
 */
export const FAKE_KEY = ["sk-ant", "api03-FAKEFAKEFAKEFAKE"].join("-");

export interface ClaudeSessionSpec {
  sessionId: string;
  cwd: string;
  parentSessionId?: string;
  userText?: string;
  readFilePath?: string;
  writtenFilePath?: string;
  extraLines?: unknown[];
}

/** Writes a sanitized Claude Code transcript fixture; never real user history. */
export async function writeClaudeSession(
  claudeHome: string,
  spec: ClaudeSessionSpec,
): Promise<string> {
  const dir = join(claudeHome, "projects", spec.cwd.replaceAll("/", "-"));
  await mkdir(dir, { recursive: true });
  const lines: unknown[] = [
    {
      type: "user",
      uuid: `${spec.sessionId}-u1`,
      sessionId: spec.sessionId,
      cwd: spec.cwd,
      ...(spec.parentSessionId ? { parentSessionId: spec.parentSessionId } : {}),
      timestamp: "2026-07-15T10:00:00Z",
      message: { role: "user", content: spec.userText ?? "please fix the flaky auth token test" },
    },
    {
      type: "assistant",
      uuid: `${spec.sessionId}-a1`,
      sessionId: spec.sessionId,
      cwd: spec.cwd,
      timestamp: "2026-07-15T10:00:05Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: `Mentioning docs/plan.md in prose is not a touch.` },
          {
            type: "tool_use",
            id: "t1",
            name: "Read",
            input: { file_path: spec.readFilePath ?? `${spec.cwd}/tests/auth.test.ts` },
          },
          {
            type: "tool_use",
            id: "t2",
            name: "Bash",
            input: { command: "rm -rf /somewhere/ambiguous" },
          },
        ],
      },
    },
    {
      type: "user",
      uuid: `${spec.sessionId}-u2`,
      sessionId: spec.sessionId,
      cwd: spec.cwd,
      timestamp: "2026-07-15T10:00:09Z",
      toolUseResult: {
        type: "update",
        filePath: spec.writtenFilePath ?? `${spec.cwd}/tests/auth.test.ts`,
      },
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
      },
    },
    ...(spec.extraLines ?? []),
  ];
  const path = join(dir, `${spec.sessionId}.jsonl`);
  await Bun.write(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

export interface CodexSessionSpec {
  sessionId: string;
  cwd: string | null;
  resumedFrom?: string;
  agentText?: string;
  preambleLines?: unknown[];
  mirrorUserMessage?: boolean;
  subagent?: boolean;
  extraLines?: unknown[];
}

/** Writes a sanitized Codex rollout fixture; never real user history. */
export async function writeCodexSession(
  codexHome: string,
  spec: CodexSessionSpec,
): Promise<string> {
  const dir = join(codexHome, "sessions", "2026", "07", "15");
  await mkdir(dir, { recursive: true });
  const meta: Record<string, unknown> = { id: spec.sessionId, timestamp: "2026-07-15T09:00:00Z" };
  if (spec.cwd !== null) meta["cwd"] = spec.cwd;
  if (spec.resumedFrom) meta["resumed_from"] = spec.resumedFrom;
  if (spec.subagent) {
    meta["thread_source"] = "subagent";
    meta["source"] = { subagent: { other: "guardian" } };
  }
  const lines: unknown[] = [
    { timestamp: "2026-07-15T09:00:00Z", type: "session_meta", payload: meta },
    ...(spec.preambleLines ?? []),
    {
      timestamp: "2026-07-15T09:00:02Z",
      type: "response_item",
      payload: {
        type: "message",
        id: "m1",
        role: "user",
        content: [{ type: "input_text", text: "add retry logic to the sync loop" }],
      },
    },
    ...(spec.mirrorUserMessage
      ? [
          {
            timestamp: "2026-07-15T09:00:02Z",
            type: "event_msg",
            payload: {
              type: "user_message",
              message: "add retry logic to the sync loop",
              client_id: "client-1",
            },
          },
        ]
      : []),
    {
      timestamp: "2026-07-15T09:00:04Z",
      type: "event_msg",
      payload: { type: "agent_reasoning", text: "planning the retry strategy" },
    },
    {
      timestamp: "2026-07-15T09:00:05Z",
      type: "event_msg",
      payload: {
        type: "patch_apply_end",
        success: true,
        changes: {
          "src/sync.ts": { type: "update" },
          "src/retry.ts": { type: "add" },
        },
      },
    },
    {
      timestamp: "2026-07-15T09:00:08Z",
      type: "response_item",
      payload: {
        type: "message",
        id: "m2",
        role: "assistant",
        content: [{ type: "output_text", text: spec.agentText ?? "added exponential backoff" }],
      },
    },
    {
      timestamp: "2026-07-15T09:00:09Z",
      type: "wholly_new_event_kind",
      payload: { mystery: true },
    },
    ...(spec.extraLines ?? []),
  ];
  const path = join(dir, `rollout-2026-07-15T09-00-00-${spec.sessionId}.jsonl`);
  await Bun.write(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}
