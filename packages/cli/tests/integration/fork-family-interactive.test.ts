import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setDefaultTimeout,
  test,
} from "bun:test";
import { join } from "node:path";
import {
  FAKE_KEY,
  initProject,
  makeTestEnv,
  writeClaudeSession,
  type TestEnv,
} from "../helpers.ts";
import type { CommandRunContext, LoadedProject } from "../../src/core/session-module.ts";
import { runImport } from "../../src/session/domain/import.ts";
import { importCommand } from "../../src/session/commands/import.ts";
import { acceptCommand } from "../../src/session/commands/accept.ts";
import { sessionIdOf } from "../../src/session/domain/identity.ts";
import { readSessionMeta } from "../../src/session/storage/store-layout.ts";

// The interactive flagged-Candidate prompt is interactive-only, so this
// file mocks @clack/prompts. It is isolated here — the mock is
// process-wide — and the real module is restored after the file runs.
setDefaultTimeout(60_000);

const realClack = { ...(await import("@clack/prompts")) };
const CANCEL = Symbol("cancelled");
let selectMessages: string[] = [];
let selectAnswers: string[] = [];
let confirmMessages: string[] = [];
let confirmAnswers: boolean[] = [];

mock.module("@clack/prompts", () => ({
  ...realClack,
  select: async (options: { message: string }) => {
    selectMessages.push(options.message);
    return selectAnswers.shift() ?? "skip";
  },
  confirm: async (options: { message: string }) => {
    confirmMessages.push(options.message);
    return confirmAnswers.shift() ?? false;
  },
  spinner: () => ({ start: () => {}, stop: () => {} }),
  isCancel: (value: unknown) => value === CANCEL || realClack.isCancel(value as never),
}));

afterAll(() => {
  mock.module("@clack/prompts", () => realClack);
});

let testEnv: TestEnv;
let project: LoadedProject;

beforeEach(async () => {
  testEnv = await makeTestEnv();
  project = await initProject(testEnv);
  selectMessages = [];
  selectAnswers = [];
  confirmMessages = [];
  confirmAnswers = [];
});

afterEach(async () => {
  await testEnv.cleanup();
});

function interactiveCtx(): CommandRunContext {
  return { project, env: testEnv.env, jsonMode: false, inputDisabled: false };
}

async function copiedTwin(
  originSessionId: string,
  twinSessionId: string,
  stripOpeningPath = false,
): Promise<{ dir: string; copied: string[] }> {
  const dir = join(testEnv.claudeHome, "projects", testEnv.worktree.replaceAll("/", "-"));
  const source = await Bun.file(join(dir, `${originSessionId}.jsonl`)).text();
  const copied = source
    .trim()
    .split("\n")
    .map((line) => {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      parsed["sessionId"] = twinSessionId;
      if (stripOpeningPath) delete parsed["cwd"];
      return JSON.stringify(parsed);
    });
  return { dir, copied };
}

