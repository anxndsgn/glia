# CLAUDE.md

This file provides guidance to agents when working with code in this repository.

## What Glia is

Glia captures coding-agent Sessions (Claude Code and Codex transcripts), preserves their source evidence in a local Git-backed Store under `~/.glia` (override with `GLIA_HOME`), and makes them searchable offline. It is a Bun workspace with one package: `packages/cli` (`@glia/cli`).

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
  - Import automation lives in `core/hooks` and `core/commands/{hook,setup}.ts`: conservative JSON hook merging, positive-identity removal, the machine-global liveness stamp, atomically replaced Project report, and size-capped run log. `core/project/load.ts` exposes a separate read-only existing-Binding resolver for hook mode; never replace it with the normal lazy-realization path.
  - Project Binding lifecycle lives in `core/commands/project.ts`: `project list` is machine-scoped and side-effect free, while `project forget` and `project bind` serialize on the machine-global Bindings lease. Roots admit SessionEnd capture; roots and aliases both claim historical Sessions. An alias-only worktree must be promoted explicitly with `project bind` before a realizing command may run there.

- **`src/session`** — the built-in Session vertical implementing that contract; its verbs (`import`, `accept`, `list`, `search`, `view`, `delete`, …) are registered flat at the CLI root by `src/cli.ts`.
  - `adapters/` — one `SessionHarnessAdapter` per source harness (`claude-code`, `codex`), registered in `adapters/index.ts`. Adapters discover source sessions, capture them into bundles, and normalize events. Source-native quirks (fork/resume behavior, session-ID semantics) are documented in each adapter's header comment.
  - `domain/` — discovery/classification of candidates, import/accept (gated by secret detection; overrides are persisted in session meta), conflict layout and resolution, deletion with tombstones and a replicated ledger, fork-family hints via shared event identity.
    - Freshness visibility is derived in `domain/advisories.ts`. Withheld evaluations preserve `firstFlaggedAt` across continuous re-evaluation. Only an unfiltered full-discovery import may prune a missing evaluation, failed/unavailable Harnesses are exempt, and pruned withheld identities move to the capped machine-local loss record.
  - `storage/` — the Store layout: `session/sessions/<sessionId>/{session.json, bundle/…}` (`store-layout.ts`).
  - Subagents relate to a Session in two different ways, and the harnesses differ: a Claude Code subagent transcript is _evidence inside its parent_ (captured to `bundle/source/subagents/agent-<agentId>.jsonl`, with the optional `agent-<agentId>.meta.json` sidecar naming its `agentType`; never its own Session), while a Codex subagent is _its own Session_ carrying an optional `subagent` origin in its meta. The relation is display-only — it is deliberately never fed into `continuation`, which would pull subagents into Fork Families. A parent is never inferred; a source that states none leaves it unknown, and because kind and parent are both optional, subagent _presence_ is recorded in its own right rather than read off their nulls. The shared path/payload contract lives in `adapters/subagent.ts`; note that sidecars share the subagent path prefix but are not transcripts, so counts and projection use `isSubagentTranscriptPath`.
  - `projection/` — a **disposable** SQLite FTS5 view rebuilt from the Store head (`projection/build.ts`, published atomically via pointer file in `projection/publish.ts`). SQLite schema and paths are private; the public contract is typed CLI results and evidence locators. Bump `PROJECTION_VERSION` in `projection/schema.ts` whenever adapter normalization or the projection schema changes.

Write flow: adapter captures source bytes → domain accepts a Revision into the Store worktree → one Git commit → projection rebuild (deferred on failure; next query rebuilds). Sync is the only networked operation.

## Conventions

- Domain nouns are capitalized deliberately in prose and comments (Session, Store, Project, Replica, Binding, Revision, Source Identity) — keep that convention.
- Every command supports global `--json` and `--no-input`; interactive prompts (`@clack/prompts`) must be skippable and JSON output must remain a single versioned document.
- `import --hook` is the deliberate output exception: it rejects `--json`, self-detaches unless `GLIA_HOOK_FOREGROUND=1`, never realizes an unbound Project, and routes all results/errors to machine-local run state. Keep the installed command line stable.
- Hook installation targets Claude Code's user `settings.json` and Codex's user `hooks.json`, respects `CLAUDE_CONFIG_DIR`/`CODEX_HOME`, preserves foreign JSON bytes, and removes only the exact Glia-managed shape (binary path may differ).
- Errors are `GliaError` with a stable code and `nextSteps`; convert unknowns with `toGliaError`.
- Tests live in `packages/cli/tests/{unit,integration,blackbox}`; integration tests exercise real Stores in temp dirs via `tests/helpers.ts`.
- `scripts/build.ts` injects build provenance as compile-time defines; a dirty working tree gets a `-dirty` commit suffix — don't circumvent that.
