import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { runImport } from "../../src/session/domain/import.ts";
import { sessionIdOf, candidateIdOf } from "../../src/session/domain/identity.ts";
import {
  readDiscoveryState,
  writeDiscoveryState,
} from "../../src/session/domain/discovery-state.ts";
import { searchCommand } from "../../src/session/commands/search.ts";
import { viewCommand } from "../../src/session/commands/view.ts";
import { listCommand } from "../../src/session/commands/list.ts";
import { candidatesCommand } from "../../src/session/commands/candidates.ts";
import { ProjectStore } from "../../src/core/store/store.ts";
import type { CommandRunContext, LoadedProject } from "../../src/core/session-module.ts";
import type { EvidenceLocator } from "../../src/session/projection/query.ts";
import {
  initProject,
  makeTestEnv,
  writeClaudeSession,
  writeCodexSession,
  type TestEnv,
} from "../helpers.ts";

let env: TestEnv;
let project: LoadedProject;
let ctx: CommandRunContext;

const dupSessionId = sessionIdOf({ harnessId: "claude-code", sourceSessionId: "dup-main" });
const sortNullSessionId = sessionIdOf({ harnessId: "claude-code", sourceSessionId: "sort-null" });

// The listing and timeline verbs omit their defaults, so every field these
// shapes mark optional is one whose absence carries meaning: a singleton
// `memberSeqs`, an event with no text.
interface SearchMatchJson {
  sessionId: string;
  eventSeq: number;
  memberSeqs?: number[];
  timestamp?: string | null;
  excerpt?: string;
  locator: EvidenceLocator;
  context?: { seq: number; line?: string; memberSeqs?: number[]; locator: EvidenceLocator }[];
}

interface SearchJson {
  totalMatches: number;
  matches: SearchMatchJson[];
  parameters: Record<string, unknown>;
}

interface ViewJson {
  events: { seq: number; text?: string; memberSeqs?: number[] }[];
  totalEvents: number;
  maxSeq: number;
}

function claudeUserLine(sessionId: string, cwd: string, ts: string | null, text: string): unknown {
  return {
    type: "user",
    uuid: `${sessionId}-${ts ?? "x"}-${text.slice(0, 8)}`,
    sessionId,
    cwd,
    ...(ts ? { timestamp: ts } : {}),
    message: { role: "user", content: text },
  };
}

async function search(args: (string | undefined)[], options: Record<string, unknown> = {}) {
  const outcome = await searchCommand.run(ctx, args, options);
  return { human: outcome.human, json: outcome.json as SearchJson };
}

async function view(args: (string | undefined)[], options: Record<string, unknown> = {}) {
  const outcome = await viewCommand.run(ctx, args, options);
  return { human: outcome.human, json: outcome.json as Record<string, unknown> };
}