describe("interactive session import family hint", () => {
  test("the fork-family note renders before a flagged Candidate's decision prompt", async () => {
    const cwd = testEnv.worktree;
    await writeClaudeSession(testEnv.claudeHome, {
      sessionId: "flag-origin",
      cwd,
      userText: "FLAGPROBE shared prefix",
    });
    await runImport(project, testEnv.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });

    // A fork twin whose unique suffix carries a suspected secret: copied
    // prefix lines keep identifiers, timestamps, and messages; only the
    // envelope's session id is rewritten.
    const { dir, copied } = await copiedTwin("flag-origin", "flag-twin");
    const suffix = JSON.stringify({
      type: "user",
      uuid: "flag-twin-secret",
      sessionId: "flag-twin",
      cwd,
      timestamp: "2026-07-15T11:00:00Z",
      message: { role: "user", content: `my key is ${FAKE_KEY}` },
    });
    await Bun.write(join(dir, "flag-twin.jsonl"), [...copied, suffix].join("\n") + "\n");

    const outcome = await importCommand.run(interactiveCtx(), [], {});
    const report = outcome.json as { flagged: unknown[]; accepted: unknown[] };
    // "skip" keeps the Candidate flagged; the hint never becomes a gate.
    expect(report.flagged).toHaveLength(1);
    expect(report.accepted).toHaveLength(0);
    expect(selectMessages).toHaveLength(1);
    expect(selectMessages[0]).toContain("(fork family)");
    // The twin's secret suffix keeps it short of full containment, and the
    // stored origin is named by its Label alongside its ID.
    expect(selectMessages[0]).toMatch(
      /shares \d+ of \d+ events with “FLAGPROBE shared prefix” ses_.*… \(fork family\)/,
    );
    // The note renders before the decision prompt.
    expect(selectMessages[0]!.indexOf("(fork family)")).toBeLessThan(
      selectMessages[0]!.indexOf("Accept anyway?"),
    );
  });

  test("session accept shows the family hint before confirmation and Store mutation", async () => {
    await writeClaudeSession(testEnv.claudeHome, {
      sessionId: "accept-origin",
      cwd: testEnv.worktree,
      userText: "ACCEPTPREVIEW shared prefix",
    });
    await runImport(project, testEnv.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });
    const { dir, copied } = await copiedTwin("accept-origin", "accept-twin");
    await Bun.write(join(dir, "accept-twin.jsonl"), copied.join("\n") + "\n");
    const twinId = sessionIdOf({
      harnessId: "claude-code",
      sourceSessionId: "accept-twin",
    });

    confirmAnswers = [false];
    await expect(acceptCommand.run(interactiveCtx(), [twinId], {})).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(confirmMessages).toHaveLength(1);
    expect(confirmMessages[0]).toContain("(fork family)");
    expect(confirmMessages[0]!.indexOf("(fork family)")).toBeLessThan(
      confirmMessages[0]!.indexOf("Accept this Candidate?"),
    );
    expect(await readSessionMeta(project.paths.storeDir, twinId)).toBeNull();

    confirmAnswers = [true];
    const accepted = await acceptCommand.run(interactiveCtx(), [twinId], {});
    expect((accepted.json as { accepted: unknown[] }).accepted).toHaveLength(1);
  });

  test("pending interactive import shows the family hint before association", async () => {
    await writeClaudeSession(testEnv.claudeHome, {
      sessionId: "pending-origin",
      cwd: testEnv.worktree,
      userText: "PENDINGPREVIEW shared prefix",
    });
    await runImport(project, testEnv.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });
    const { dir, copied } = await copiedTwin("pending-origin", "pending-twin", true);
    await Bun.write(join(dir, "pending-twin.jsonl"), copied.join("\n") + "\n");

    const outcome = await importCommand.run(interactiveCtx(), [], {});
    const report = outcome.json as { pending: unknown[]; accepted: unknown[] };
    expect(report.pending).toHaveLength(1);
    expect(report.accepted).toHaveLength(0);
    expect(selectMessages).toHaveLength(1);
    expect(selectMessages[0]).toContain("(fork family)");
    expect(selectMessages[0]!.indexOf("(fork family)")).toBeLessThan(
      selectMessages[0]!.indexOf("Associate it with this project?"),
    );
  });

  test("associating a pending Candidate keeps the secret gate; its flagged prompt follows", async () => {
    await writeClaudeSession(testEnv.claudeHome, {
      sessionId: "gate-origin",
      cwd: testEnv.worktree,
      userText: "GATEPROBE shared prefix",
    });
    await runImport(project, testEnv.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });

    // A pending fork twin (no opening path) whose unique suffix carries a
    // suspected secret: association alone must not accept the bytes.
    const { dir, copied } = await copiedTwin("gate-origin", "gate-twin", true);
    const suffix = JSON.stringify({
      type: "user",
      uuid: "gate-twin-secret",
      sessionId: "gate-twin",
      timestamp: "2026-07-15T11:00:00Z",
      message: { role: "user", content: `my key is ${FAKE_KEY}` },
    });
    await Bun.write(join(dir, "gate-twin.jsonl"), [...copied, suffix].join("\n") + "\n");
    const twinId = sessionIdOf({ harnessId: "claude-code", sourceSessionId: "gate-twin" });

    // Associate at the pending prompt, then decide later at the flagged one.
    selectAnswers = ["associate"];
    const outcome = await importCommand.run(interactiveCtx(), [], {});
    const report = outcome.json as { pending: unknown[]; flagged: unknown[]; accepted: unknown[] };
    expect(selectMessages).toHaveLength(2);
    expect(selectMessages[0]).toContain("Associate it with this project?");
    expect(selectMessages[1]).toContain("Accept anyway?");
    expect(report.pending).toHaveLength(0);
    expect(report.flagged).toHaveLength(1);
    expect(report.accepted).toHaveLength(0);
    expect(await readSessionMeta(project.paths.storeDir, twinId)).toBeNull();

    // The next interactive import re-presents the flagged Candidate;
    // accepting sessions the override in the Session's metadata.
    selectMessages = [];
    selectAnswers = ["accept"];
    const second = await importCommand.run(interactiveCtx(), [], {});
    const secondReport = second.json as {
      flagged: unknown[];
      accepted: { sessionId: string; flaggedRules: string[] }[];
    };
    expect(selectMessages).toHaveLength(1);
    expect(secondReport.flagged).toHaveLength(0);
    expect(secondReport.accepted).toHaveLength(1);
    expect(secondReport.accepted[0]!.flaggedRules).toContain("anthropic-api-key");
    const meta = await readSessionMeta(project.paths.storeDir, twinId);
    expect(meta?.secretDetectionOverride?.ruleIds).toContain("anthropic-api-key");
  });
});
