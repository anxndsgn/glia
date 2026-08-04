# Glia

Glia captures coding-agent Sessions, preserves their source evidence in a local Git-backed Store, and makes them searchable without sending data to a service.

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

Install the bundled agent skill and SessionEnd automation once per machine:

```sh
glia setup
```

Setup installs the skill in both global skill-directory conventions and adds a
`SessionEnd` hook to each Harness already present on the machine. Claude Code
and Codex will ask you to trust or confirm the new hook on their next launch;
automatic imports do not run until you approve it. The hook records the
absolute path of the `glia` binary, so re-run `glia setup` after moving or
replacing that binary.

Inside a Git worktree, interactive setup offers to import the existing backlog.
With `--no-input`, it prints the manual follow-up instead:

```sh
glia import
glia list
glia search "authentication failure"
glia view <session-id>
```

Read commands do not enroll a repository. Before enrollment, `list`, `search`,
`conflicts`, `tombstones`, `candidates`, `status`, `store remote show`, and
`import --dry-run` report an empty or preview result without creating anything
under `~/.glia`. Their JSON results carry `enrolled: false`, a null
`projectId`, and a `not_enrolled` advisory with the number of Candidates that
would be captured. Direct requests for a Session (`view`, `show`, and `export`)
return `NOT_ENROLLED` instead of pretending the Session ID is missing.

Enrollment happens when you run a command that keeps or changes Project data,
such as `import`, `accept`, `archive`, `delete`, `resolve`, `sync`, `setup`, or
`store remote set`. The first interactive `glia import` explains the Store,
backlog, secret-withholding, and installed-hook consequences before creating
the Project, Replica identity, Binding, and local Store under `~/.glia`.
Scripted `--no-input` and `--json` imports proceed without prompting. Glia does
not add a file to the code repository unless you explicitly run
`store remote set`, which writes `glia.json`.

Once a repository has a Binding, ending a Claude Code or Codex Session triggers
a silent background import for that Project. Hook runs outside a Git worktree or
inside a repository that has never enrolled are quiet no-ops. Use `glia status`
to inspect both machine-global hook liveness and the latest hook import for the
current Project, or to diagnose an unenrolled repository without changing it.

Inspect and manage machine-local Bindings from any directory:

```sh
glia project list
glia project forget <path>
glia project bind <project-id> [path]
glia project bind <project-id> <historical-path> --alias
```

`project forget` removes only the Binding; its Store and Sessions remain. A root
enables SessionEnd capture, while an alias claims historical Sessions without
enabling capture at that path. Use `project list` to find rootless Projects,
missing checkout paths, and Stores that have not yet been synced locally.

If a search returns no matches, its human output and JSON `advisories` report
non-zero importable, pending, and withheld Candidate counts. A search with
results does not run discovery.

To share the Store, declare a credential-free Git remote:

```sh
glia store remote set <url> --yes
glia sync
```

`store remote set` is the only command that writes `glia.json`. Network access occurs only during `glia sync`; a fresh checkout with a declaration bootstraps its local Store on the first sync.

## Commands

Session commands are flat: `import`, `candidates`, `accept`, `list`, `show`, `search`, `view`, `export`, `conflicts`, `resolve`, `delete`, `tombstones`, `archive`, and `unarchive`.

Machine setup commands are `setup`, `setup remove`, `hook install|remove`, and
`skill install|remove`. Store commands are `sync`, `status`, and
`store remote set|show`. Project Binding commands are `project list`, `project
forget`, and `project bind`. Every command supports the global `--json` and
`--no-input` flags, except the deliberately silent `import --hook` path, which
rejects `--json`.

## Data and security

Secret Detection is enabled by default and gates acceptance when suspected credentials are found. A Project may disable it in `glia.json` with:

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

Remove machine automation with `glia setup remove`. Removal only touches hook
entries and skill files that Glia can positively identify as its own; edited or
foreign entries are reported and left intact.

Stored data is intentionally incompatible with earlier Glia Store formats. Start with a fresh `GLIA_HOME` or remove stale Project data before using this version.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
