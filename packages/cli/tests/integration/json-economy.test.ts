/**
 * "Absent means default": the listing and timeline verbs (`search`, `list`,
 * `view`) omit default-valued fields from the per-item objects whose count
 * scales with the result set, while `show` stays the full-fidelity surface.
 * These tests assert exactly which keys appear on each per-item object.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { runImport } from "../../src/session/domain/import.ts";
import { candidateIdOf, sessionIdOf } from "../../src/session/domain/identity.ts";
import { archiveCommand } from "../../src/session/commands/archive.ts";
import { acceptCommand } from "../../src/session/commands/accept.ts";
import { listCommand } from "../../src/session/commands/list.ts";
import { searchCommand } from "../../src/session/commands/search.ts";
import { showCommand } from "../../src/session/commands/show.ts";
import { viewCommand } from "../../src/session/commands/view.ts";
import type { CommandRunContext, LoadedProject } from "../../src/core/session-module.ts";
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

const recId = (sourceSessionId: string): string =>
  sessionIdOf({ harnessId: "claude-code", sourceSessionId });

const plainId = recId("econ-plain");
const archivedId = recId("econ-archived");
const runId = recId("econ-run");
const pendingId = sessionIdOf({ harnessId: "codex", sourceSessionId: "econ-pending" });

type Entry = Record<string, unknown>;

function userLine(sessionId: string, ts: string, text: string, uuid?: string): unknown {
  return {
    type: "user",
    uuid: uuid ?? `${sessionId}-${ts}-${text}`,
    sessionId,
    cwd: env.worktree,
    timestamp: ts,
    message: { role: "user", content: text },
  };
}

async function writeRawSession(sessionId: string, lines: unknown[]): Promise<void> {
  const dir = join(env.claudeHome, "projects", env.worktree.replaceAll("/", "-"));
  await mkdir(dir, { recursive: true });
  await Bun.write(
    dir + `/${sessionId}.jsonl`,
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
}

async function list(options: Record<string, unknown> = {}): Promise<Entry[]> {
  const outcome = await listCommand.run(ctx, [], options);
  return (outcome.json as { sessions: Entry[] }).sessions;
}

async function search(
  args: (string | undefined)[],
  options: Record<string, unknown> = {},
): Promise<{ json: Record<string, unknown>; matches: Entry[]; human: string }> {
  const outcome = await searchCommand.run(ctx, args, options);
  const json = outcome.json as Record<string, unknown>;
  return { json, matches: json["matches"] as Entry[], human: outcome.human ?? "" };
}

beforeAll(async () => {
  env = await makeTestEnv();
  project = await initProject(env);
  ctx = { project, env: env.env, jsonMode: false, inputDisabled: true };

  // An ordinary Session: active, no continuation, no subagent, one Label.
  await writeRawSession("econ-plain", [
    userLine("econ-plain", "2026-07-15T10:00:00Z", "ECONPROBE ordinary opening"),
    // A tool-call-only assistant turn: the Harness attested tools and no
    // text at all, so the timeline event has nothing to say in `text`.
    {
      type: "assistant",
      uuid: "econ-plain-a1",
      sessionId: "econ-plain",
      cwd: env.worktree,
      timestamp: "2026-07-15T10:00:05Z",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/tmp/econ.ts" } },
        ],
      },
    },
  ]);
  // An Archived Session, and a Session holding a collapsed duplicate run.
  await writeRawSession("econ-archived", [
    userLine("econ-archived", "2026-07-15T11:00:00Z", "ECONPROBE archived opening"),
  ]);
  await writeRawSession("econ-run", [
    userLine("econ-run", "2026-07-15T12:00:00Z", "ECONPROBE run opening"),
    userLine("econ-run", "2026-07-15T12:01:00Z", "ECONRUN twin", "econ-run-t1"),
    userLine("econ-run", "2026-07-15T12:01:01Z", "ECONRUN twin", "econ-run-t2"),
    userLine("econ-run", "2026-07-15T12:02:00Z", "ECONPROBE run closing"),
  ]);
  // A Candidate with no Opening Path: only an explicit user decision
  // associates it, which is the one non-default `associationMode`.
  await writeCodexSession(env.codexHome, { sessionId: "econ-pending", cwd: null });

  await runImport(project, env.env, { harness: null, dryRun: false, onlyCandidateIds: null });
  await acceptCommand.run(
    ctx,
    [candidateIdOf({ harnessId: "codex", sourceSessionId: "econ-pending" })],
    { yes: true },
  );
  await archiveCommand.run(ctx, [archivedId], { yes: true });
});

afterAll(async () => {
  await env.cleanup();
});

describe("list omits defaults", () => {
  test("an ordinary entry carries identity, size, and timestamps and nothing default", async () => {
    const plain = (await list()).find((s) => s["sessionId"] === plainId)!;
    expect(Object.keys(plain).sort()).toEqual([
      "acceptedAt",
      "eventCount",
      "firstTimestamp",
      "harnessId",
      "label",
      "labelSeq",
      "labelSource",
      "lastTimestamp",
      "openingPath",
      "sessionId",
      "sourceSessionId",
    ]);
    // Identity, size, and both timestamps are stated whatever their value.
    expect(plain).toMatchObject({
      sessionId: plainId,
      harnessId: "claude-code",
      eventCount: 2,
      label: "ECONPROBE ordinary opening",
    });
    expect(plain["firstTimestamp"]).toBe("2026-07-15T10:00:00Z");
  });

  test("the digest, the nulls, and the constant states are gone", async () => {
    const plain = (await list()).find((s) => s["sessionId"] === plainId)!;
    for (const key of [
      "revisionDigest",
      "family",
      "continuationParent",
      "subagentKind",
      "subagentParent",
      "subagentParentSession",
      "subagentOrigin",
      "subagentCount",
      "archiveState",
      "associationMode",
    ]) {
      expect(plain[key]).toBeUndefined();
    }
  });

  test("an archived Session and an explicit association are distinguishable by presence", async () => {
    const entries = await list({ includeArchived: true });
    const archived = entries.find((s) => s["sessionId"] === archivedId)!;
    expect(archived["archiveState"]).toBe("archived");
    const pending = entries.find((s) => s["sessionId"] === pendingId)!;
    expect(pending["associationMode"]).toBe("explicit");
    // The pending Candidate had no Opening Path, so that null is absent too.
    expect(pending["openingPath"]).toBeUndefined();
  });

  test("a continuation states its parent; omission never swallows a stated value", async () => {
    await writeClaudeSession(env.claudeHome, {
      sessionId: "econ-continuation",
      cwd: env.worktree,
      parentSessionId: "econ-plain",
      userText: "ECONPROBE resumed from an earlier Session",
    });
    await runImport(project, env.env, { harness: null, dryRun: false, onlyCandidateIds: null });
    const entry = (await list()).find((s) => s["sessionId"] === recId("econ-continuation"))!;
    expect(entry["continuationParent"]).toBe("econ-plain");
  });

  test("a Session without a Label omits the field like any other null", async () => {
    await writeRawSession("econ-unlabelled", [
      {
        type: "assistant",
        uuid: "econ-unlabelled-a1",
        sessionId: "econ-unlabelled",
        cwd: env.worktree,
        timestamp: "2026-07-15T13:00:00Z",
        message: { role: "assistant", content: [{ type: "text", text: "no user turn at all" }] },
      },
    ]);
    await runImport(project, env.env, { harness: null, dryRun: false, onlyCandidateIds: null });
    const unlabelled = (await list()).find((s) => s["sessionId"] === recId("econ-unlabelled"))!;
    expect(unlabelled["label"]).toBeUndefined();
    expect(unlabelled["labelSource"]).toBeUndefined();
    expect(unlabelled["labelSeq"]).toBeUndefined();
    expect(unlabelled["eventCount"]).toBe(1);
  });
});

describe("search omits defaults", () => {
  test("a match keeps its identity and citation and drops the digest", async () => {
    const { matches } = await search(["ECONPROBE"]);
    const match = matches.find((m) => m["sessionId"] === plainId)!;
    expect(Object.keys(match).sort()).toEqual([
      "eventKind",
      "eventSeq",
      "excerpt",
      "harnessId",
      "locator",
      "role",
      "sessionId",
      "timestamp",
    ]);
    expect(match["revisionDigest"]).toBeUndefined();
    expect(match["role"]).toBe("user");
    expect(match["memberSeqs"]).toBeUndefined();
    expect(match["archiveState"]).toBeUndefined();
    expect(match["subagentId"]).toBeUndefined();
    expect(match["subagentType"]).toBeUndefined();
  });

  test("archiveState appears exactly on an archived match", async () => {
    const included = await search(["ECONPROBE"], { includeArchived: true });
    const archived = included.matches.find((m) => m["sessionId"] === archivedId)!;
    expect(archived["archiveState"]).toBe("archived");
    expect(
      included.matches.find((m) => m["sessionId"] === plainId)!["archiveState"],
    ).toBeUndefined();
  });

  test("memberSeqs appears exactly on a collapsed run, and the excerpt is unchanged", async () => {
    const { matches, human } = await search(["ECONRUN"]);
    expect(matches).toHaveLength(1);
    expect(matches[0]!["memberSeqs"]).toEqual([2, 3]);
    expect(matches[0]!["excerpt"]).toBe("«ECONRUN» twin");
    expect(human).toContain("×2");
  });

  test("a -C context entry omits a singleton memberSeqs and keeps seq and locator", async () => {
    const { matches } = await search(["ECONRUN"], { context: "1" });
    const context = matches[0]!["context"] as Entry[];
    expect(context.map((c) => c["seq"])).toEqual([1, 4]);
    for (const entry of context) {
      expect(Object.keys(entry).sort()).toEqual(["line", "locator", "seq"]);
      expect(entry["memberSeqs"]).toBeUndefined();
    }
  });

  test("a file-touch match omits its nulls and keeps operation, path, and locator", async () => {
    const { matches } = await search([undefined], { file: "econ.ts" });
    expect(matches).toHaveLength(1);
    const match = matches[0]!;
    expect(match).toMatchObject({ sessionId: plainId, operation: "read" });
    expect(match["locator"]).toBeDefined();
    expect(match["revisionDigest"]).toBeUndefined();
    expect(match["subagentId"]).toBeUndefined();
  });

  test("a successful search carries no advisories; the envelope stays put", async () => {
    const { json } = await search(["ECONPROBE"]);
    expect(json["advisories"]).toBeUndefined();
    expect(json["totalMatches"]).toBeGreaterThan(0);
    expect(json["projection"]).toBeDefined();
    expect(json["parameters"]).toBeDefined();
  });
});

describe("view omits defaults in the timeline only", () => {
  test("a singleton event omits memberSeqs; an event with no text omits text", async () => {
    const outcome = await viewCommand.run(ctx, [plainId], { all: true });
    const events = (outcome.json as { events: Entry[] }).events;
    expect(events.map((e) => e["seq"])).toEqual([1, 2]);
    expect(events[0]!["text"]).toBe("ECONPROBE ordinary opening");
    expect(events[0]!["memberSeqs"]).toBeUndefined();
    // The tool call attested its names and carried no text of its own.
    expect(events[1]!["toolNames"]).toEqual(["Read"]);
    expect(events[1]!["text"]).toBeUndefined();
  });

  test("a collapsed run keeps its full member range", async () => {
    const outcome = await viewCommand.run(ctx, [runId], { all: true });
    const events = (outcome.json as { events: Entry[] }).events;
    expect(events.find((e) => e["seq"] === 2)!["memberSeqs"]).toEqual([2, 3]);
  });

  test("the Session header is exempt: once per document, every field intact", async () => {
    const outcome = await viewCommand.run(ctx, [plainId], { all: true });
    const header = (outcome.json as { session: Entry }).session;
    expect(header["revisionDigest"]).toMatch(/^[0-9a-f]{64}$/);
    expect(header["continuationParent"]).toBeNull();
    expect(header["archiveState"]).toBe("active");
    expect(header["subagent"]).toMatchObject({ isSubagent: false, kind: null });
  });
});

describe("show stays the full-fidelity surface", () => {
  test("the detail verb still carries the digest and the null-valued metadata", async () => {
    const outcome = await showCommand.run(ctx, [plainId], {});
    const json = outcome.json as { session: Entry };
    expect(json.session["revisionDigest"]).toMatch(/^[0-9a-f]{64}$/);
    expect(json.session["continuationParent"]).toBeNull();
    expect(json.session["archiveState"]).toBe("active");
  });
});
