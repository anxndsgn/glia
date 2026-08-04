---
name: glia
description: Search and read locally preserved coding-agent Sessions (Claude Code and Codex transcripts) with the glia CLI. Use when the user asks what a past session did, why a change was made, what an earlier agent run decided, or when evidence from previous sessions would help. Also covers importing, archiving, deleting, and syncing Sessions when the user explicitly asks for those operations.
metadata:
  glia_version: __GLIA_VERSION__
---

# Glia — query preserved coding-agent Sessions

Glia captures complete coding-agent Sessions (Claude Code and Codex transcripts), preserves their source evidence in a local Git-backed Store under `~/.glia`, and makes them searchable offline. Nothing touches the network except `glia sync`.

## When to use

- The user asks what happened in a past session, why an earlier change was made, or what a previous agent run did.
- You need evidence about past decisions, commands, errors, or file changes that predate the current conversation.
- The user explicitly asks to import, archive, delete, export, or sync Sessions (write operations — see the rules below).

## Ground rules

1. **Always pass `--json`.** Every command emits exactly one versioned JSON document on stdout: `{"formatVersion": 1, "command": ..., "ok": true, "result": ...}` on success, or `{"ok": false, "error": {"code", "message", "details"}}` on failure. When an error carries `details.nextSteps`, those are the exact follow-up commands to run.
2. **Run inside the project's Git worktree.** Glia resolves the Project from the current directory; outside a worktree it fails with `NOT_A_GIT_WORKTREE`.
3. **Absent means default.** The listing and timeline verbs — `search`, `list`, `view` — omit default-valued fields from their per-item objects (each `list` entry, each `search` match and `-C` context entry, each `view` event). A missing key means the default: `null` for anything nullable, an unarchived Session (`archiveState: "active"`), an inferred association, a zero count, empty `text`/`line`, or a `memberSeqs` holding only the item's own sequence. Identity and citation are never omitted — a match always carries `sessionId`, `eventSeq`, `harnessId`, and its `locator`, and both timestamps always appear on a `list` entry even when null. Provenance is presence-based: a match carries `subagentId` exactly when it came from a subagent transcript, so **absent `subagentId` means the parent's own transcript, and `subagentId: ""` means a subagent whose agent the source did not name** — never read the absent key as the empty string. These verbs also drop the per-item `revisionDigest`; **`show` is the full-fidelity surface** and emits every field, digest included, so nothing is unrecoverable — just absent from the cheap path. (The envelope and the `view` Session header are once-per-document and unchanged.)
4. **Query freely; write only on explicit instruction.** `search`, `list`, `show`, `view`, `candidates`, `conflicts`, `tombstones`, and `status` never change the Store. Never run `import`, `accept`, `delete`, `archive`, `unarchive`, `resolve`, `sync`, or `store remote set` unless the user asked for that specific operation.

## Query workflows (primary)

### Find evidence: `glia search`

```sh
glia --json search "authentication failure"          # text query; terms match as substrings
glia --json search --file session-layout.ts          # Sessions that touched a file
glia --json search "retry" --filter toolcall --since 2026-07-01 -C 2
```

Key options:

- `--filter <value>` (repeatable, values union): `user`, `agent`, `toolcall`, `toolcall:<name>`, `toolresult`, `message`, `lifecycle`, `system`, `unknown`, `subagent`.
- `--file <path>`: matches a touched path exactly, or as whole trailing path segments (`session-layout.ts` matches `src/storage/session-layout.ts`).
- `--since <iso>`: events at or after an ISO 8601 date or timestamp.
- `-C, --context <n>`: neighboring events around each match; `--per-session <n>` and `--limit <n>` widen result windows; `--sort relevance|time`; `--include-archived` adds Archived Sessions.

Each JSON match carries `sessionId`, `eventSeq`, and a `locator` (`{sourceFile, sourceCursor}`) pointing into the Session's captured source bundle — cite it when quoting evidence. Text-query results (`"mode": "text"`) add an `excerpt`; `--file`-only results (`"mode": "file_touches"`) carry the touch's `operation` and `sourcePath` instead. Matches can come from subagent transcripts inside a parent Session; those carry `subagentId` (and `subagentType` when the source named the agent), and `--filter subagent` slices to exactly that evidence.

### Read a Session: `glia list`, `glia show`, `glia view`

```sh
glia --json list --limit 20                 # accepted Sessions, newest first
glia --json show <session-id>               # one Session's metadata: harness, times, fork family, subagents
glia --json view <session-id> --tail 50     # event timeline in source order
glia --json view <session-id> --seq 120     # one event rendered in full (detail mode)
```

`view` accepts the same `--filter` vocabulary plus `--from <seq>`, `--tail <n>`, `--all`. Prefer `view --from`/`--seq` over opening Store files directly — the timeline is the readable rendering of the same evidence.

Typical loop: `search` to find matching events → `view --seq <n>` (or `--from <n>` with `--tail`) to read the full context → cite the Session ID and locator.

If a search returns zero matches, inspect `result.advisories` before concluding that no evidence exists. Relay every advisory to the user: how many Candidates are importable, how many are pending Project association, and how many are withheld (including the oldest `oldestFirstFlaggedAt` and any retention warning). Ask whether the user wants to run an import. **Do not run `import` yourself:** even a zero-result search or an importable advisory is diagnosis, not consent.

### Discover what could be imported: `glia candidates`

```sh
glia --json candidates                      # classify current source sessions; never mutates the Store
```

### Project health: `glia status`

```sh
glia --json status                          # Project, Store, Binding, Session counts, projection freshness
```

## Write operations (explicit user request only)

- `glia import` — discover and accept Candidates into the Store; `--dry-run` previews, `--harness codex|claude-code` narrows. Acceptance is gated by Secret Detection; flagged Candidates need interactive review or explicit `accept`.
- `glia accept <candidate-id> --yes` — accept specific Candidates reported by `candidates`.
- `glia archive <session-id> --yes` / `glia unarchive <session-id> --yes` — hide from / restore to default queries without changing evidence.
- `glia delete <session-id> --yes` — permanent, writes a tombstone to the replicated Deletion Ledger, and propagates on sync. Confirm intent with the user before running.
- `glia conflicts` / `glia resolve <session-id> --revision <digest>` — list frozen Sessions and promote one candidate Revision.
- `glia export <session-id> --output <dir>` — write one Session to a stable public directory format.
- `glia sync` — the only networked command; synchronizes the Store with its declared remote (`glia store remote show` to inspect, `store remote set <url>` to declare).

## Troubleshooting

- `STORE_NOT_REALIZED`: the Project declares a remote but has no local Store yet — run `glia sync` first.
- `NOT_A_GIT_WORKTREE`: run glia from inside the project repository.
- `INPUT_REQUIRED`: the command wanted a confirmation while input was disabled — re-run with the suggested flag (usually `--yes`).
- Query results include `result.projection` with the Store commit; `"stale": true` means the projection is rebuilding — re-run the query to get the fresh view.
- `status` reports machine-global and Project-local hook liveness. If the machine stamp is `null`/`never`, the SessionEnd hooks have never fired (or have not been trusted); ask the user to run `glia setup` and approve the hook in each Harness. If the machine stamp is current but the Project stamp is absent, no Session has ended in this Project since setup.
- Withheld advisories mean Secret Detection kept source bytes out of the Store. Relay the count, age, and retention warning; accepting flagged bytes remains the user's explicit decision.
- Any error's `details.nextSteps` lists the exact commands to recover with; follow them before improvising.
