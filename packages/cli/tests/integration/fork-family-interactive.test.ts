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
  writeCodexSession,
  type TestEnv,
} from "../helpers.ts";
import type { CommandRunContext, LoadedProject } from "../../src/core/session-module.ts";
import { readDiscoveryState } from "../../src/session/domain/discovery-state.ts";
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

describe("interactive glia import family hint", () => {
  test("import prompts only for flagged Candidates and preserves their family hints", async () => {
    const cwd = testEnv.worktree;
    await writeClaudeSession(testEnv.claudeHome, {
      sessionId: "flag-origin",
      cwd,
      userText: "FLAGPROBE shared prefix",
    });
    await writeClaudeSession(testEnv.claudeHome, {
      sessionId: "pending-origin",
      cwd,
      userText: "PENDINGPREVIEW shared prefix",
    });
    await runImport(project, testEnv.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });

    // A fork twin whose unique suffix carries a suspected secret: copied
    // prefix lines keep identifiers, timestamps, and messages; only the
    // envelope's session id is rewritten.
    const flagTwin = await copiedTwin("flag-origin", "flag-twin");
    const suffix = JSON.stringify({
      type: "user",
      uuid: "flag-twin-secret",
      sessionId: "flag-twin",
      cwd,
      timestamp: "2026-07-15T11:00:00Z",
      message: { role: "user", content: `my key is ${FAKE_KEY}` },
    });
    await Bun.write(
      join(flagTwin.dir, "flag-twin.jsonl"),
      [...flagTwin.copied, suffix].join("\n") + "\n",
    );
    // A second fork twin with its opening path stripped stays pending
    // without an association prompt.
    const pendingTwin = await copiedTwin("pending-origin", "pending-twin", true);
    await Bun.write(
      join(pendingTwin.dir, "pending-twin.jsonl"),
      pendingTwin.copied.join("\n") + "\n",
    );

    // The flagged prompt defaults to skip; the pending Candidate needs no decision.
    const outcome = await importCommand.run(interactiveCtx(), [], {});
    const report = outcome.json as { flagged: unknown[]; pending: unknown[]; accepted: unknown[] };
    expect(report.flagged).toHaveLength(1);
    expect(report.pending).toHaveLength(1);
    expect(report.accepted).toHaveLength(0);
    expect(selectMessages).toHaveLength(1);

    const flaggedPrompt = selectMessages.find((m) => m.includes("Accept anyway?"))!;
    // The twin's secret suffix keeps it short of full containment, and the
    // stored origin is named by its Label alongside its ID.
    expect(flaggedPrompt).toMatch(
      /shares \d+ of \d+ events with “FLAGPROBE shared prefix” ses_.*… \(fork family\)/,
    );
    // The note renders before each decision question.
    expect(flaggedPrompt.indexOf("(fork family)")).toBeLessThan(
      flaggedPrompt.indexOf("Accept anyway?"),
    );
    expect(outcome.human).toContain("Skipped 1 Session(s) whose Project could not be determined");
    expect(outcome.human).toContain("glia accept --interactive");

    selectMessages = [];
    selectAnswers = ["accept"];
    const second = await importCommand.run(interactiveCtx(), [], {});
    const accepted = second.json as { accepted: { flaggedRules: string[] }[]; pending: unknown[] };
    expect(selectMessages).toHaveLength(1);
    expect(accepted.accepted).toHaveLength(1);
    expect(accepted.accepted[0]!.flaggedRules).toContain("anthropic-api-key");
    expect(accepted.pending).toHaveLength(1);
  });

  test("explicitly accepting a pending Candidate shows its family hint before Store mutation", async () => {
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
    const { dir, copied } = await copiedTwin("accept-origin", "accept-twin", true);
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
    expect((await readSessionMeta(project.paths.storeDir, twinId))?.association.mode).toBe(
      "explicit",
    );
  });

  test("interactive import skips missing and absent opening paths without blocking current-project work", async () => {
    await writeClaudeSession(testEnv.claudeHome, {
      sessionId: "current-project",
      cwd: testEnv.worktree,
    });
    const missingPath = await writeClaudeSession(testEnv.claudeHome, {
      sessionId: "vanished-project",
      cwd: join(testEnv.root, "missing-project"),
      userText: `old project credential ${FAKE_KEY}`,
    });
    const noPath = await writeCodexSession(testEnv.codexHome, {
      sessionId: "99999999-2222-3333-4444-555555555555",
      cwd: null,
    });
    const originals = await Promise.all([missingPath, noPath].map((path) => Bun.file(path).text()));
    for (let run = 0; run < 2; run++) {
      const outcome = await importCommand.run(interactiveCtx(), [], {});
      const report = outcome.json as {
        pending: unknown[];
        flagged: unknown[];
        accepted: unknown[];
      };
      expect(report.accepted).toHaveLength(run === 0 ? 1 : 0);
      expect(report.pending).toHaveLength(2);
      expect(report.flagged).toHaveLength(0);
      expect(selectMessages).toEqual([]);
      expect(confirmMessages).toEqual([]);
      expect(outcome.human).toContain("Skipped 2 Session(s) whose Project could not be determined");
      expect(outcome.human).toContain("glia accept --interactive");
    }
    expect(await Promise.all([missingPath, noPath].map((path) => Bun.file(path).text()))).toEqual(
      originals,
    );
    const discovery = await readDiscoveryState(project.paths.discoveryFile);
    expect(discovery.associations).toEqual({});
    expect(discovery.ignored).toEqual([]);
  });
});
