# CLAUDE.md

This file provides guidance to agents when working with code in this repository.

## What Glia is

Glia searches native coding-agent Sessions (Claude Code and Codex transcripts) offline, merged with optional preserved evidence in a local Git-backed Store under `~/.glia` (override with `GLIA_HOME`). Import persists evidence; remote sync transfers only saved content. It is a Bun workspace with one package: `packages/cli` (`@glia/cli`).

## Commands

```sh
bun install
bun run typecheck          # tsc --noEmit in packages/cli
bun test                   # all tests
bun test tests/integration/import.test.ts   # one file (run from packages/cli)
bun test tests/integration/import-automation.test.ts tests/integration/setup.test.ts
bun test -t "pattern"      # filter by test name
bun run build              # compiles release binary to packages/cli/dist/glia
bun run dev:cli -- <cmd>   # run the CLI from source, e.g. bun run dev:cli -- import
bun run fmt                # oxfmt (fmt:check to verify)
```

Requires Bun ≥ 1.3 with SQLite FTS5 support, and Git.

## Architecture

Two layers inside `packages/cli/src`, joined by the module contract in `src/core/session-module.ts` (`SessionModule` interface — commands, projection rebuild, conflict/merge/deletion hooks):

- **`src/core`** — harness-agnostic infrastructure. Project resolution and lazy creation (`core/project`: worktree → projectId binding, replica identity, paths under `~/.glia/projects/<projectId>/{store,state,cache}`), the Git-backed `ProjectStore` (`core/store/store.ts`; Git is an internal mechanism, the working tree holds the Current Revision and history keeps earlier Revisions), the sync engine (`core/store/sync.ts`: fetch/classify/merge with the declared remote, deletion ledger reconciliation, history rewriting for purges), the writer lease (`core/store/lease.ts`, serializes all Store writes), config (`core/config`: `glia.json` declaration — only `store remote set` writes it), output rendering (`core/output`: every command returns a `CommandOutcome` rendered as human text or exactly one versioned `--json` document), and secret detection (`core/security`).
  - Project entry separates query caches from persistence. `loadProjectForRead` returns an enrolled Project or a deterministic read identity without creating a Store/Binding. `project/scope.ts` groups worktrees by their local common Git directory; ordinary directories use containment. Explicit Bindings win. Reads can search local sources even when a declared remote Store has not yet been synced. Mutations use `loadProject`.
  - Setup installs the global skill only. `import` saves once; `import --auto-save on|off` controls a machine-local Project setting in `state/auto-save.json`. Enabling installs SessionEnd hooks. Hooks resolve only an existing admitted Project, require its opt-in, and recheck it under the writer lease before accepting evidence. Roots in the same local repository share the opt-in; aliases remain historical only.
  - Project Binding lifecycle lives in `core/commands/project.ts`: `project list` is machine-scoped and side-effect free, while `project forget`, `project bind`, and `project adopt` serialize on the machine-global Bindings lease. Roots admit opted-in SessionEnd capture; roots and aliases both claim historical Sessions. An alias-only worktree must be promoted explicitly with `project bind` before a realizing command may run there. When a worktree's `glia.json` declares a different Project than its local Binding, `project adopt` locally merges the bound Project's Sessions, tombstones, archive markers, and Candidate associations into the declared Project, then promotes the worktree to a root. It never contacts the remote; `--delete-old` removes the old Project only when it has no other Bindings.

