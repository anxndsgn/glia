import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { join } from "node:path";
import { mkdir, readdir, rm } from "node:fs/promises";
import { sha256File } from "../../src/session/adapters/capture.ts";
import { DELETION_LIMITATION } from "../../src/core/store/deletion.ts";
import { sessionIdOf } from "../../src/session/domain/identity.ts";
import { hookLivenessFile } from "../../src/core/project/paths.ts";
import {
  FAKE_KEY,
  makeBareRemote,
  makeSecondReplica,
  makeSecondWorktree,
  makeTestEnv,
  writeClaudeSession,
  type ReplicaEnv,
  type TestEnv,
} from "../helpers.ts";

setDefaultTimeout(120_000);

const pkgDir = join(import.meta.dir, "..", "..");
const binary = join(pkgDir, "dist", "glia-blackbox-test");

interface CliRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

let env: TestEnv;
beforeEach(async () => {
  env = await makeTestEnv();
});
afterEach(async () => {
  await env.cleanup();
});

/** Black-box runs spawn the compiled Glia binary under isolated fixtures. */
async function gliaAt(
  machine: { worktree: string; env: Record<string, string | undefined> },
  args: string[],
  cwd?: string,
): Promise<CliRun> {
  const proc = Bun.spawn([binary, ...args], {
    cwd: cwd ?? machine.worktree,
    env: { ...process.env, ...machine.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function glia(args: string[], cwd?: string): Promise<CliRun> {
  return await gliaAt(env, args, cwd);
}

beforeAll(async () => {
  // The release build path, provenance injection included, is what ships;
  // black-box tests compile through it.
  const proc = Bun.spawn(["bun", "run", "scripts/build.ts", "--outfile", binary], {
    cwd: pkgDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await proc.exited) !== 0) {
    throw new Error(`build script failed: ${await new Response(proc.stderr).text()}`);
  }
});

afterAll(async () => {
  await rm(binary, { force: true });
});

describe("compiled CLI contract", () => {
  test("project inventory is machine-scoped and lifecycle verbs keep the JSON contract", async () => {
    const outside = join(env.root, "outside");
    await mkdir(outside);
    const empty = await glia(["--json", "project", "list"], outside);
    expect(empty.exitCode).toBe(0);
    expect(JSON.parse(empty.stdout)).toMatchObject({
      formatVersion: 1,
      command: "project.list",
      ok: true,
      result: { projects: [] },
    });

    const status = await glia(["--json", "status"]);
    const projectId = (JSON.parse(status.stdout) as { result: { projectId: string } }).result
      .projectId;
    const retired = await makeSecondWorktree(env, "retired");
    const bound = await glia(["--json", "project", "bind", projectId, retired, "--alias"]);
    expect(bound.exitCode).toBe(0);
    expect(JSON.parse(bound.stdout)).toMatchObject({
      command: "project.bind",
      ok: true,
      result: { projectId, path: retired, kind: "alias", changed: true },
    });

    const forgotten = await glia(["--json", "project", "forget", retired], outside);
    expect(forgotten.exitCode).toBe(0);
    expect(JSON.parse(forgotten.stdout)).toMatchObject({
      command: "project.forget",
      ok: true,
      result: { projectId, path: retired, removedFrom: "alias" },
    });
    expect(bound.stdout.trim().split("\n")).toHaveLength(1);
    expect(forgotten.stdout.trim().split("\n")).toHaveLength(1);
  });

  test("--json with hook mode is an explicit usage error", async () => {
    env.env["GLIA_HOOK_FOREGROUND"] = "1";
    const run = await glia(["--json", "import", "--hook"]);
    expect(run.exitCode).not.toBe(0);
    const doc = JSON.parse(run.stdout) as { ok: boolean; error: { code: string } };
    expect(doc.ok).toBeFalse();
    expect(doc.error.code).toBe("USAGE");
    expect(run.stderr).toBe("");
  });

  test("foreground hook mode is silent and does not opt in an unbound worktree", async () => {
    env.env["GLIA_HOOK_FOREGROUND"] = "1";
    const run = await glia(["import", "--hook"]);
    expect(run).toMatchObject({ exitCode: 0, stdout: "", stderr: "" });
    expect(await Bun.file(hookLivenessFile(env.home)).exists()).toBeTrue();
    expect(await readdir(env.home)).not.toContain("projects");
  });

  test("detached hook returns promptly, stays silent, and imports in the background", async () => {
    // Any ordinary command is the explicit opt-in that realizes the Binding.
    expect((await glia(["status"])).exitCode).toBe(0);
    await writeClaudeSession(env.claudeHome, {
      sessionId: "hook-blackbox",
      cwd: env.worktree,
      userText: "BACKGROUNDHOOKPROBE searchable after detach",
    });

    const started = performance.now();
    const hook = await glia(["import", "--hook"]);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(hook).toMatchObject({ exitCode: 0, stdout: "", stderr: "" });

    let matches = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const search = await glia(["--json", "search", "BACKGROUNDHOOKPROBE"]);
      if (search.exitCode === 0) {
        matches = (JSON.parse(search.stdout) as { result: { totalMatches: number } }).result
          .totalMatches;
        if (matches > 0) break;
      }
      await Bun.sleep(25);
    }
    expect(matches).toBeGreaterThan(0);
  });

  test("default output is concise human text with no serialized JSON", async () => {
    await writeClaudeSession(env.claudeHome, { sessionId: "aaaa-1", cwd: env.worktree });
    const run = await glia(["import"]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("Accepted 1 revision(s)");
    for (const line of run.stdout.trim().split("\n")) {
      expect(() => JSON.parse(line)).toThrow();
    }
  });

  test("--json emits exactly one versioned document on stdout and nothing else", async () => {
    await writeClaudeSession(env.claudeHome, { sessionId: "aaaa-1", cwd: env.worktree });
    const run = await glia(["--json", "import"]);
    expect(run.exitCode).toBe(0);
    const doc = JSON.parse(run.stdout) as {
      formatVersion: number;
      command: string;
      ok: boolean;
      result: { accepted: unknown[] };
    };
    expect(doc.formatVersion).toBe(1);
    expect(doc.command).toBe("import");
    expect(doc.ok).toBeTrue();
    expect(doc.result.accepted).toHaveLength(1);
    expect(run.stdout.trim().split("\n")).toHaveLength(1);
  });

  test("JSON errors use the same single-document stdout contract with non-zero exit", async () => {
    const run = await glia(["--json", "show", "ses_00000000000000000000000000000000"]);
    expect(run.exitCode).not.toBe(0);
    const doc = JSON.parse(run.stdout) as { ok: boolean; error: { code: string } };
    expect(doc.ok).toBeFalse();
    expect(doc.error.code).toBe("NOT_FOUND");
  });

  test("session view honors the CLI output contract: human default, one JSON document, USAGE exit", async () => {
    await writeClaudeSession(env.claudeHome, { sessionId: "aaaa-1", cwd: env.worktree });
    const imported = await glia(["--json", "import"]);
    const sessionId = (
      JSON.parse(imported.stdout) as { result: { accepted: { sessionId: string }[] } }
    ).result.accepted[0]!.sessionId;

    // Human default: header plus one line per event, no locators, no JSON.
    const human = await glia(["view", sessionId]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain(`${sessionId}  claude-code`);
    expect(human.stdout).toContain("source: source/transcript.jsonl");
    expect(human.stdout).not.toContain(":line:");
    for (const line of human.stdout.trim().split("\n")) {
      expect(() => JSON.parse(line)).toThrow();
    }

    // Piping is the default spawn mode here, and it never implied JSON.
    const json = await glia(["--json", "view", sessionId]);
    expect(json.exitCode).toBe(0);
    expect(json.stdout.trim().split("\n")).toHaveLength(1);
    const doc = JSON.parse(json.stdout) as {
      formatVersion: number;
      command: string;
      ok: boolean;
      result: { session: { sourceFiles: string[] }; events: unknown[]; totalEvents: number };
    };
    expect(doc.formatVersion).toBe(1);
    expect(doc.command).toBe("view");
    expect(doc.ok).toBeTrue();
    expect(doc.result.session.sourceFiles).toEqual(["source/transcript.jsonl"]);
    expect(doc.result.totalEvents).toBe(3);

    // Detail mode is a distinct document shape: one event, whole.
    const detail = await glia(["--json", "view", sessionId, "--seq", "1"]);
    const detailDoc = JSON.parse(detail.stdout) as {
      result: { event: { seq: number; text: string }; events?: unknown };
    };
    expect(detailDoc.result.event.seq).toBe(1);
    expect(detailDoc.result.events).toBeUndefined();

    // Option misuse is a typed USAGE error with non-zero exit.
    const misuse = await glia(["view", sessionId, "--all", "--limit", "3"]);
    expect(misuse.exitCode).not.toBe(0);
    expect(misuse.stderr).toContain("USAGE");
  });

  test("session archive previews before writing, filters collections, and emits one JSON document", async () => {
    await writeClaudeSession(env.claudeHome, {
      sessionId: "archive-cli",
      cwd: env.worktree,
      userText: "archive cli needle",
    });
    const imported = await glia(["--json", "import"]);
    const sessionId = (
      JSON.parse(imported.stdout) as { result: { accepted: { sessionId: string }[] } }
    ).result.accepted[0]!.sessionId;

    const required = await glia(["--json", "archive", sessionId]);
    expect(required.exitCode).not.toBe(0);
    expect((JSON.parse(required.stdout) as { error: { code: string } }).error.code).toBe(
      "INPUT_REQUIRED",
    );
    const stillVisible = await glia(["--json", "list"]);
    expect(
      (JSON.parse(stillVisible.stdout) as { result: { totalSessions: number } }).result
        .totalSessions,
    ).toBe(1);

    const preview = await glia(["archive", sessionId, "--dry-run"]);
    expect(preview.exitCode).toBe(0);
    expect(preview.stdout).toContain("does not remove evidence");

    const archived = await glia(["--json", "archive", sessionId, "--yes"]);
    expect(archived.exitCode).toBe(0);
    expect(archived.stdout.trim().split("\n")).toHaveLength(1);
    const archiveDoc = JSON.parse(archived.stdout) as {
      formatVersion: number;
      command: string;
      result: { applied: boolean; nextState: string };
    };
    expect(archiveDoc.formatVersion).toBe(1);
    expect(archiveDoc.command).toBe("archive");
    expect(archiveDoc.result).toMatchObject({ applied: true, nextState: "archived" });

    const hidden = await glia(["--json", "search", "archive cli"]);
    expect(
      (JSON.parse(hidden.stdout) as { result: { totalMatches: number } }).result.totalMatches,
    ).toBe(0);
    const included = await glia(["--json", "search", "archive cli", "--include-archived"]);
    const match = (
      JSON.parse(included.stdout) as {
        result: { matches: { archiveState: string }[] };
      }
    ).result.matches[0];
    expect(match?.archiveState).toBe("archived");

    const restored = await glia(["--json", "unarchive", sessionId, "--yes"]);
    expect(restored.exitCode).toBe(0);
    expect(
      (JSON.parse(restored.stdout) as { result: { nextState: string } }).result.nextState,
    ).toBe("active");
  });

  test("fork twins get family notes on list and cross-Session collapse with honest counts on search", async () => {
    const originPath = await writeClaudeSession(env.claudeHome, {
      sessionId: "fork-cli",
      cwd: env.worktree,
      userText: "FORKCLIPROBE shared prefix",
    });
    // A desktop-fork twin: the copied file keeps event identifiers,
    // timestamps, and messages; only the envelope session id changes.
    const copied = (await Bun.file(originPath).text())
      .trim()
      .split("\n")
      .map((line) => {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        parsed["sessionId"] = "fork-cli-twin";
        return JSON.stringify(parsed);
      });
    await Bun.write(
      join(env.claudeHome, "projects", env.worktree.replaceAll("/", "-"), "fork-cli-twin.jsonl"),
      copied.join("\n") + "\n",
    );
    await glia(["import"]);

    const listed = await glia(["list"]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain("(family of 2)");
    expect(listed.stdout).toContain("(family: ses_");

    const search = await glia(["--json", "search", "FORKCLIPROBE"]);
    expect(search.exitCode).toBe(0);
    const doc = JSON.parse(search.stdout) as {
      result: {
        totalMatches: number;
        familyCollapsedMatches: number;
        matches: { alsoIn?: string[] }[];
      };
    };
    expect(doc.result.totalMatches).toBe(1);
    expect(doc.result.familyCollapsedMatches).toBe(1);
    expect(doc.result.matches[0]!.alsoIn).toHaveLength(1);
  });

  test("subagent facts reach the JSON documents of show, view, and search", async () => {
    await writeClaudeSession(env.claudeHome, {
      sessionId: "sub-cli",
      cwd: env.worktree,
      userText: "the human's own request",
      subagents: [{ agentId: "alpha-1111", spawnPrompt: "SUBCLIPROBE search the repo" }],
    });
    await glia(["import"]);
    const sessionId = sessionIdOf({ harnessId: "claude-code", sourceSessionId: "sub-cli" });

    const shown = await glia(["--json", "show", sessionId]);
    expect(shown.exitCode).toBe(0);
    const showDoc = JSON.parse(shown.stdout) as {
      result: { session: { subagent: Record<string, unknown> } };
    };
    expect(showDoc.result.session.subagent).toMatchObject({
      kind: null,
      transcriptCount: 1,
      spawnedSessionIds: [],
    });

    const viewed = await glia(["--json", "view", sessionId, "--all"]);
    const viewDoc = JSON.parse(viewed.stdout) as {
      result: { session: { sourceFiles: string[]; subagent: Record<string, unknown> } };
    };
    expect(viewDoc.result.session.sourceFiles).toContain("source/subagents/agent-alpha-1111.jsonl");
    expect(viewDoc.result.session.subagent).toMatchObject({ transcriptCount: 1 });

    // The provenance slice is part of the documented --filter vocabulary.
    const search = await glia(["--json", "search", "SUBCLIPROBE", "--filter", "subagent"]);
    expect(search.exitCode).toBe(0);
    const searchDoc = JSON.parse(search.stdout) as {
      result: { totalMatches: number; matches: { locator: { sourceFile: string } }[] };
    };
    expect(searchDoc.result.totalMatches).toBe(1);
    expect(searchDoc.result.matches[0]!.locator.sourceFile).toBe(
      "source/subagents/agent-alpha-1111.jsonl",
    );
  });

  test("source bundle bytes and hashes survive store acceptance and export exactly", async () => {
    const sourcePath = await writeClaudeSession(env.claudeHome, {
      sessionId: "aaaa-1",
      cwd: env.worktree,
    });
    const sourceHash = await sha256File(sourcePath);

    const imported = await glia(["--json", "import"]);
    const sessionId = (
      JSON.parse(imported.stdout) as { result: { accepted: { sessionId: string }[] } }
    ).result.accepted[0]!.sessionId;

    const outDir = join(env.root, "exported");
    const exported = await glia(["export", sessionId, "--output", outDir]);
    expect(exported.exitCode).toBe(0);
    const exportedHash = await sha256File(join(outDir, "source", "transcript.jsonl"));
    expect(exportedHash.sha256).toBe(sourceHash.sha256);

    const doc = JSON.parse(await Bun.file(join(outDir, "session.json")).text()) as {
      formatVersion: number;
      files: { sha256: string }[];
    };
    expect(doc.formatVersion).toBe(1);
    expect(doc.files[0]!.sha256).toBe(sourceHash.sha256);

    const again = await glia(["export", sessionId, "--output", outDir]);
    expect(again.exitCode).not.toBe(0);
    expect(again.stderr).toContain("DESTINATION_NOT_EMPTY");
  });

  test("status is read-only and reports store mode, roots, and projection freshness", async () => {
    const run = await glia(["status"]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("local_only");
    expect(run.stdout).toContain(env.worktree);
  });

  test("sync without a remote fails fast and store remote set validates offline with confirmation", async () => {
    const noRemote = await glia(["--json", "sync"]);
    expect(noRemote.exitCode).not.toBe(0);
    const noRemoteDoc = JSON.parse(noRemote.stdout) as { error: { code: string; message: string } };
    expect(noRemoteDoc.error.code).toBe("NO_STORE_REMOTE");
    expect(noRemoteDoc.error.message).toContain("glia store remote set");

    const bad = await glia([
      "store",
      "remote",
      "set",
      ["https", "://user:secret@example.com/store.git"].join(""),
      "--yes",
    ]);
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr).toContain("USAGE");

    const unconfirmed = await glia(["store", "remote", "set", "/tmp/store.git"]);
    expect(unconfirmed.exitCode).not.toBe(0);
    expect(unconfirmed.stderr).toContain("INPUT_REQUIRED");
    expect(await Bun.file(join(env.worktree, "glia.json")).exists()).toBeFalse();

    const applied = await glia(["store", "remote", "set", "/tmp/store.git", "--yes"]);
    expect(applied.exitCode).toBe(0);
    const show = await glia(["store", "remote", "show"]);
    expect(show.stdout).toContain("/tmp/store.git");
  });

  test("Project-level Store commands carry persisted withheld advisories", async () => {
    await writeClaudeSession(env.claudeHome, {
      sessionId: "top-level-advisory",
      cwd: env.worktree,
      extraLines: [
        {
          type: "user",
          sessionId: "top-level-advisory",
          cwd: env.worktree,
          message: { role: "user", content: `credential ${FAKE_KEY}` },
        },
      ],
    });
    expect((await glia(["--json", "import"])).exitCode).toBe(0);

    for (const args of [
      ["--json", "store", "remote", "show"],
      ["--json", "store", "remote", "set", "/tmp/store.git", "--dry-run"],
      ["--json", "hook", "install"],
    ]) {
      const run = await glia(args);
      expect(run.exitCode).toBe(0);
      const doc = JSON.parse(run.stdout) as {
        result: { advisories: { kind: string; count: number }[] };
      };
      expect(doc.result.advisories).toContainEqual(
        expect.objectContaining({ kind: "withheld", count: 1 }),
      );
    }
  });

  test("session delete confirms before mutating, states the limitation verbatim, and leaves a queryable tombstone", async () => {
    await writeClaudeSession(env.claudeHome, { sessionId: "cli-del-1", cwd: env.worktree });
    await glia(["import"]);
    const sessionId = sessionIdOf({ harnessId: "claude-code", sourceSessionId: "cli-del-1" });

    // --json without --yes and non-TTY without --yes are both
    // INPUT_REQUIRED, reported before any Store mutation.
    const jsonBlocked = await glia(["--json", "delete", sessionId]);
    expect(jsonBlocked.exitCode).not.toBe(0);
    const blockedDoc = JSON.parse(jsonBlocked.stdout) as { ok: boolean; error: { code: string } };
    expect(blockedDoc.error.code).toBe("INPUT_REQUIRED");
    const humanBlocked = await glia(["delete", sessionId]);
    expect(humanBlocked.exitCode).not.toBe(0);
    expect(humanBlocked.stderr).toContain("INPUT_REQUIRED");
    const still = await glia(["--json", "show", sessionId]);
    expect((JSON.parse(still.stdout) as { ok: boolean }).ok).toBeTrue();

    const deleted = await glia(["--json", "delete", sessionId, "--yes"]);
    expect(deleted.exitCode).toBe(0);
    const doc = JSON.parse(deleted.stdout) as {
      ok: boolean;
      result: { epoch: number; limitation: string };
    };
    expect(doc.ok).toBeTrue();
    expect(doc.result.epoch).toBe(1);
    expect(doc.result.limitation).toBe(DELETION_LIMITATION);

    // The human form of a second deletion also carries the statement.
    await writeClaudeSession(env.claudeHome, { sessionId: "cli-del-2", cwd: env.worktree });
    await glia(["import"]);
    const second = sessionIdOf({ harnessId: "claude-code", sourceSessionId: "cli-del-2" });
    const human = await glia(["delete", second, "--yes"]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain(DELETION_LIMITATION);

    // The tombstone answers: ledger listing, SESSION_DELETED from show,
    // SESSION_DELETED from a repeated delete, NOT_FOUND for a stranger.
    const tombstones = await glia(["tombstones"]);
    expect(tombstones.exitCode).toBe(0);
    expect(tombstones.stdout).toContain(sessionId);
    const shown = await glia(["--json", "show", sessionId]);
    expect(shown.exitCode).not.toBe(0);
    expect((JSON.parse(shown.stdout) as { error: { code: string } }).error.code).toBe(
      "SESSION_DELETED",
    );
    const repeat = await glia(["--json", "delete", sessionId, "--yes"]);
    expect((JSON.parse(repeat.stdout) as { error: { code: string } }).error.code).toBe(
      "SESSION_DELETED",
    );
    const stranger = await glia([
      "--json",
      "delete",
      "ses_00000000000000000000000000000000",
      "--yes",
    ]);
    expect((JSON.parse(stranger.stdout) as { error: { code: string } }).error.code).toBe(
      "NOT_FOUND",
    );

    // The import skips the tombstoned identity without failing, and the
    // re-acceptance override needs --yes in JSON mode.
    const reimport = await glia(["--json", "import"]);
    const reimportDoc = JSON.parse(reimport.stdout) as {
      result: { accepted: unknown[]; tombstoned: unknown[] };
    };
    expect(reimportDoc.result.accepted).toHaveLength(0);
    expect(reimportDoc.result.tombstoned).toHaveLength(2);
    const readmitBlocked = await glia(["--json", "accept", sessionId]);
    expect((JSON.parse(readmitBlocked.stdout) as { error: { code: string } }).error.code).toBe(
      "INPUT_REQUIRED",
    );
    const readmitted = await glia(["--json", "accept", sessionId, "--yes"]);
    const readmittedDoc = JSON.parse(readmitted.stdout) as {
      ok: boolean;
      result: { accepted: { sessionId: string }[] };
    };
    expect(readmittedDoc.ok).toBeTrue();
    expect(readmittedDoc.result.accepted[0]!.sessionId).toBe(sessionId);
  });

  test("--version reports the injected build commit and build time in both modes", async () => {
    // The binary compiled through scripts/build.ts carries provenance: a
    // A fresh repository without a first commit reports explicit unknown provenance.
    const identity =
      /^0\.0\.1 \((unknown|[0-9a-f]{4,40}(-dirty)?) \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z\)$/;
    const human = await glia(["--version"], env.root);
    expect(human.exitCode).toBe(0);
    expect(human.stdout.trim()).toMatch(identity);

    const json = await glia(["--json", "--version"], env.root);
    expect(json.exitCode).toBe(0);
    const doc = JSON.parse(json.stdout) as {
      ok: boolean;
      result: { version: string; commit: string; builtAt: string };
    };
    expect(doc.ok).toBeTrue();
    expect(doc.result.version).toBe("0.0.1");
    expect(doc.result.commit).toMatch(/^(unknown|[0-9a-f]{4,40}(-dirty)?)$/);
    expect(doc.result.builtAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/);
    expect(json.stdout.trim().split("\n")).toHaveLength(1);
  });

  test("glia status surfaces the same build identity", async () => {
    const run = await glia(["status"]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toMatch(/ {2}glia: 0\.0\.1 \((unknown|[0-9a-f]{4,40}(-dirty)?) /);

    const json = await glia(["--json", "status"]);
    const doc = JSON.parse(json.stdout) as {
      result: { build: { version: string; commit: string; builtAt: string } };
    };
    expect(doc.result.build.version).toBe("0.0.1");
    expect(doc.result.build.commit).toMatch(/^(unknown|[0-9a-f]{4,40}(-dirty)?)$/);
  });

  test("skill install writes the embedded SKILL.md from the compiled binary", async () => {
    const home = join(env.root, "skill-home");
    await mkdir(home, { recursive: true });
    const run = await gliaAt({ worktree: env.worktree, env: { ...env.env, HOME: home } }, [
      "--json",
      "skill",
      "install",
    ]);
    expect(run.exitCode).toBe(0);
    const doc = JSON.parse(run.stdout) as {
      ok: boolean;
      result: { skill: string; version: string; results: { path: string; status: string }[] };
    };
    expect(doc.ok).toBeTrue();
    expect(doc.result.skill).toBe("glia");
    expect(doc.result.results.map((r) => r.status)).toEqual(["created", "created"]);
    const content = await Bun.file(join(home, ".claude", "skills", "glia", "SKILL.md")).text();
    expect(content).toContain("name: glia");
    expect(content).toContain(`glia_version: ${doc.result.version}`);
  });
});
