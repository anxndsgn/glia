import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runImport } from "../../src/session/domain/import.ts";
import { runDelete } from "../../src/session/domain/delete.ts";
import { sessionIdOf } from "../../src/session/domain/identity.ts";
import { conflictDir } from "../../src/session/domain/conflict.ts";
import { viewCommand } from "../../src/session/commands/view.ts";
import type { CommandRunContext, LoadedProject } from "../../src/core/session-module.ts";
import type { EvidenceLocator } from "../../src/session/projection/query.ts";
import { initProject, makeTestEnv, writeClaudeSession, type TestEnv } from "../helpers.ts";

interface ViewSessionHeader {
  sessionId: string;
  harnessId: string;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  continuationParent: string | null;
  revisionDigest: string;
  sourceFiles: string[];
}

interface ViewEventJson {
  seq: number;
  label: string;
  timestamp: string | null;
  toolNames?: string[];
  /** Absent on a timeline event with no text: the verb omits its defaults. */
  text?: string | null;
  locator: EvidenceLocator;
  role?: unknown;
}

interface TimelineJson {
  session: ViewSessionHeader;
  events: ViewEventJson[];
  totalEvents: number;
  maxSeq: number | null;
  parameters: Record<string, unknown>;
}

interface DetailJson {
  session: ViewSessionHeader;
  event: ViewEventJson;
}

let env: TestEnv;
let project: LoadedProject;
let ctx: CommandRunContext;

const mainSessionId = sessionIdOf({ harnessId: "claude-code", sourceSessionId: "view-main" });

const MULTILINE = "first line\nsecond   line\n\nthird line trailing";
const MULTILINE_COLLAPSED = "first line second line third line trailing";

function userLine(ts: string, text: string): unknown {
  return {
    type: "user",
    uuid: `view-main-${ts}`,
    sessionId: "view-main",
    cwd: env.worktree,
    timestamp: ts,
    message: { role: "user", content: text },
  };
}

async function run(args: (string | undefined)[], options: Record<string, unknown> = {}) {
  const outcome = await viewCommand.run(ctx, args, options);
  return { human: outcome.human, json: outcome.json as TimelineJson & DetailJson };
}

beforeAll(async () => {
  env = await makeTestEnv();
  project = await initProject(env);
  ctx = { project, env: env.env, jsonMode: false, inputDisabled: true };

  // view-main's timeline, in source order:
  //   #1 user       #2 toolcall (Read,Bash)   #3 toolresult (user envelope)
  //   #4 agent      #5 user                   #6 user (multi-line)
  //   #7 user       #8 unknown (no timestamp)
  await writeClaudeSession(env.claudeHome, {
    sessionId: "view-main",
    cwd: env.worktree,
    extraLines: [
      {
        type: "assistant",
        uuid: "view-main-a2",
        sessionId: "view-main",
        cwd: env.worktree,
        timestamp: "2026-07-15T10:01:00Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "I will fix the retry loop now" }],
        },
      },
      userLine("2026-07-15T10:02:00Z", "alpha window one"),
      userLine("2026-07-15T10:03:00Z", MULTILINE),
      userLine("2026-07-15T10:04:00Z", "gamma window three"),
      { type: "banana", data: "unclassifiable" },
    ],
  });
  await writeClaudeSession(env.claudeHome, { sessionId: "view-conflict", cwd: env.worktree });
  await writeClaudeSession(env.claudeHome, { sessionId: "view-deleted", cwd: env.worktree });
  await runImport(project, env.env, { harness: null, dryRun: false, onlyCandidateIds: null });
});
afterAll(async () => {
  await env.cleanup();
});

