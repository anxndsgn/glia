# Glia

Glia searches coding-agent Sessions directly on your machine. Import Sessions to preserve them in a local Git-backed Store; add a remote when you need synchronization.

It supports Claude Code and Codex source Sessions. Import, query, archive, deletion, conflict resolution, export, and synchronization are built in.

## Requirements

- Bun 1.3 or newer
- Git
- A Bun runtime with SQLite FTS5 support
- Run `npx skills add anxndsgn/skills` to install the development skills

## Development

```sh
bun install
bun run typecheck
bun test
bun run build
```

Run the source CLI with `bun run dev:cli -- <command>`.

## First use

Install the bundled agent skill once per machine, then search immediately:

```sh
glia setup
glia list
glia search "authentication failure"
glia view <session-id>
```

Setup installs the global skill for Claude Code and Codex. Searching requires no
import or Project enrollment. It discovers Sessions in the Harness source
locations and builds a disposable SQLite cache under `~/.glia/cache/reads`.
Changed Sessions are re-indexed when queried, including Sessions still in progress.
Search, list, show, and view merge local sources with saved Sessions and deduplicate
by Source Identity. Searches never write to the Store or contact a remote.

The default scope is the current Project. Worktrees of the same local Git repository
share scope; independent clones do not merge merely because their remotes match.
Explicit Bindings take priority. Outside Git, the current directory and its descendants
claim Sessions whose recorded opening directory falls inside that scope.

Save existing Sessions when you want them to survive Harness cleanup:

```sh
glia import                        # Save existing Sessions once
glia import --auto-save on         # Save now and enable future automatic saving
glia import --auto-save off        # Stop automatic saving; retain saved Sessions
```

Automatic saving is a separate, machine-local Project setting, off by default.
Enabling it installs SessionEnd hooks for present Harnesses; approve them when
Claude Code or Codex prompts. The setting covers the Project's local worktrees
(or its ordinary-directory scope) and does not propagate through the remote.
A plain import leaves this setting unchanged. After moving the Glia executable,
run `glia import --auto-save on` again to refresh its hook command.

Import saves Sessions associated with the current Project. Sessions whose Project
cannot be determined remain pending and are summarized without per-Session prompts.
Review them later with `glia candidates --status pending`, then associate and save
selected Sessions with `glia accept <id>` or `glia accept --interactive`.

The first interactive import previews persistence and secret checks before creating
the Project's local Store. `--json` and `--no-input` are non-interactive. Glia writes
`glia.json` into the code directory only when `store remote set` is explicitly run.
Use `glia status` to inspect the automatic-saving setting and hook liveness.

Query JSON includes `projection.sources`, keyed by visible Session ID. It states
whether evidence comes from `local` or `store`, whether a saved version exists,
and the selected and saved revision digests. `savedVersionBehind` identifies a
saved snapshot that differs from the selected local version. Local `files` map
bundle-relative evidence locators to actual Harness paths. Unsaved Sessions have
no acceptance timestamp. Human output labels unsaved or changed local evidence.

Use `--saved` with search, list, show, or view to read only preserved Store evidence.
For citations, use `view <id> --seq <n> --revision <digest>` with the digest returned
by search; a changed revision fails explicitly rather than silently changing the
citation. A saved superset is preferred over an older, shorter local copy.

Source failures and malformed records produce `projection.partial: true` with
`issues`, even when there are zero matches. A missing remote Store is also reported
as partial while local search remains available. Unsaved cache entries disappear
from queries when their source disappears; the cache is not a preservation service.

Inspect and manage machine-local Bindings from any directory:

```sh
glia project list
glia project forget <path>
glia project bind <project-id> [path]
glia project bind <project-id> <historical-path> --alias
glia project adopt [path] [--delete-old]
```

`project forget` removes only the Binding; its Store and Sessions remain. A root
admits SessionEnd capture when automatic saving is enabled; an alias claims
historical Sessions without enabling capture at that path. If a worktree's `glia.json` declares a different
Project than its local Binding, `project adopt` accepts the declaration, merges
the locally bound Sessions and metadata into the declared Project, and promotes
the worktree to a capturing root. The merge is local; run `glia sync` afterwards
when a remote is declared. Use `--delete-old` (or confirm interactively) to remove
the old Project only when it has no other Bindings. Use `project list` to find
rootless Projects, missing checkout paths, and Stores that have not yet been
synced locally.

To share the Store, declare a credential-free Git remote:

```sh
glia store remote set <url> --yes
glia sync
```

`store remote set` is the only command that writes `glia.json`. Network access occurs only during `glia sync`; a fresh checkout with a declaration bootstraps its local Store on the first sync. Sync transfers saved content only and never imports local Sessions or enables automatic saving.

## Commands

Session commands are flat: `import`, `candidates`, `accept`, `list`, `show`, `search`, `view`, `export`, `conflicts`, `resolve`, `delete`, `tombstones`, `archive`, and `unarchive`.

In JSON, the listing and timeline verbs — `search`, `list`, and `view` — read
as "absent means default": a per-item field holding its default value (null,
an empty string, an unarchived Session, an inferred association, a zero count,
a single-member sequence range) is omitted, and those verbs carry no per-item
`revisionDigest`. Identity and citation — `sessionId`, `eventSeq`,
`harnessId`, and the `locator` — always appear, the envelope and the `view`
Session header are unchanged, and `show` remains the full-fidelity surface
that emits every field.

Use `glia --json search "retry" --compact -C 2` to reduce repeated metadata
and overlapping context. When grouping saves bytes, `result.layout: "grouped"`
selects Session groups with inherited identity and source files; otherwise
the result keeps the flat layout. Both preserve the same evidence. See the
[agent decoding contract](packages/cli/assets/SKILL.md#find-evidence-glia-search)
and [measured comparison with the previous Glia, ctx, and Obelisk](benchmarks/search-tokens/README.md).

Machine setup commands are `setup`, `setup remove`, `hook install|remove`, and
`skill install|remove`. Store commands are `sync`, `status`, and
`store remote set|show`. Project Binding commands are `project list`, `project
forget`, `project bind`, and `project adopt`. Every command supports the global
`--json` and `--no-input` flags, except the deliberately silent `import --hook` path, which
rejects `--json`.

## Data and security

Local search reads native evidence without the import secret gate. Secret Detection is enabled by default and gates Store acceptance when suspected credentials are found. A Project may disable it in `glia.json` with:

```json
{
  "secretDetection": {
    "enabled": false
  }
}
```

Automated imports never accept suspected-secret bytes. They delete the staging
copy and persist only a masked, machine-local evaluation. Interactive commands
surface the withheld count and age; after 14 days they warn that Harness
retention may delete the source. Review with `glia candidates --status flagged`
and accept a flagged Candidate only through an explicit user decision.

`glia delete <session-id> --yes` makes Glia forget a Session. Saved Sessions are purged from Store history with a replicated tombstone; unsaved Sessions receive a payload-free local exclusion that survives cache deletion and later import. Both stay out of default search and automatic import, and Harness source files are retained.

Remove machine integration with `glia setup remove`. Removal only touches hook
entries and skill files that Glia can positively identify as its own; edited or
foreign entries are reported and left intact.

Stored data is intentionally incompatible with earlier Glia Store formats. Start with a fresh `GLIA_HOME` or remove stale Project data before using this version.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