beforeAll(async () => {
  env = await makeTestEnv();
  project = await initProject(env);
  ctx = { project, env: env.env, jsonMode: false, inputDisabled: true };
  const cwd = env.worktree;

  // One Session holding: a strict run of three byte-identical user
  // messages (#4–#6), a separator, two identical messages split by an
  // intervening system event (#8/#10), and a run of two identical
  // tool results carrying the same File Touch (#11–#12).
  const touchResult = (n: number) => ({
    type: "user",
    uuid: `dup-main-touch-${n}`,
    sessionId: "dup-main",
    cwd,
    timestamp: "2026-07-15T10:05:00Z",
    toolUseResult: { type: "update", filePath: `${cwd}/src/dup-target.ts` },
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tt", content: "touched DUPTOUCH ok" }],
    },
  });
  await writeClaudeSession(env.claudeHome, {
    sessionId: "dup-main",
    cwd,
    extraLines: [
      claudeUserLine("dup-main", cwd, "2026-07-15T10:01:00Z", "DUPRUN alpha alpha"),
      claudeUserLine("dup-main", cwd, "2026-07-15T10:01:01Z", "DUPRUN alpha alpha"),
      claudeUserLine("dup-main", cwd, "2026-07-15T10:01:02Z", "DUPRUN alpha alpha"),
      claudeUserLine("dup-main", cwd, "2026-07-15T10:02:00Z", "SEPARATOR one"),
      claudeUserLine("dup-main", cwd, "2026-07-15T10:03:00Z", "TWINSEP beta"),
      {
        type: "system",
        uuid: "dup-main-sys",
        sessionId: "dup-main",
        cwd,
        timestamp: "2026-07-15T10:03:30Z",
        message: { role: "system", content: "SYSNOTE between twins" },
      },
      claudeUserLine("dup-main", cwd, "2026-07-15T10:04:00Z", "TWINSEP beta"),
      touchResult(1),
      touchResult(2),
    ],
  });

  // Chronology fixtures for --sort time: the earliest matching event
  // lives in sort-b, the latest in sort-a, and sort-null's matching
  // event carries no timestamp at all.
  await writeClaudeSession(env.claudeHome, {
    sessionId: "sort-a",
    cwd,
    userText: "opening question for sort-a",
    extraLines: [claudeUserLine("sort-a", cwd, "2026-07-16T09:00:00Z", "SORTTOKEN newest here")],
  });
  // Session Label evidence: a titled Session (a user-authored title
  // outranking the Harness-generated one and the opening message), and one
  // whose first user-role line is Harness-injected rather than the user.
  await writeClaudeSession(env.claudeHome, {
    sessionId: "titled",
    cwd,
    userText: "titled session opening prompt",
    extraLines: [
      {
        type: "ai-title",
        uuid: "titled-ai",
        sessionId: "titled",
        cwd,
        timestamp: "2026-07-15T10:20:00Z",
        aiTitle: "Generated session title",
      },
      {
        type: "custom-title",
        uuid: "titled-custom",
        sessionId: "titled",
        cwd,
        timestamp: "2026-07-15T10:21:00Z",
        customTitle: "Custom session title",
      },
    ],
  });
  const metaDir = join(env.claudeHome, "projects", cwd.replaceAll("/", "-"));
  await mkdir(metaDir, { recursive: true });
  await Bun.write(
    join(metaDir, "meta-first.jsonl"),
    [
      JSON.stringify({
        ...(claudeUserLine(
          "meta-first",
          cwd,
          "2026-07-15T08:00:00Z",
          "<local-command-caveat>Caveat: the messages below were generated locally.",
        ) as object),
        isMeta: true,
      }),
      JSON.stringify(
        claudeUserLine("meta-first", cwd, "2026-07-15T08:01:00Z", "the real first prompt"),
      ),
    ].join("\n") + "\n",
  );
  await writeClaudeSession(env.claudeHome, {
    sessionId: "sort-b",
    cwd,
    extraLines: [claudeUserLine("sort-b", cwd, "2026-07-14T09:00:00Z", "SORTTOKEN oldest here")],
  });
  // A Session with no event timestamps anywhere: written raw, not via the
  // helper, so no default timestamped lines exist.
  const rawDir = join(env.claudeHome, "projects", cwd.replaceAll("/", "-"));
  await mkdir(rawDir, { recursive: true });
  await Bun.write(
    join(rawDir, "sort-null.jsonl"),
    [
      JSON.stringify(claudeUserLine("sort-null", cwd, null, "SORTTOKEN no time at all")),
      JSON.stringify(claudeUserLine("sort-null", cwd, null, "closing line")),
    ].join("\n") + "\n",
  );

  await runImport(project, env.env, { harness: null, dryRun: false, onlyCandidateIds: null });
});

afterAll(async () => {
  await env.cleanup();
});

describe("--file matching rule", () => {
  test("bare name and full path select the same touches; a directory selects none", async () => {
    const bare = await search([undefined], { file: "dup-target.ts" });
    const full = await search([undefined], { file: `${env.worktree}/src/dup-target.ts` });
    expect(bare.json.totalMatches).toBeGreaterThan(0);
    expect(bare.json.totalMatches).toBe(full.json.totalMatches);
    expect(bare.json.matches.map((m) => m.eventSeq)).toEqual(
      full.json.matches.map((m) => m.eventSeq),
    );
    const dir = await search([undefined], { file: "src" });
    expect(dir.json.totalMatches).toBe(0);
  });

  test("the --file help text states the rule with an example", () => {
    const fileOption = searchCommand.options?.find((o) => o.flags.includes("--file"));
    expect(fileOption?.description).toContain("whole trailing path segments");
    expect(fileOption?.description).toContain(
      "session-session.md matches docs/spec/session-session.md",
    );
  });
});

