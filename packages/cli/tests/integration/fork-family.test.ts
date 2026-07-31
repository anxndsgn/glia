import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { runImport } from "../../src/session/domain/import.ts";
import { runDelete } from "../../src/session/domain/delete.ts";
import { sessionIdOf } from "../../src/session/domain/identity.ts";
import { archiveCommand } from "../../src/session/commands/archive.ts";
import { acceptCommand } from "../../src/session/commands/accept.ts";
import { candidatesCommand } from "../../src/session/commands/candidates.ts";
import { listCommand } from "../../src/session/commands/list.ts";
import { searchCommand } from "../../src/session/commands/search.ts";
import { showCommand } from "../../src/session/commands/show.ts";
import { humanImportReport, importCommand } from "../../src/session/commands/import.ts";
import { ProjectStore } from "../../src/core/store/store.ts";
import { PROJECTION_VERSION } from "../../src/session/projection/schema.ts";
import { readSessionMeta } from "../../src/session/storage/store-layout.ts";
import type { CommandRunContext, LoadedProject } from "../../src/core/session-module.ts";
import type { FamilyHint } from "../../src/session/domain/family-hint.ts";
import {
  initProject,
  makeTestEnv,
  writeClaudeSession,
  writeCodexSession,
  type TestEnv,
} from "../helpers.ts";

// Fork-twin fixtures are copied prefixes with equal event identifiers,
// timestamps, and messages under rewritten envelope fields (sessionId) —
// what a Claude Code desktop fork leaves on disk.
setDefaultTimeout(60_000);

let env: TestEnv;
let project: LoadedProject;
let ctx: CommandRunContext;

beforeEach(async () => {
  env = await makeTestEnv();
  project = await initProject(env);
  ctx = { project, env: env.env, jsonMode: false, inputDisabled: true };
});

afterEach(async () => {
  await env.cleanup();
});

const importAll = () =>
  runImport(project, env.env, { harness: null, dryRun: false, onlyCandidateIds: null });

const recId = (sessionId: string): string =>
  sessionIdOf({ harnessId: "claude-code", sourceSessionId: sessionId });

function userLine(sessionId: string, ts: string | null, text: string, uuid?: string): unknown {
  return {
    type: "user",
    uuid: uuid ?? `${sessionId}-${ts ?? "x"}-${text}`,
    sessionId,
    cwd: env.worktree,
    ...(ts ? { timestamp: ts } : {}),
    message: { role: "user", content: text },
  };
}

/** Copies the first `prefixLines` of an existing session file under a new
 * session id, keeping identifiers, timestamps, and messages intact. */
async function writeForkTwin(
  sourceSessionId: string,
  twinSessionId: string,
  prefixLines: number,
  extraLines: unknown[] = [],
): Promise<string> {
  const dir = join(env.claudeHome, "projects", env.worktree.replaceAll("/", "-"));
  const source = await Bun.file(join(dir, `${sourceSessionId}.jsonl`)).text();
  const copied = source
    .trim()
    .split("\n")
    .slice(0, prefixLines)
    .map((line) => {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      parsed["sessionId"] = twinSessionId;
      return JSON.stringify(parsed);
    });
  const path = join(dir, `${twinSessionId}.jsonl`);
  await Bun.write(
    path,
    [...copied, ...extraLines.map((line) => JSON.stringify(line))].join("\n") + "\n",
  );
  return path;
}

