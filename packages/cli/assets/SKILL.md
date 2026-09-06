---
name: glia
description: Search and read local and saved coding-agent Sessions (Claude Code and Codex transcripts) with the glia CLI. Use when the user asks what a past session did, why a change was made, what an earlier agent run decided, or when evidence from previous sessions would help. Also covers importing, archiving, deleting, and syncing Sessions when the user explicitly asks for those operations.
metadata:
  glia_version: __GLIA_VERSION__
---

# Glia — query coding-agent Sessions

Glia searches Claude Code and Codex Sessions directly from their local source locations, merged with any saved Store evidence. Import is optional persistence; remote sync transfers only saved content. SQLite under `~/.glia` is a disposable cache. Nothing touches the network except `glia sync`.

## When to use

- The user asks what happened in a past session, why an earlier change was made, or what a previous agent run did.
- You need evidence about past decisions, commands, errors, or file changes that predate the current conversation.
- The user explicitly asks to import, archive, delete, export, or sync Sessions (write operations — see the rules below).

## Ground rules

1. **Always pass `--json`.** Every command emits exactly one versioned JSON document on stdout: `{"formatVersion": 1, "command": ..., "ok": true, "result": ...}` on success, or `{"ok": false, "error": {"code", "message", "details", "nextSteps"}}` on failure. When an error's `nextSteps` is non-empty, those are the exact follow-up commands to run.
2. **Run in the target Project directory.** Git worktrees of the same local repository share search scope, subject to explicit Bindings. Independent clones remain separate. In ordinary directories, scope covers Sessions opened in the current directory or its descendants.
3. **Absent means default.** The listing and timeline verbs — `search`, `list`, `view` — omit default-valued fields from their per-item objects (each `list` entry, each `search` match and `-C` context entry, each `view` event). A missing key means the default: `null` for anything nullable, an unarchived Session (`archiveState: "active"`), an inferred association, a zero count, empty `text`/`line`, or a `memberSeqs` holding only the item's own sequence. Identity and citation are never omitted — a match always carries `sessionId`, `eventSeq`, `harnessId`, and its `locator`, and both timestamps always appear on a `list` entry even when null. Provenance is presence-based: a match carries `subagentId` exactly when it came from a subagent transcript, so **absent `subagentId` means the parent's own transcript, and `subagentId: ""` means a subagent whose agent the source did not name** — never read the absent key as the empty string. These verbs also drop the per-item `revisionDigest`; **`show` is the full-fidelity surface** and emits every field, digest included, so nothing is unrecoverable — just absent from the cheap path. (The envelope and the `view` Session header are once-per-document and unchanged.)
4. **Query freely; write only on explicit instruction.** `search`, `list`, `show`, `view`, `candidates`, `conflicts`, `tombstones`, and `status` never change the Store. Never run `import`, `accept`, `delete`, `archive`, `unarchive`, `resolve`, `sync`, or `store remote set` unless the user asked for that specific operation.

## Query workflows (primary)

### Find evidence: `glia search`

```sh
glia --json search "authentication failure" --compact # text query; terms match as substrings
glia --json search auth --word --compact               # whole words only: skips authored/authorization
glia --json search --file auth.ts --compact            # Sessions that touched a file
glia --json search "retry" --compact --filter toolcall --since 2026-07-01 -C 2
```

Key options:

- `--compact` (requires `--json`): prefer this for agent searches. It selects a smaller grouped representation when shared fields and overlapping context save output bytes; otherwise it returns the ordinary flat `matches`. Token savings depend on the tokenizer and query. Decode grouped output as described below before citing it.
- `--word`: terms match only at word boundaries (ASCII letters, digits, `_`), so a short term stops hitting every identifier containing it; CJK terms keep substring matching. Reach for it whenever a plain query drowns in token-family noise.
- `--filter <value>` (repeatable, values union): `user`, `agent`, `toolcall`, `toolcall:<name>`, `toolresult`, `message`, `lifecycle`, `system`, `unknown`, `subagent`.
- `--file <path>`: matches a touched path exactly, or as whole trailing path segments (`auth.ts` matches `src/lib/auth.ts`).
- `--since <iso>`: events at or after an ISO 8601 date or timestamp.
- `-C, --context <n>`: neighboring events around each match; `--per-session <n>` and `--limit <n>` widen result windows; `--sort relevance|time`; `--include-archived` adds Archived Sessions.

Each JSON match carries `sessionId`, `eventSeq`, and a `locator` (`{sourceFile, sourceCursor}`) pointing into the Session's selected evidence — cite it when quoting evidence. `result.projection.sources[sessionId]` states `source` (`local` or `store`), `saved`, `revisionDigest`, `savedRevisionDigest`, and `savedVersionBehind`. For local evidence, its `files` map resolves each locator's `sourceFile` to the actual Harness file. Text-query results (`"mode": "text"`) add an `excerpt`; `--file`-only results (`"mode": "file_touches"`) carry the touch's `operation` and `sourcePath` instead. Matches can come from subagent transcripts inside a parent Session; those carry `subagentId` (and `subagentType` when the source named the agent), and `--filter subagent` slices to exactly that evidence.