describe("adjacent duplicate collapse", () => {
  test("a strict run renders once in search with ×N, first member's timestamp and locator", async () => {
    const { human, json } = await search(["DUPRUN"]);
    expect(json.totalMatches).toBe(1);
    const match = json.matches[0]!;
    expect(match.eventSeq).toBe(4);
    expect(match.memberSeqs).toEqual([4, 5, 6]);
    expect(match.timestamp).toBe("2026-07-15T10:01:00Z");
    expect(match.locator.sourceCursor).toBe("line:4");
    expect(human).toContain("×3");
    expect(human).toContain("1 matches.");
  });

  test("identical events split by an intervening event do not collapse, under any --filter", async () => {
    const plain = await search(["TWINSEP"]);
    expect(plain.json.totalMatches).toBe(2);
    // The intervening system event is filtered out of the match slice,
    // but adjacency is a fact of the Session: still no collapse.
    const filtered = await search(["TWINSEP"], { filter: ["user"] });
    expect(filtered.json.totalMatches).toBe(2);
    expect(filtered.json.matches.map((m) => m.eventSeq)).toEqual([8, 10]);
  });

  test("the timeline shows a run once at its first member and counts logical events", async () => {
    const { human, json } = await view([dupSessionId]);
    const viewJson = json as unknown as ViewJson;
    expect(viewJson.totalEvents).toBe(9);
    expect(viewJson.maxSeq).toBe(12);
    expect(viewJson.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 7, 8, 9, 10, 11]);
    expect(viewJson.events.find((e) => e.seq === 4)?.memberSeqs).toEqual([4, 5, 6]);
    expect(human).toContain("×3");
    expect(human).toContain("×2");
  });

  test("file-touch listing collapses a run of identical touch events", async () => {
    const { human, json } = await search([undefined], { file: "dup-target.ts" });
    const runMatch = json.matches.find((m) => m.sessionId === dupSessionId && m.eventSeq === 11);
    expect(runMatch?.memberSeqs).toEqual([11, 12]);
    expect(human).toContain("×2");
  });
});