/** Writes a raw transcript without the helper's default lines. */
async function writeRawSession(sessionId: string, lines: unknown[]): Promise<string> {
  const dir = join(env.claudeHome, "projects", env.worktree.replaceAll("/", "-"));
  const path = join(dir, `${sessionId}.jsonl`);
  await Bun.write(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return path;
}

interface ListJson {
  totalSessions: number;
  sessions: {
    sessionId: string;
    eventCount: number;
    family: { anchor: string; memberCount: number } | null;
  }[];
}

interface SearchJson {
  totalMatches: number;
  familyCollapsedMatches: number;
  matches: {
    sessionId: string;
    eventSeq: number;
    excerpt?: string;
    alsoIn?: string[];
    context?: { seq: number }[];
  }[];
  parameters: Record<string, unknown>;
}

async function list(options: Record<string, unknown> = {}) {
  const outcome = await listCommand.run(ctx, [], options);
  return { human: outcome.human, json: outcome.json as ListJson };
}

async function search(args: (string | undefined)[], options: Record<string, unknown> = {}) {
  const outcome = await searchCommand.run(ctx, args, options);
  return { human: outcome.human, json: outcome.json as SearchJson };
}

async function show(sessionId: string) {
  const outcome = await showCommand.run(ctx, [sessionId], {});
  return { human: outcome.human, json: outcome.json as Record<string, unknown> };
}

/** A prefix count beyond any fixture's length copies the file whole. */
const WHOLE_FILE = 100;

async function writeTwinPair(
  originSession: string,
  twinSession: string,
  originText: string,
  twinSuffix: unknown[] = [],
): Promise<void> {
  await writeClaudeSession(env.claudeHome, {
    sessionId: originSession,
    cwd: env.worktree,
    userText: originText,
  });
  await writeForkTwin(originSession, twinSession, WHOLE_FILE, twinSuffix);
}

describe("Session Fork Family", () => {
  test("no-family search caps candidates in SQL while retaining the best-ranked matches", async () => {
    await writeRawSession("bounded-solo", [
      userLine("bounded-solo", "2026-07-15T10:00:00Z", "BOUNDEDPROBE weak one"),
      userLine("bounded-solo", "2026-07-15T10:01:00Z", "BOUNDEDPROBE weak two"),
      userLine("bounded-solo", "2026-07-15T10:02:00Z", "BOUNDEDPROBE weak three"),
      userLine(
        "bounded-solo",
        "2026-07-15T10:03:00Z",
        "BOUNDEDPROBE strong BOUNDEDPROBE BOUNDEDPROBE",
      ),
    ]);
    await importAll();

    const result = await search(["BOUNDEDPROBE"], { perSession: "2" });
    expect(result.json.totalMatches).toBe(4);
    expect(result.json.matches).toHaveLength(2);
    expect(result.json.matches.some((match) => match.excerpt?.includes("strong"))).toBeTrue();
  });

  test("list windows family facts to shown Sessions and same-run imports hint later twins", async () => {
    await writeRawSession("window-anchor", [
      userLine("window-anchor", "2026-07-15T09:00:00Z", "ANCHORONLY opening"),
      userLine("window-anchor", "2026-07-15T10:00:00Z", "WINDOWSHARED event", "window-shared"),
    ]);
    await writeRawSession("window-newest", [
      userLine("window-newest", "2026-07-15T10:00:00Z", "WINDOWSHARED event", "window-shared"),
      userLine("window-newest", "2026-07-15T12:00:00Z", "NEWESTONLY suffix"),
    ]);

    const report = await importAll();
    expect(report.accepted).toHaveLength(2);
    expect(report.accepted[0]!.familyHint).toBeNull();
    expect(report.accepted[1]!.familyHint?.withSessionId).toBe(report.accepted[0]!.sessionId);

    const limited = await list({ limit: "1" });
    expect(limited.json.sessions).toHaveLength(1);
    expect(limited.json.sessions[0]!.sessionId).toBe(recId("window-newest"));
    expect(limited.json.sessions[0]!.family).toBeNull();
    expect(limited.human).not.toContain("(family");
  });

  test("search windows family facts to shown groups and collapsed copy-holders", async () => {
    await writeRawSession("search-window-anchor", [
      userLine(
        "search-window-anchor",
        "2026-07-15T08:00:00Z",
        "WINDOWTOKEN weak match among unrelated words",
      ),
      userLine("search-window-anchor", "2026-07-15T09:00:00Z", "FAMILYLINK shared", "family-link"),
    ]);
    await writeRawSession("search-window-b", [
      userLine("search-window-b", "2026-07-15T09:00:00Z", "FAMILYLINK shared", "family-link"),
      userLine(
        "search-window-b",
        "2026-07-15T10:00:00Z",
        "WINDOWTOKEN strong WINDOWTOKEN WINDOWTOKEN",
        "window-target",
      ),
    ]);
    await writeRawSession("search-window-c", [
      userLine(
        "search-window-c",
        "2026-07-15T10:00:00Z",
        "WINDOWTOKEN strong WINDOWTOKEN WINDOWTOKEN",
        "window-target",
      ),
    ]);
    await importAll();

    const result = await search(["WINDOWTOKEN"], { limit: "1" });
    const shownAnchor = recId("search-window-b");
    const hiddenAnchor = recId("search-window-anchor");
    const copy = recId("search-window-c");
    expect(result.json.matches).toHaveLength(1);
    expect(result.json.matches[0]!.sessionId).toBe(shownAnchor);
    expect(result.json.matches[0]!.alsoIn).toEqual([copy]);
    expect(result.human).toContain("(family of 2)");
    expect(result.human).not.toContain(`(family: ${hiddenAnchor})`);
  });

  test("fork twins form one family: list notes, JSON family, and the singular (also in …) marker", async () => {
    await writeTwinPair("fork-origin", "fork-twin", "ORIGINPROBE opening", [
      userLine("fork-twin", "2026-07-15T11:00:00Z", "TWINPROBE suffix"),
    ]);
    await writeClaudeSession(env.claudeHome, {
      sessionId: "solo-1",
      cwd: env.worktree,
      userText: "SOLOPROBE unrelated",
    });
    await importAll();

    const origin = recId("fork-origin");
    const twin = recId("fork-twin");
    // Equal first event timestamps: the tie falls to the ascending Session ID.
    const anchor = [origin, twin].sort()[0]!;
    const other = anchor === origin ? twin : origin;

    const listed = await list();
    const anchorRow = listed.json.sessions.find((r) => r.sessionId === anchor)!;
    const otherRow = listed.json.sessions.find((r) => r.sessionId === other)!;
    const soloRow = listed.json.sessions.find((r) => r.sessionId === recId("solo-1"))!;
    expect(anchorRow.family).toEqual({ anchor, memberCount: 2 });
    expect(otherRow.family).toEqual({ anchor, memberCount: 2 });
    expect(soloRow.family).toBeNull();
    const anchorLine = listed.human.split("\n").find((l) => l.trim().startsWith(anchor))!;
    const otherLine = listed.human.split("\n").find((l) => l.trim().startsWith(other))!;
    const soloLine = listed.human.split("\n").find((l) => l.trim().startsWith(recId("solo-1")))!;
    expect(anchorLine).toContain("(family of 2)");
    expect(otherLine).toContain(`(family: ${anchor})`);
    expect(soloLine).not.toContain("family");

    // A term inside the shared prefix renders once, attributed to the
    // anchor, marked with the one other member, and counted once.
    const collapsed = await search(["ORIGINPROBE"]);
    expect(collapsed.json.totalMatches).toBe(1);
    expect(collapsed.json.familyCollapsedMatches).toBe(1);
    expect(collapsed.json.matches).toHaveLength(1);
    expect(collapsed.json.matches[0]!.sessionId).toBe(anchor);
    expect(collapsed.json.matches[0]!.alsoIn).toEqual([other]);
    expect(collapsed.human).toContain(`(also in ${other})`);
    // A term matching only the twin's unique suffix renders uncollapsed.
    const unique = await search(["TWINPROBE"]);
    expect(unique.json.totalMatches).toBe(1);
    expect(unique.json.familyCollapsedMatches).toBe(0);
    expect(unique.json.matches[0]!.sessionId).toBe(twin);
    expect(unique.json.matches[0]!.alsoIn).toBeUndefined();
    expect(unique.human).not.toContain("also in");
  });

  test("the anchor is the earliest-started member; undated members order last", async () => {
    // early-b started earlier (09:00) than early-a (10:00); they share one
    // later event, so the family anchor is early-b's Session.
    await writeRawSession("early-a", [
      userLine("early-a", "2026-07-15T10:00:00Z", "EARLYA one"),
      userLine("early-a", "2026-07-15T11:00:00Z", "EARLY shared", "early-shared-1"),
    ]);
    await writeRawSession("early-b", [
      userLine("early-b", "2026-07-15T09:00:00Z", "EARLYB own"),
      userLine("early-b", "2026-07-15T11:00:00Z", "EARLY shared", "early-shared-1"),
    ]);
    // A dated and an undated member share one undated event; the dated
    // member anchors because undated members order last.
    await writeRawSession("dated-1", [
      userLine("dated-1", "2026-07-15T10:00:00Z", "DATEDFIRST probe"),
      userLine("dated-1", null, "UNDATEDSHARED probe", "undated-shared-1"),
    ]);
    await writeRawSession("undated-1", [
      userLine("undated-1", null, "UNDATEDSHARED probe", "undated-shared-1"),
      userLine("undated-1", null, "UNDATEDOWN probe"),
    ]);
    await importAll();

    const listed = await list();
    const earlyA = listed.json.sessions.find((r) => r.sessionId === recId("early-a"))!;
    const earlyB = listed.json.sessions.find((r) => r.sessionId === recId("early-b"))!;
    expect(earlyA.family).toEqual({ anchor: recId("early-b"), memberCount: 2 });
    expect(earlyB.family).toEqual({ anchor: recId("early-b"), memberCount: 2 });
    const dated = listed.json.sessions.find((r) => r.sessionId === recId("dated-1"))!;
    const undated = listed.json.sessions.find((r) => r.sessionId === recId("undated-1"))!;
    expect(dated.family).toEqual({ anchor: recId("dated-1"), memberCount: 2 });
    expect(undated.family).toEqual({ anchor: recId("dated-1"), memberCount: 2 });
  });

  test("differing text, missing identifiers, and cross-Harness equality never connect Sessions", async () => {
    // Same identifier and timestamp, different text: no edge.
    await writeRawSession("diff-a", [
      userLine("diff-a", "2026-07-15T10:00:00Z", "DIFFTEXT alpha", "same-uuid-1"),
    ]);
    await writeRawSession("diff-b", [
      userLine("diff-b", "2026-07-15T10:00:00Z", "DIFFTEXT beta", "same-uuid-1"),
    ]);
    // No source event identifier at all: no edge, even with equal text.
    await writeRawSession("noid-a", [
      {
        type: "user",
        sessionId: "noid-a",
        cwd: env.worktree,
        timestamp: "2026-07-15T10:00:00Z",
        message: { role: "user", content: "NOIDPROBE same text" },
      },
    ]);
    await writeRawSession("noid-b", [
      {
        type: "user",
        sessionId: "noid-b",
        cwd: env.worktree,
        timestamp: "2026-07-15T10:00:00Z",
        message: { role: "user", content: "NOIDPROBE same text" },
      },
    ]);
    // Equal identifier, timestamp, and text — but across Harnesses: no edge.
    await writeRawSession("xhat-claude", [
      userLine("xhat-claude", "2026-07-15T09:30:00Z", "CROSSPROBE text", "cross-1"),
    ]);
    await writeCodexSession(env.codexHome, {
      sessionId: "xhat-codex",
      cwd: env.worktree,
      extraLines: [
        {
          timestamp: "2026-07-15T09:30:00Z",
          type: "response_item",
          payload: {
            type: "message",
            id: "cross-1",
            role: "assistant",
            content: [{ type: "output_text", text: "CROSSPROBE text" }],
          },
        },
      ],
    });
    await importAll();

    const listed = await list();
    expect(listed.json.sessions.length).toBe(6);
    expect(listed.json.sessions.every((r) => r.family === null)).toBeTrue();
    expect(listed.human).not.toContain("(family");
  });

  test("a Continuation-linked pair with zero shared events is one family and collapses nothing", async () => {
    await writeClaudeSession(env.claudeHome, {
      sessionId: "cont-parent",
      cwd: env.worktree,
      userText: "CONTSHARE opening",
    });
    await writeClaudeSession(env.claudeHome, {
      sessionId: "cont-child",
      cwd: env.worktree,
      parentSessionId: "cont-parent",
      userText: "CONTSHARE resume",
    });
    await importAll();

    const parent = recId("cont-parent");
    const child = recId("cont-child");
    const anchor = [parent, child].sort()[0]!;
    const other = anchor === parent ? child : parent;

    const listed = await list();
    expect(listed.json.sessions.find((r) => r.sessionId === parent)!.family).toEqual({
      anchor,
      memberCount: 2,
    });
    const anchorLine = listed.human.split("\n").find((l) => l.trim().startsWith(anchor))!;
    const otherLine = listed.human.split("\n").find((l) => l.trim().startsWith(other))!;
    expect(anchorLine).toContain("(family of 2)");
    expect(otherLine).toContain(`(family: ${anchor})`);

    // The search headers carry the family note (and the Continuation
    // note) while the zero shared events collapse nothing.
    const result = await search(["CONTSHARE"]);
    expect(result.json.totalMatches).toBe(2);
    expect(result.json.familyCollapsedMatches).toBe(0);
    expect(result.human).not.toContain("also in");
    expect(result.human).toContain("(continues cont-parent)");
    expect(result.human).toContain("(family of 2)");
    expect(result.human).toContain(`(family: ${anchor})`);
  });

  test("three-member families mark (also in 2 sessions) and report suppressed copies in JSON", async () => {
    await writeClaudeSession(env.claudeHome, {
      sessionId: "tri-origin",
      cwd: env.worktree,
      userText: "TRIPREFIX one",
      extraLines: [userLine("tri-origin", "2026-07-15T10:05:00Z", "TRIPREFIX two")],
    });
    // The default fixture plus the extra line is four lines; copy all four.
    await writeForkTwin("tri-origin", "tri-b", 4, [
      userLine("tri-b", "2026-07-15T11:00:00Z", "TWINB unique"),
    ]);
    await writeForkTwin("tri-origin", "tri-c", 4, [
      userLine("tri-c", "2026-07-15T12:00:00Z", "TWINC unique"),
    ]);
    await importAll();

    const ids = [recId("tri-origin"), recId("tri-b"), recId("tri-c")];
    const anchor = [...ids].sort()[0]!;
    const others = ids.filter((id) => id !== anchor).sort();

    const result = await search(["TRIPREFIX"]);
    expect(result.json.totalMatches).toBe(2);
    expect(result.json.familyCollapsedMatches).toBe(4);
    expect(result.json.matches).toHaveLength(2);
    for (const match of result.json.matches) {
      expect(match.sessionId).toBe(anchor);
      expect(match.alsoIn).toEqual(others);
    }
    expect(result.human).toContain("(also in 2 sessions)");
    expect(result.human).not.toContain(`(also in ${others[0]})`);
  });

  test("collapsed matches count against the attributed Session's quota only; sort and context unchanged", async () => {
    // Both members hold the shared prefix plus their own unique suffix,
    // so the assertions hold whichever Session ID sorts first.
    await writeClaudeSession(env.claudeHome, {
      sessionId: "quota-origin",
      cwd: env.worktree,
      userText: "QTOKEN share one",
      extraLines: [
        userLine("quota-origin", "2026-07-15T10:01:00Z", "QTOKEN share two"),
        userLine("quota-origin", "2026-07-15T10:02:00Z", "QTOKEN share three"),
        userLine("quota-origin", "2026-07-15T10:03:00Z", "QTOKEN origin unique"),
      ],
    });
    await writeForkTwin("quota-origin", "quota-twin", 5, [
      userLine("quota-twin", "2026-07-15T11:00:00Z", "QTOKEN twin unique"),
    ]);
    await importAll();

    const origin = recId("quota-origin");
    const twin = recId("quota-twin");
    const anchor = [origin, twin].sort()[0]!;
    const other = anchor === origin ? twin : origin;

    const capped = await search(["QTOKEN"], { perSession: "2" });
    // Three shared matches collapse onto the anchor; each member's unique
    // match is its own, and the suppressed copies never count against the
    // other member's quota.
    expect(capped.json.totalMatches).toBe(5);
    expect(capped.json.familyCollapsedMatches).toBe(3);
    const anchorMatches = capped.json.matches.filter((m) => m.sessionId === anchor);
    const otherMatches = capped.json.matches.filter((m) => m.sessionId === other);
    expect(anchorMatches).toHaveLength(2);
    expect(anchorMatches.every((m) => m.alsoIn !== undefined)).toBeTrue();
    expect(otherMatches).toHaveLength(1);
    expect(otherMatches[0]!.alsoIn).toBeUndefined();
    expect(otherMatches[0]!.excerpt).toContain("unique");
    expect(capped.human).toContain(
      "… 2 more matches in this Session (raise --per-session to see them).",
    );

    const timed = await search(["QTOKEN"], { sort: "time" });
    expect(timed.json.parameters["sort"]).toBe("time");
    const groupOrder = [...new Set(timed.json.matches.map((m) => m.sessionId))];
    expect(groupOrder).toEqual([anchor, other]);

    const withContext = await search(["QTOKEN twin unique"], { context: "1" });
    const match = withContext.json.matches[0]!;
    expect(match.sessionId).toBe(twin);
    expect(match.context?.map((c) => c.seq)).toEqual([match.eventSeq - 1]);
    expect(withContext.human).toContain("» #");
  });

  test("archiving the anchor moves attribution and notes to the visible set; show reports the whole Store", async () => {
    await writeClaudeSession(env.claudeHome, {
      sessionId: "arc-origin",
      cwd: env.worktree,
      userText: "ARCPREFIX one",
      extraLines: [userLine("arc-origin", "2026-07-15T10:05:00Z", "ARCPREFIX two")],
    });
    await writeForkTwin("arc-origin", "arc-b", 4, [
      userLine("arc-b", "2026-07-15T11:00:00Z", "ARCB own"),
    ]);
    await writeForkTwin("arc-origin", "arc-c", 4, [
      userLine("arc-c", "2026-07-15T12:00:00Z", "ARCC own"),
    ]);
    await importAll();

    const ids = [recId("arc-origin"), recId("arc-b"), recId("arc-c")];
    const trueAnchor = [...ids].sort()[0]!;
    const remaining = ids.filter((id) => id !== trueAnchor).sort();
    const newAnchor = remaining[0]!;

    const archived = await archiveCommand.run(ctx, [trueAnchor], { yes: true });
    expect((archived.json as { applied: boolean }).applied).toBeTrue();

    // Default filtering: the family note and attribution move to the
    // remaining visible members.
    const listed = await list();
    expect(listed.json.sessions).toHaveLength(2);
    expect(listed.json.sessions.find((r) => r.sessionId === newAnchor)!.family).toEqual({
      anchor: newAnchor,
      memberCount: 2,
    });
    const collapsed = await search(["ARCPREFIX"]);
    expect(collapsed.json.totalMatches).toBe(2);
    expect(collapsed.json.familyCollapsedMatches).toBe(2);
    expect(collapsed.json.matches.every((m) => m.sessionId === newAnchor)).toBeTrue();
    expect(collapsed.json.matches[0]!.alsoIn).toEqual([remaining[1]!]);
    expect(collapsed.human).toContain(`(also in ${remaining[1]})`);

    // --include-archived restores the true anchor and its count.
    const included = await search(["ARCPREFIX"], { includeArchived: true });
    expect(included.json.totalMatches).toBe(2);
    expect(included.json.familyCollapsedMatches).toBe(4);
    expect(included.json.matches.every((m) => m.sessionId === trueAnchor)).toBeTrue();
    expect(included.json.matches[0]!.alsoIn).toEqual(remaining);

    // Direct address reports the family over the whole Store, marking the
    // archived member.
    const shown = await show(newAnchor);
    expect(shown.human).toContain(`family: 3 member(s), anchor ${trueAnchor}`);
    const archivedLine = shown.human.split("\n").find((l) => l.trim().startsWith(trueAnchor))!;
    expect(archivedLine).toContain("[archived]");

    // A family whose other members are all filtered out renders no note.
    // Archive every member except arc-b's Session (the true anchor may be
    // any of the three, and re-archiving it is a harmless no-op).
    for (const id of ids) {
      if (id !== recId("arc-b")) await archiveCommand.run(ctx, [id], { yes: true });
    }
    const alone = await search(["ARCB own"]);
    expect(alone.json.totalMatches).toBe(1);
    expect(alone.human).not.toContain("(family");
    const aloneList = await list();
    expect(aloneList.json.sessions).toHaveLength(1);
    expect(aloneList.json.sessions.find((r) => r.sessionId === recId("arc-b"))!.family).toBeNull();
  });

  test("deleting one member leaves the survivor with no family facts; the tombstone blocks re-import", async () => {
    await writeTwinPair("del-origin", "del-twin", "DELPROBE shared");
    await importAll();
    const origin = recId("del-origin");
    const twin = recId("del-twin");
    const survivor = [origin, twin].sort()[0]!;
    const deleted = survivor === origin ? twin : origin;

    await runDelete(project, env.env, deleted);

    const listed = await list();
    const survivorRow = listed.json.sessions.find((r) => r.sessionId === survivor)!;
    expect(survivorRow.family).toBeNull();
    expect(listed.human).not.toContain("(family");
    const result = await search(["DELPROBE"]);
    expect(result.json.totalMatches).toBe(1);
    expect(result.json.familyCollapsedMatches).toBe(0);

    // The tombstoned Source Identity is never re-accepted automatically,
    // so it never contributes family edges again.
    const reimport = await importAll();
    expect(reimport.accepted).toHaveLength(0);
    expect(reimport.tombstoned).toHaveLength(1);
    const relisted = await list();
    expect(relisted.json.sessions).toHaveLength(1);
    expect(relisted.json.sessions[0]!.family).toBeNull();
  });

  test("accept and import state the overlap; dry-run and candidates stay silent", async () => {
    await writeClaudeSession(env.claudeHome, {
      sessionId: "hint-origin",
      cwd: env.worktree,
      userText: "HINTPROBE shared prefix",
    });
    await importAll();
    const origin = recId("hint-origin");
    await writeForkTwin("hint-origin", "hint-twin", WHOLE_FILE);

    // --dry-run classifies without capturing: no hint, and the output
    // keeps its pre-family shape exactly (every associated candidate is a
    // would-accept because a dry run never reads bundle bytes).
    const dry = await importCommand.run(ctx, [], { dryRun: true });
    expect(dry.human).toBe(
      "Dry run: 2 candidate(s) would be accepted, 0 unchanged, 0 out of scope, " +
        "0 pending, 0 ignored.\n" +
        "Secret detection not evaluated: a dry run captures no bundle bytes.",
    );
    expect(JSON.stringify(dry.json)).not.toContain("fork family");
    expect(JSON.stringify(dry.json)).not.toContain("familyHint");

    // session candidates never parses for family hints either.
    const candidates = await candidatesCommand.run(ctx, [], {});
    expect(candidates.human).not.toContain("fork family");
    expect(JSON.stringify(candidates.json)).not.toContain("familyHint");

    // session import's per-Session report lines carry the note.
    const report = await importAll();
    expect(report.accepted).toHaveLength(1);
    const hint = report.accepted[0]!.familyHint;
    expect(hint).not.toBeNull();
    expect(hint!.withSessionId).toBe(origin);
    expect(hint!.sharedEvents).toBeGreaterThan(0);
    expect(hint!.sharedEvents).toBeLessThanOrEqual(hint!.totalEvents);
    const reportText = humanImportReport(report);
    expect(reportText).toContain(
      `${recId("hint-twin")} shares ${hint!.sharedEvents} of ${hint!.totalEvents} events with ` +
        `${origin.slice(0, 10)}… (fork family)`,
    );

    // session accept names the same overlap: the largest-overlap stored
    // Session, ties by ascending Session ID, further related Sessions counted.
    await writeForkTwin("hint-origin", "hint-twin-2", WHOLE_FILE);
    const best = [origin, recId("hint-twin")].sort()[0]!;
    await expect(acceptCommand.run(ctx, [recId("hint-twin-2")], {})).rejects.toMatchObject({
      code: "INPUT_REQUIRED",
      details: {
        candidateId: recId("hint-twin-2"),
      },
    });
    expect(await readSessionMeta(project.paths.storeDir, recId("hint-twin-2"))).toBeNull();
    const accepted = await acceptCommand.run(ctx, [recId("hint-twin-2")], { yes: true });
    expect(accepted.human).toContain(`${recId("hint-twin-2")} shares `);
    expect(accepted.human).toContain(
      `events with ${best.slice(0, 10)}… (fork family; 1 more related session(s))`,
    );
    const acceptedJson = accepted.json as { accepted: { familyHint: FamilyHint | null }[] };
    expect(acceptedJson.accepted[0]!.familyHint?.withSessionId).toBe(best);
    expect(acceptedJson.accepted[0]!.familyHint?.furtherSessions).toBe(1);
  });

  test("family hints fall back to stored bundles when the projection is absent", async () => {
    await writeClaudeSession(env.claudeHome, {
      sessionId: "fallback-origin",
      cwd: env.worktree,
      userText: "FALLBACKPROBE shared prefix",
    });
    await importAll();
    const origin = recId("fallback-origin");
    await rm(project.paths.currentProjectionFile, { force: true });
    await rm(project.paths.indexesDir, { recursive: true, force: true });
    await writeForkTwin("fallback-origin", "fallback-twin", WHOLE_FILE);

    const report = await importAll();
    expect(report.accepted).toHaveLength(1);
    expect(report.accepted[0]!.familyHint?.withSessionId).toBe(origin);
    expect(report.accepted[0]!.familyHint?.sharedEvents).toBeGreaterThan(0);
  });

  test("a byte-identical re-import is a no-op; a grown twin recomputes family facts on rebuild", async () => {
    await writeTwinPair("grow-origin", "grow-twin", "GROWPROBE shared");
    const first = await importAll();
    const again = await importAll();
    expect(again.accepted).toHaveLength(0);
    expect(again.unchanged).toBe(2);
    expect(again.storeCommit).toBe(first.storeCommit);

    const twinPath = join(
      env.claudeHome,
      "projects",
      env.worktree.replaceAll("/", "-"),
      "grow-twin.jsonl",
    );
    const grown =
      (await Bun.file(twinPath).text()) +
      JSON.stringify(userLine("grow-twin", "2026-07-15T11:00:00Z", "GROWPROBE new growth")) +
      "\n";
    await Bun.write(twinPath, grown);
    const revision = await importAll();
    expect(revision.accepted).toHaveLength(1);
    expect(revision.accepted[0]!.sessionId).toBe(recId("grow-twin"));
    // The grown twin still shares its prefix with the stored original.
    expect(revision.accepted[0]!.familyHint?.withSessionId).toBe(recId("grow-origin"));

    const listed = await list();
    const originRow = listed.json.sessions.find((r) => r.sessionId === recId("grow-origin"))!;
    const twinRow = listed.json.sessions.find((r) => r.sessionId === recId("grow-twin"))!;
    expect(originRow.family?.memberCount).toBe(2);
    expect(twinRow.family?.memberCount).toBe(2);
    expect(twinRow.eventCount).toBe(originRow.eventCount + 1);
  });

  test("a projection persisted under the previous version rebuilds transparently; reading stays read-only", async () => {
    await writeTwinPair("rebuild-origin", "rebuild-twin", "REBUILDPROBE shared");
    await importAll();
    const store = new ProjectStore(project.paths.storeDir);
    const headBefore = await store.head();

    // Simulate a projection published by the previous binary.
    const pointerFile = project.paths.currentProjectionFile;
    const pointer = JSON.parse(await Bun.file(pointerFile).text()) as Record<string, unknown>;
    pointer["projectionVersion"] = PROJECTION_VERSION - 1;
    await Bun.write(pointerFile, JSON.stringify(pointer, null, 2) + "\n");

    const anchor = [recId("rebuild-origin"), recId("rebuild-twin")].sort()[0]!;
    const listed = await list();
    expect(listed.json.sessions.find((r) => r.sessionId === anchor)!.family?.memberCount).toBe(2);
    const rebuilt = JSON.parse(await Bun.file(pointerFile).text()) as Record<string, unknown>;
    expect(rebuilt["projectionVersion"]).toBe(PROJECTION_VERSION);

    await search(["REBUILDPROBE"]);
    await show(anchor);
    expect(await store.head()).toBe(headBefore);
  });
});