- **`src/session`** — the built-in Session vertical implementing that contract; its verbs (`import`, `accept`, `list`, `search`, `view`, `delete`, …) are registered flat at the CLI root by `src/cli.ts`.
  - `adapters/` — one `SessionHarnessAdapter` per source harness (`claude-code`, `codex`), registered in `adapters/index.ts`. Adapters discover source sessions, capture them into bundles, and normalize events. Source-native quirks (fork/resume behavior, session-ID semantics) are documented in each adapter's header comment.
  - `domain/` — discovery/classification of candidates, import/accept (gated by secret detection; overrides are persisted in session meta), conflict layout and resolution, deletion with tombstones and a replicated ledger, fork-family hints via shared event identity.
    - Freshness visibility is derived in `domain/advisories.ts`. Withheld evaluations preserve `firstFlaggedAt` across continuous re-evaluation. Only an unfiltered full-discovery import may prune a missing evaluation, failed/unavailable Harnesses are exempt, and pruned withheld identities move to the capped machine-local loss record.
  - `storage/` — the Store layout: `session/sessions/<sessionId>/{session.json, bundle/…}` (`store-layout.ts`).
  - Subagents relate to a Session in two different ways, and the harnesses differ: a Claude Code subagent transcript is _evidence inside its parent_ (captured to `bundle/source/subagents/agent-<agentId>.jsonl`, with the optional `agent-<agentId>.meta.json` sidecar naming its `agentType`; never its own Session), while a Codex subagent is _its own Session_ carrying an optional `subagent` origin in its meta. The relation is display-only — it is deliberately never fed into `continuation`, which would pull subagents into Fork Families. A parent is never inferred; a source that states none leaves it unknown, and because kind and parent are both optional, subagent _presence_ is recorded in its own right rather than read off their nulls. The shared path/payload contract lives in `adapters/subagent.ts`; note that sidecars share the subagent path prefix but are not transcripts, so counts and projection use `isSubagentTranscriptPath`.
  - `projection/` — **disposable** SQLite FTS5 views. `publish.ts` maintains the Store-only projection. `readable.ts` merges native evidence with saved evidence in `~/.glia/cache/reads`; it reuses unchanged Sessions, normalizes changed captures through shared `build.ts` code, deletes temporary raw captures, and pins a SQLite read transaction before releasing writer leases. Lock order is Project writer → machine read-cache writer. Native source loss removes unsaved query entries. `projection.sources` describes selected evidence and saved digests; `partial/issues` describes incomplete reads. `--saved` selects Store-only evidence and `view --revision` verifies a citation. Local forgetting lives in payload-free `state/forgotten` exclusions, serialized with final import acceptance, and all deletion paths purge read caches. SQLite schema and paths are private; the public contract is typed CLI results and evidence locators. Bump `PROJECTION_VERSION` in `projection/schema.ts` whenever adapter normalization or the projection schema changes.

Write flow: adapter captures source bytes → domain accepts a Revision into the Store worktree → one Git commit → projection rebuild (deferred on failure; next query rebuilds). Sync is the only networked operation.

## Conventions

- Domain nouns are capitalized deliberately in prose and comments (Session, Store, Project, Replica, Binding, Revision, Source Identity) — keep that convention.
- Every command supports global `--json` and `--no-input`; interactive prompts (`@clack/prompts`) must be skippable and JSON output must remain a single versioned document.
- JSON economy is "absent means default": the listing/timeline verbs (`search`, `list`, `view`) omit default-valued fields — null, `archiveState: "active"`, `associationMode: "inferred"`, a zero count, empty `text`/`line`, a singleton `memberSeqs`, the per-item `revisionDigest` — from the per-item objects whose count scales with the result set. The default a key's absence stands for is that field's own default, never a blanket falsy: `subagentId` is omitted only when null, because `""` is meaningful subagent evidence (`query.ts`'s `SubagentEvidence`). Identity and citation (`sessionId`, `eventSeq`, `harnessId`, `locator`) and timestamps are never omitted, once-per-document content (the envelope, the `view` Session header) is exempt, and `show` is the full-fidelity surface that recovers anything absent. Omission is by construction at each verb's serialization boundary, never a recursive null-stripper; a new listing verb inherits the same rule, and the bundled skill document (`packages/cli/assets/SKILL.md`) is where the contract is stated for agent consumers.
- `search --compact --json` may replace flat matches with lossless Session groups when their serialized UTF-8 payload is smaller. Shared identity, locator source files, and context windows follow the inheritance contract in `packages/cli/assets/SKILL.md`; expanding them must reproduce every flat-result field and its order. Search selection, excerpts, and the default JSON layout stay identical.
- `import --hook` is the deliberate output exception: it rejects `--json`, self-detaches unless `GLIA_HOOK_FOREGROUND=1`, never realizes an unbound Project and requires explicit automatic-saving opt-in, and routes all results/errors to machine-local run state. Keep the installed command line stable.
- `project adopt` is one-way and idempotent: it accepts the committed `glia.json` declaration, never edits that file, and merges local state before rebinding the worktree.
- Hook installation targets Claude Code's user `settings.json` and Codex's user `hooks.json`, respects `CLAUDE_CONFIG_DIR`/`CODEX_HOME`, preserves foreign JSON bytes, and removes only the exact Glia-managed shape (binary path may differ).
- Errors are `GliaError` with a stable code and `nextSteps`; convert unknowns with `toGliaError`.
- Tests live in `packages/cli/tests/{unit,integration,blackbox}`; integration tests exercise real Stores in temp dirs via `tests/helpers.ts`.
- `scripts/build.ts` injects build provenance as compile-time defines; a dirty working tree gets a `-dirty` commit suffix — don't circumvent that.
- Use conventional commits like `feat(scope):`, `fix(scope):`.
- Don't add backward-compatibility shims, migration paths, or deprecated aliases unless explicitly requested — prefer clean breaks.
- Spec files are gitignored and discarded once implemented — treat the codebase, not specs, as the source of truth.
