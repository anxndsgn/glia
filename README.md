# Glia

Glia captures coding-agent Sessions, preserves their source evidence in a local Git-backed Store, and makes them searchable without sending data to a service.

It supports Claude Code and Codex source Sessions. Import, query, archive, deletion, conflict resolution, export, and synchronization are built in.

## Requirements

- Bun 1.3 or newer
- Git
- A Bun runtime with SQLite FTS5 support

## Development

```sh
bun install
bun run typecheck
bun test
bun run build
```

Run the source CLI with `bun run dev:cli -- <command>`.

## First use

Run a Session command inside a Git worktree:

```sh
glia import
glia list
glia search "authentication failure"
glia view <session-id>
```

Glia creates the Project, Replica identity, Binding, and local Store lazily under `~/.glia`. It does not add a file to the code repository.

To share the Store, declare a credential-free Git remote:

```sh
glia store remote set <url> --yes
glia sync
```

`store remote set` is the only command that writes `glia.json`. Network access occurs only during `glia sync`; a fresh checkout with a declaration bootstraps its local Store on the first sync.

## Commands

Session commands are flat: `import`, `candidates`, `accept`, `list`, `show`, `search`, `view`, `export`, `conflicts`, `resolve`, `delete`, `tombstones`, `archive`, and `unarchive`.

Store commands are `sync`, `status`, and `store remote set|show`. Every command supports the global `--json` and `--no-input` flags.

## Data and security

Secret Detection is enabled by default and gates acceptance when suspected credentials are found. A Project may disable it in `glia.json` with:

```json
{
  "secretDetection": {
    "enabled": false
  }
}
```

Stored data is intentionally incompatible with earlier Glia Store formats. Start with a fresh `GLIA_HOME` or remove stale Project data before using this version.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