describe("session view timeline", () => {
  test("lists every event in seq order with filter-vocabulary labels", async () => {
    const { human, json } = await run([mainSessionId]);
    expect(json.totalEvents).toBe(8);
    expect(json.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(json.events.map((e) => e.label)).toEqual([
      "user",
      "toolcall",
      "toolresult",
      "agent",
      "user",
      "user",
      "user",
      "unknown",
    ]);
    expect(human).toContain(`${mainSessionId}  claude-code  2026-07-15`);
    expect(human).toContain("8 events.");
  });

  test("--filter runs without a text query; speaker slices follow search's rules", async () => {
    const users = await run([mainSessionId], { filter: ["user"] });
    expect(users.json.events.map((e) => e.seq)).toEqual([1, 5, 6, 7]);
    expect(users.json.totalEvents).toBe(4);
    // The tool output travels in a user-role envelope (#3): in neither slice.
    const agents = await run([mainSessionId], { filter: ["agent"] });
    expect(agents.json.events.map((e) => e.seq)).toEqual([4]);
    const union = await run([mainSessionId], { filter: ["agent", "toolresult"] });
    expect(union.json.events.map((e) => e.seq)).toEqual([3, 4]);
  });

  test("toolcall:<name> matches case-insensitively; rendering preserves attested casing", async () => {
    const { human, json } = await run([mainSessionId], { filter: ["toolcall:read"] });
    expect(json.events.map((e) => e.seq)).toEqual([2]);
    expect(json.events[0]!.toolNames).toEqual(["Read", "Bash"]);
    expect(human).toContain("Read,Bash");
    const unknown = run([mainSessionId], { filter: ["speaker"] });
    await expect(unknown).rejects.toMatchObject({
      code: "USAGE",
      message: expect.stringContaining("toolcall:<name>"),
    });
  });

  test("a multi-line event renders as one line, byte-identical between human and JSON", async () => {
    const { human, json } = await run([mainSessionId]);
    const event = json.events.find((e) => e.seq === 6)!;
    expect(event.text).toBe(MULTILINE_COLLAPSED);
    expect(event.text).not.toContain("\n");
    expect(human).toContain(MULTILINE_COLLAPSED);
  });

  test("timeline lines carry no locator; the JSON document always does", async () => {
    const { human, json } = await run([mainSessionId]);
    expect(human).not.toContain(":line:");
    for (const event of json.events) {
      expect(event.locator.sourceFile).toBe("source/transcript.jsonl");
      expect(event.locator.sourceCursor).toMatch(/^line:\d+$/);
    }
  });

  test("the JSON document carries header fields, label-only events, and echoed parameters", async () => {
    const { json } = await run([mainSessionId]);
    expect(json.session.sessionId).toBe(mainSessionId);
    expect(json.session.harnessId).toBe("claude-code");
    expect(json.session.sourceFiles).toEqual(["source/transcript.jsonl"]);
    expect(json.session.revisionDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(json.maxSeq).toBe(8);
    // `label` is the vocabulary value; there is no transport role field.
    for (const event of json.events) expect("role" in event).toBeFalse();
    expect(json.parameters).toEqual({ filter: [], limit: 50, all: false, tail: null, from: null });
  });

  test("a missing source timestamp renders as a fixed-width placeholder", async () => {
    const { human, json } = await run([mainSessionId]);
    expect(json.events[7]!.timestamp).toBeNull();
    const line = human.split("\n").find((l) => l.includes("unknown"))!;
    expect(line).toMatch(/#8\s+unknown\s+-\s+/);
  });
});

describe("session view windowing", () => {
  test("windowing applies after filtering and --from resumes a capped listing", async () => {
    const first = await run([mainSessionId], { filter: ["user"], limit: "2" });
    expect(first.json.events.map((e) => e.seq)).toEqual([1, 5]);
    expect(first.json.totalEvents).toBe(4);
    expect(first.human).toContain("showing events #1–#5 of 4 · continue with --from 6");

    const resumed = await run([mainSessionId], { filter: ["user"], limit: "2", from: "6" });
    expect(resumed.json.events.map((e) => e.seq)).toEqual([6, 7]);
    expect(resumed.json.totalEvents).toBe(4);
    // Nothing follows the shown window: no continuation hint.
    expect(resumed.human).toContain("showing events #6–#7 of 4");
    expect(resumed.human).not.toContain("continue with");
  });

  test("--all emits every filtered event and --tail shows the filtered end", async () => {
    const all = await run([mainSessionId], { all: true });
    expect(all.json.events).toHaveLength(8);
    expect(all.json.parameters["all"]).toBeTrue();
    expect(all.json.parameters["limit"]).toBeNull();

    const tail = await run([mainSessionId], { filter: ["user"], tail: "3" });
    expect(tail.json.events.map((e) => e.seq)).toEqual([5, 6, 7]);
    expect(tail.json.totalEvents).toBe(4);
    expect(tail.human).toContain("showing events #5–#7 of 4");
  });

  test("window exclusions are USAGE before the projection is touched", async () => {
    await expect(run([mainSessionId], { all: true, limit: "3" })).rejects.toMatchObject({
      code: "USAGE",
    });
    for (const extra of [{ from: "2" }, { limit: "3" }, { all: true }]) {
      await expect(run([mainSessionId], { tail: "2", ...extra })).rejects.toMatchObject({
        code: "USAGE",
      });
    }
    await expect(run([mainSessionId], { limit: "0" })).rejects.toMatchObject({ code: "USAGE" });
    await expect(run([mainSessionId], { from: "-1" })).rejects.toMatchObject({ code: "USAGE" });
  });

  test("an empty window is an honest success, not an error", async () => {
    const none = await run([mainSessionId], { filter: ["toolcall:NoSuchTool"] });
    expect(none.json.events).toEqual([]);
    expect(none.json.totalEvents).toBe(0);
    expect(none.human).toContain(mainSessionId); // header still renders
    expect(none.human).toContain("showing 0 of 0 events");

    const past = await run([mainSessionId], { from: "99" });
    expect(past.json.events).toEqual([]);
    expect(past.json.totalEvents).toBe(8);
    expect(past.json.maxSeq).toBe(8);
    expect(past.human).toContain("showing 0 of 8 events · highest sequence is #8");
  });
});

describe("session view detail mode", () => {
  test("--seq renders the whole event with line structure and its full locator", async () => {
    const { human, json } = await run([mainSessionId], { seq: "6" });
    expect(json.event.seq).toBe(6);
    expect(json.event.text).toBe(MULTILINE);
    expect(human).toContain(MULTILINE);
    expect(human).toContain("source/transcript.jsonl:line:");
    expect(json.event.locator.sourceCursor).toMatch(/^line:\d+$/);
  });

  test("--seq combines with no timeline option and rejects non-positive values", async () => {
    for (const extra of [
      { filter: ["user"] },
      { limit: "3" },
      { all: true },
      { tail: "2" },
      { from: "2" },
    ]) {
      await expect(run([mainSessionId], { seq: "6", ...extra })).rejects.toMatchObject({
        code: "USAGE",
      });
    }
    await expect(run([mainSessionId], { seq: "0" })).rejects.toMatchObject({ code: "USAGE" });
  });

  test("a sequence the Session does not hold is NOT_FOUND naming Session and sequence", async () => {
    await expect(run([mainSessionId], { seq: "99" })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining(`session ${mainSessionId} has no event #99`),
    });
  });
});

describe("session view failure modes", () => {
  test("an unknown Session ID is NOT_FOUND", async () => {
    await expect(run(["ses_00000000000000000000000000000000"])).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  test("a conflict-frozen Session is SESSION_CONFLICT before any timeline", async () => {
    const conflictedId = sessionIdOf({
      harnessId: "claude-code",
      sourceSessionId: "view-conflict",
    });
    const dir = conflictDir(project.paths.storeDir, conflictedId);
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, "conflict.json"), "{}");
    await expect(run([conflictedId])).rejects.toMatchObject({ code: "SESSION_CONFLICT" });
    // Every other Session stays viewable.
    const { json } = await run([mainSessionId], { limit: "1" });
    expect(json.events).toHaveLength(1);
  });

  test("a tombstoned identity is SESSION_DELETED with ledger facts", async () => {
    const deletedId = sessionIdOf({ harnessId: "claude-code", sourceSessionId: "view-deleted" });
    await runDelete(project, env.env, deletedId);
    await expect(run([deletedId])).rejects.toMatchObject({
      code: "SESSION_DELETED",
      message: expect.stringContaining("was deleted at"),
    });
  });
});