describe("logical windowing", () => {
  test("--from into the middle of a run shows the whole run", async () => {
    const { json } = await view([dupSessionId], { from: "5" });
    expect((json as unknown as ViewJson).events[0]?.seq).toBe(4);
  });

  test("a capped listing resumes at the last run's last member plus one", async () => {
    const { human, json } = await view([dupSessionId], { limit: "4" });
    expect((json as unknown as ViewJson).events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(human).toContain("continue with --from 7");
    const next = await view([dupSessionId], { from: "7" });
    expect((next.json as unknown as ViewJson).events[0]?.seq).toBe(7);
  });

  test("--tail counts runs", async () => {
    const { json } = await view([dupSessionId], { tail: "3" });
    expect((json as unknown as ViewJson).events.map((e) => e.seq)).toEqual([9, 10, 11]);
  });
});

describe("--seq addresses source events", () => {
  test("a mid-run member renders whole and states its run membership", async () => {
    const { human, json } = await view([dupSessionId], { seq: "5" });
    const event = (json as { event: Record<string, unknown> }).event;
    expect(event["seq"]).toBe(5);
    expect(event["text"]).toBe("DUPRUN alpha alpha");
    expect(event["run"]).toEqual({ firstSeq: 4, lastSeq: 6, count: 3, memberIndex: 2 });
    expect(human).toContain("member 2 of 3");
    expect(human).toContain("#4–#6");
  });

  test("a singleton event carries no run note; a missing sequence stays NOT_FOUND", async () => {
    const { human, json } = await view([dupSessionId], { seq: "7" });
    expect((json as { event: Record<string, unknown> }).event["run"]).toBeUndefined();
    expect(human).not.toContain("collapsed duplicate run");
    await expect(view([dupSessionId], { seq: "13" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("search context lines", () => {
  test("-C renders unfiltered neighbors as context, matches marked distinctly", async () => {
    const { human, json } = await search(["TWINSEP"], { filter: ["user"], context: "1" });
    // Matches carry the » mark; context lines do not.
    expect(human).toContain("» #8 ");
    expect(human).toContain("» #10");
    // The system event between the twins is context even under --filter user.
    expect(human).toContain("SYSNOTE between twins");
    const match8 = json.matches.find((m) => m.eventSeq === 8)!;
    expect(match8.context?.map((c) => c.seq)).toEqual([7, 9]);
    // Context entries carry the shared renderer's line and a locator.
    expect(match8.context?.[0]?.line).toBe("SEPARATOR one");
    expect(match8.context?.[0]?.locator.sourceCursor).toBe("line:7");
    // An event shown as a match never repeats as context.
    const match10 = json.matches.find((m) => m.eventSeq === 10)!;
    expect(match10.context?.map((c) => c.seq)).toEqual([9, 11]);
    // Overlapping windows render an event once in the human output.
    expect(human.split("SYSNOTE between twins")).toHaveLength(2);
  });

  test("context lines are logical events and never count toward --limit", async () => {
    const { human, json } = await search(["TWINSEP"], { limit: "1", context: "2" });
    expect(json.totalMatches).toBe(2);
    expect(json.matches).toHaveLength(1);
    expect(human).toContain("1 of 2 matches shown");
    // The matching event beyond --limit renders as plain unmarked context.
    expect(human).toContain("  #10");
    expect(human).not.toContain("» #10");
    // A collapsed run reached by a window is one neighbor, marked ×3 in
    // the human output with its member sequences in the JSON entry.
    expect(human).toContain("×3");
    const runContext = json.matches[0]!.context!.find((c) => c.seq === 4)!;
    expect(runContext.memberSeqs).toEqual([4, 5, 6]);
  });

  test("the context JSON line is byte-identical to the human rendering", async () => {
    const { human, json } = await search(["TWINSEP"], { context: "1" });
    const contextEntry = json.matches.flatMap((m) => m.context ?? []).find((c) => c.seq === 7)!;
    const humanLine = human.split("\n").find((l) => l.includes("#7 "))!;
    expect(humanLine.endsWith(`  ${contextEntry.line}`)).toBeTrue();
  });

  test("--context 0 keeps today's unprefixed output; a negative value is USAGE", async () => {
    const { human } = await search(["TWINSEP"]);
    expect(human).not.toMatch(/^» /m);
    await expect(search(["TWINSEP"], { context: "-1" })).rejects.toMatchObject({ code: "USAGE" });
  });
});

describe("--sort", () => {
  test("time orders Session groups oldest-first, all-null Sessions last, deterministically", async () => {
    const first = await search(["SORTTOKEN"], { sort: "time" });
    const order = first.json.matches.map((m) => m.sessionId);
    const uniqueOrder = [...new Set(order)];
    expect(uniqueOrder).toEqual([
      sessionIdOf({ harnessId: "claude-code", sourceSessionId: "sort-b" }),
      sessionIdOf({ harnessId: "claude-code", sourceSessionId: "sort-a" }),
      sortNullSessionId,
    ]);
    const again = await search(["SORTTOKEN"], { sort: "time" });
    expect(again.json.matches.map((m) => m.sessionId)).toEqual(order);
    expect(first.json.parameters["sort"]).toBe("time");
  });

  test("time applies to --file-only searches; relevance stays the default; unknown mode is USAGE", async () => {
    const touches = await search([undefined], { file: "dup-target.ts", sort: "time" });
    expect(touches.json.parameters["sort"]).toBe("time");
    const plain = await search(["SORTTOKEN"]);
    expect(plain.json.parameters["sort"]).toBe("relevance");
    await expect(search(["SORTTOKEN"], { sort: "density" })).rejects.toMatchObject({
      code: "USAGE",
    });
  });
});

describe("session list", () => {
  test("shows event time ranges, orders by latest event time, and falls back honestly", async () => {
    const outcome = await listCommand.run(ctx, [], {});
    const json = outcome.json as {
      totalSessions: number;
      sessions: { sessionId: string; firstTimestamp: string | null }[];
    };
    const ids = json.sessions.map((r) => r.sessionId);
    const sortA = sessionIdOf({ harnessId: "claude-code", sourceSessionId: "sort-a" });
    const sortB = sessionIdOf({ harnessId: "claude-code", sourceSessionId: "sort-b" });
    // sort-a's Session ran latest (2026-07-16); it outranks Sessions whose
    // Sessions ended earlier, whatever order acceptance happened in.
    expect(ids.indexOf(sortA)).toBeLessThan(ids.indexOf(dupSessionId));
    expect(ids.indexOf(dupSessionId)).toBeLessThan(ids.indexOf(sortB));
    // The timestamp-free Session groups under the placeholder, never a date.
    const lines = outcome.human.split("\n");
    const headerAbove = (at: number) =>
      lines.slice(0, at).findLast((l) => l !== "" && !l.startsWith(" "));
    const nullAt = lines.findIndex((l) => l.trim().startsWith(sortNullSessionId));
    expect(lines[nullAt]).toContain("2 events");
    expect(headerAbove(nullAt)).toBe("no event timestamps");
    expect(lines[0]).toStartWith(`${json.totalSessions} session(s),`);
    // A dated Session groups under its Session's last date, not its
    // acceptance date, and carries an earlier Session start on its own row.
    const datedAt = lines.findIndex((l) => l.trim().startsWith(sortA));
    expect(headerAbove(datedAt)).toBe("2026-07-16");
    expect(lines[datedAt]).toContain("from 2026-07-15");
  });

  test("each row carries the Session Label, dimmed only when colors are on", async () => {
    const outcome = await listCommand.run(ctx, [], {});
    const sortA = sessionIdOf({ harnessId: "claude-code", sourceSessionId: "sort-a" });
    const json = outcome.json as { sessions: { sessionId: string; label: string | null }[] };
    const labelled = json.sessions.find((r) => r.sessionId === sortA)!;
    // sort-a sessions no title, so its Label is the Session's own opening
    // user message — read from evidence, never generated.
    expect(labelled.label).toBe("opening question for sort-a");
    expect(outcome.human).toContain("opening question for sort-a");
    expect(outcome.human).not.toContain("\x1b[2m");
    const colored = await listCommand.run({ ...ctx, colors: true }, [], {});
    expect(colored.human).toContain("\x1b[2mopening question for sort-a");
  });

  test("a Harness-provided title outranks the opening user message", async () => {
    const outcome = await listCommand.run(ctx, [], {});
    const json = outcome.json as {
      sessions: { sessionId: string; label: string | null; labelSource: string | null }[];
    };
    const titled = json.sessions.find(
      (r) => r.sessionId === sessionIdOf({ harnessId: "claude-code", sourceSessionId: "titled" }),
    )!;
    expect(titled).toMatchObject({ label: "Custom session title", labelSource: "custom_title" });
    // The Harness-injected user line is the Harness speaking, never a Label.
    const injected = json.sessions.find(
      (r) =>
        r.sessionId === sessionIdOf({ harnessId: "claude-code", sourceSessionId: "meta-first" }),
    )!;
    expect(injected).toMatchObject({ label: "the real first prompt", labelSource: "user_message" });
  });

  test("--limit bounds the listing and reports the true total; non-positive is USAGE", async () => {
    const outcome = await listCommand.run(ctx, [], { limit: "2" });
    const json = outcome.json as { totalSessions: number; sessions: unknown[] };
    expect(json.sessions).toHaveLength(2);
    expect(json.totalSessions).toBeGreaterThan(2);
    expect(outcome.human).toContain(`2 of ${json.totalSessions} session(s) shown`);
    await expect(listCommand.run(ctx, [], { limit: "0" })).rejects.toMatchObject({
      code: "USAGE",
    });
    await expect(listCommand.run(ctx, [], { limit: "nope" })).rejects.toMatchObject({
      code: "USAGE",
    });
  });
});

describe("candidate discovery, bounded", () => {
  beforeAll(async () => {
    const cwd = env.worktree;
    // A pending candidate (no Opening Path), an out-of-scope one, and an
    // ignored one join the already-imported associated candidates.
    await writeCodexSession(env.codexHome, { sessionId: "cand-pending", cwd: null });
    await mkdir(join(env.root, "elsewhere", "other-project"), { recursive: true });
    await writeClaudeSession(env.claudeHome, {
      sessionId: "cand-outside",
      cwd: join(env.root, "elsewhere", "other-project"),
    });
    await writeClaudeSession(env.claudeHome, { sessionId: "cand-ignored", cwd });
    const state = await readDiscoveryState(project.paths.discoveryFile);
    state.ignored.push(
      candidateIdOf({ harnessId: "claude-code", sourceSessionId: "cand-ignored" }),
    );
    await writeDiscoveryState(project.paths.discoveryFile, state);
  });

  async function candidates(options: Record<string, unknown> = {}) {
    const outcome = await candidatesCommand.run(ctx, [], options);
    return {
      human: outcome.human,
      json: outcome.json as {
        counts: Record<string, number>;
        totalCandidates: number;
        candidates: { candidateId: string; classification: { kind: string } }[];
        parameters: Record<string, unknown>;
      },
    };
  }

  test("the JSON document leads with the tally; entries order actionable-first", async () => {
    const { human, json } = await candidates();
    expect(Object.keys(json)[0]).toBe("counts");
    expect(json.counts["pending"]).toBe(1);
    expect(json.counts["out_of_scope"]).toBe(1);
    expect(json.counts["ignored"]).toBe(1);
    expect(json.counts["associated"]).toBeGreaterThan(3);
    expect(json.counts["flagged"]).toBe(0);
    expect(json.candidates[0]?.classification.kind).toBe("pending");
    const kinds = json.candidates.map((c) => c.classification.kind);
    expect(kinds.indexOf("out_of_scope")).toBeGreaterThan(kinds.lastIndexOf("associated"));
    expect(kinds.indexOf("ignored")).toBeGreaterThan(kinds.indexOf("out_of_scope"));
    expect(human).toContain("candidate(s):");
  });

  test("human rows show status, session time, label, and candidate id", async () => {
    const { human, json } = await candidates();
    const row = human.split("\n").find((l) => l.startsWith("pending"))!;
    expect(row).toMatch(/^pending\s+\d{2}-\d{2} \d{2}:\d{2}  /);
    expect(row).toContain("add retry logic to the sync loop");
    expect(row).toContain(candidateIdOf({ harnessId: "codex", sourceSessionId: "cand-pending" }));
    expect(row).not.toContain("(codex cand-pending)");
    const entry = json.candidates.find((c) => c.classification.kind === "pending") as unknown as {
      label: string;
    };
    expect(entry.label).toBe("add retry logic to the sync loop");
  });

  test("--status filters with union semantics using the document's own spellings", async () => {
    const pendingOnly = await candidates({ status: ["pending"] });
    expect(pendingOnly.json.totalCandidates).toBe(1);
    expect(pendingOnly.json.candidates[0]?.classification.kind).toBe("pending");
    expect(pendingOnly.human).toContain("pending ");
    const union = await candidates({ status: ["pending", "out_of_scope"] });
    expect(union.json.totalCandidates).toBe(2);
    expect(union.human).toContain("out_of_scope ");
    const flagged = await candidates({ status: ["flagged"] });
    expect(flagged.json.totalCandidates).toBe(0);
    await expect(candidates({ status: ["bogus"] })).rejects.toMatchObject({ code: "USAGE" });
  });

  test("--limit caps entries with the true total; --all removes the bound; both together is USAGE", async () => {
    const capped = await candidates({ limit: "1" });
    expect(capped.json.candidates).toHaveLength(1);
    expect(capped.json.totalCandidates).toBeGreaterThan(1);
    expect(capped.human).toContain("entries capped at 1 of");
    const all = await candidates({ all: true });
    expect(all.json.candidates).toHaveLength(all.json.totalCandidates);
    await expect(candidates({ all: true, limit: "3" })).rejects.toMatchObject({ code: "USAGE" });
    await expect(candidates({ limit: "0" })).rejects.toMatchObject({ code: "USAGE" });
  });
});

describe("reading stays read-only", () => {
  test("search with context and sort never commits to the Store", async () => {
    const store = new ProjectStore(project.paths.storeDir);
    const before = await store.head();
    await search(["TWINSEP"], { context: "2", sort: "time" });
    await search([undefined], { file: "dup-target.ts", sort: "time" });
    await view([dupSessionId], { seq: "5" });
    await listCommand.run(ctx, [], {});
    expect(await store.head()).toBe(before);
  });
});
