# ACP setup and recovery

Coral serves Agent Client Protocol over newline-delimited JSON on stdio through
`coral acp`. Node 24 is required. Build with `npm ci` and `npm run build`, then
point your client at the explicit `dist/cli/main.js` entrypoint through Node 24
or an executable wrapper. The client appends `acp` and its options.

```sh
CORAL_HOME=/absolute/path/to/app-coral-home coral acp \
  --host http://127.0.0.1:11434 --model qwen3.8:27b-mlx
```

The host is an existing Ollama endpoint; Coral does not download models. The
model option sets the new-session default. Exact Ollama names are preserved.
The normal `coral` command still opens the current TUI. ACP dispatch does not
load that TUI.

## Supported operations

- Initialize protocol version 1 without creating a session or loading a model.
  No authentication method is advertised or required.
- Create one session per connection, send text turns, and receive streamed text,
  thinking, usage and tool evidence. Approvals allow or reject one tool call.
- Cancel an active turn, then continue the same session.
- Change the model while idle using session config options.
- Resume an existing native session using `session/resume`, without replaying
  its messages to the client. Close the session and release its resources.

Only supervised/default mode is supported. Attachments, additional directories,
and client-supplied MCP servers are rejected. MCP is disabled, including the
user's configured servers. App MCP, session import/replacement, and speculative
plan publishing are outside this integration.

For generated titles, clients may run:

```sh
coral exec --permission-profile none --ephemeral --no-mcp \
  --output-format json --model qwen3.8:27b-mlx \
  --cwd /absolute/path/to/worktree 'Return a short title'
```

This profile exposes no tools and starts no MCP servers even with `--mcp`.
Exec never writes conversation sessions. A result-file option, if supplied,
still writes its explicitly requested result. Final status distinguishes
completion, failure, cancellation, and the iteration limit; only completion
exits successfully.

## Native session ownership

Use a fresh `CORAL_HOME` for each app instance. ACP stores the same native JSON
snapshots as the TUI (`meta`, `messages`, `todos`, `undo`, `redo`), with no separate
transcript/provenance ledger. Legacy native snapshots remain readable. Resume
requires the requested canonical working directory to match the saved one.

An ACP session holds an exclusive token-owned lease in
`CORAL_HOME/sessions/leases.sqlite`. Native saves and renames check this lease;
another process cannot overwrite an active ACP session. Plain reads remain
available. Close and shutdown join active work before releasing ownership.

A settled turn is captured and atomically saved before successful ACP completion.
If saving fails, the last valid on-disk snapshot remains intact and the captured
snapshot remains pending in the owning process. Subsequent turns first retry
that same snapshot; they cannot start while saving still fails. Model metadata
writes follow the same retry rule.

## Recovery

- **Session in use:** close the owning app/session and retry. Do not delete lease
  storage while an owner may still be alive. Same-host leases are automatically
  recovered only when their process is conclusively absent. Foreign-host,
  permission-denied, and ambiguous/PID-reuse cases remain blocked conservatively.
- **Save failure:** repair disk space or permissions while the owning process
  remains alive, then retry. Close/shutdown also tries the captured write. If
  persistence remains impossible or the process is lost, only the last valid
  snapshot is durable; an unsaved turn is not acknowledged as successful.
- **Invalid snapshot or working directory:** restore the original directory or
  a known-good native snapshot while all owners are stopped. Do not change the
  stored directory to redirect a session into another project.
- **Incompatible executable:** run `coral acp --help`, not just `coral --version`.
  A launcher must invoke Node and an explicit build entrypoint; recursively
  resolving `coral` from within a wrapper named `coral` cannot work.

## Implementation boundaries

`src/acp` owns protocol projection and the connection controller;
`src/cli/acp.ts` owns stdio. `src/runtime/interactive-session.ts` is the current
shared operation lifecycle, re-exported from the existing TUI module.
`src/session/lease.ts` and the native store own snapshots and write exclusion.
The Agent adds only tool-call identity and iteration-limit callbacks needed by
these clients. Current dependencies and TUI behavior are retained, with the
ACP SDK added as a direct dependency.