With `--compact`, check `result.layout`. When it is `"grouped"`, read `result.groups` instead of `result.matches`: each group supplies `sessionId`, `harnessId`, and optional `archiveState` to its `matches`. Each match's `locator` inherits `sourceFile` from the group unless it states its own override (for example a subagent transcript); `sourceCursor` and `sourceEventId` stay on the locator. A match's `contextSeqs` selects its neighboring events from that group's shared `context` array by `seq`, in the stated order. Context locators inherit `sourceFile` in the same way. All remaining fields and their absence defaults are identical to flat output. This representation preserves every match, timestamp, excerpt, provenance field, and citation; use the inherited Session ID and event sequence with `view --seq` for full evidence.

### Read a Session: `glia list`, `glia show`, `glia view`

```sh
glia --json list --limit 20                 # local and saved Sessions, newest first
glia --json show <session-id>               # one Session's metadata: harness, times, fork family, subagents
glia --json view <session-id> --tail 50     # event timeline in source order
glia --json view <session-id> --seq 120 --revision <digest> # full event at the cited revision
glia --json view <session-id> --saved       # explicitly read the saved snapshot
```

`view` accepts the same `--filter` vocabulary plus `--from <seq>`, `--tail <n>`, `--all`. Prefer `view --from`/`--seq` over opening Store files directly — the timeline is the readable rendering of the same evidence.

Typical loop: `search` → read `projection.sources[sessionId].revisionDigest` → `view --seq <n> --revision <digest>` → cite the Session ID and locator. A revision mismatch means the source changed: repeat the search, or explicitly read its saved version. `--saved` is available on search, list, show, and view. Local evidence remains searchable while the source exists; saving makes it survive source cleanup.

Check `result.projection.partial` before treating a zero-match search as complete. When true, relay `issues`: sources may be unreadable, malformed, changing, or a declared remote Store may not be synchronized locally. A zero-match native search does not require import. Use `candidates` for unresolved Project associations; use `--saved` when the question specifically concerns preserved records.

### Discover what could be imported: `glia candidates`

```sh
glia --json candidates                      # classify current source sessions; never mutates the Store
```

### Project health: `glia status`

```sh
glia --json status                          # Project, Store, Binding, Session counts, projection freshness
```

## Write operations (explicit user request only)

- `glia import` — save existing Candidates once; `--dry-run` previews, `--harness codex|claude-code` narrows. Acceptance is gated by Secret Detection; flagged Candidates need interactive review or explicit `accept`.
- `glia import --auto-save on|off` — `on` saves now and installs hooks for future saving; `off` disables future saving without importing. This Project setting applies only to the current machine, including its worktrees, and stays independent of remote sync.
- `glia accept <candidate-id> --yes` — accept specific Candidates reported by `candidates`.
- `glia archive <session-id> --yes` / `glia unarchive <session-id> --yes` — hide from / restore to default queries without changing evidence.
- `glia delete <session-id> --yes` — forget a Session, excluding it from search and automatic import while retaining Harness files. Saved evidence is purged with a replicated tombstone; unsaved evidence gets a local exclusion. Execute only with user authorization.
- `glia conflicts` / `glia resolve <session-id> --revision <digest>` — list frozen Sessions and promote one candidate Revision.
- `glia export <session-id> --output <dir>` — write one Session to a stable public directory format.
- `glia sync` — the only networked command; synchronizes the Store with its declared remote (`glia store remote show` to inspect, `store remote set <url>` to declare).

## Troubleshooting

- `STORE_NOT_REALIZED`: the Project declares a remote but has no local Store yet — run `glia sync` first.
- `NOT_ENROLLED`: a Store-only operation such as export needs preserved evidence. Search, list, show, and view work before enrollment. Request persistence only when the user needs it.
- `INPUT_REQUIRED`: the command wanted a confirmation while input was disabled — re-run with the suggested flag (usually `--yes`).
- Query results include `result.projection` with the Store commit (empty when none exists), per-Session sources, and completeness. `stale: true` means a saved projection lags the Store; repeat the query to retry rebuilding it.
- `status` reports `autoSave` and machine/Project hook liveness. When automatic saving is off, absent hook activity is expected. When enabled, check hook installation and Harness trust; `glia import --auto-save on` refreshes the installed executable path.
- Withheld advisories mean Secret Detection kept source bytes out of the Store. Relay the count, age, and retention warning; accepting flagged bytes remains the user's explicit decision.
- Any error's `nextSteps` lists the exact commands to recover with; follow them before improvising.
