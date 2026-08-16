# Coral documentation

Guides for people running Coral: a local-first CLI/TUI coding agent that uses
your Ollama host by default or a Coral-owned local MLX worker.

Coral is pre-1.0. Interfaces, session files, and configuration can still change between minor releases.

## Start here

1. [Getting started](getting-started.md) — install, first session, default model and host.
2. [CLI reference](cli.md) — interactive flags and `coral exec`.
3. [TUI](tui.md) — slash commands, keys, pickers, approvals, `@` mentions.

## Configure and stay safe

4. [Configuration](configuration.md) — `.coral.json`, env vars, `CORAL_HOME`, precedence.
5. [Permissions](permissions.md) — ask vs yolo, per-tool policy, workspace paths.
6. [MCP](mcp.md) — local stdio servers, trust, `yoloTools`.

## What the agent can do

7. [Tools](tools.md) — every built-in tool, params, and policy highlights.
8. [Skills](skills.md) — catalog, `skill` tool, `AGENTS_HOME/skills`.
9. [Sessions](sessions.md) — save, resume, list, what is stored.
10. [Context, compaction, and undo](context.md) — window sizing, `/compact`, `/undo`.

## How it is put together

11. [Architecture](architecture.md) — layers, turn loop, ownership, compaction modes, constructor seams, and non-goals. This is the systems document, not a how-to.
12. [Troubleshooting](troubleshooting.md) — Ollama, MLX worker, context, MCP, sessions, common failures.
13. [Python plane](python.md) — optional MLX worker, unpublished exec SDK, and MCP plugin scaffold.

## Reading order

- **Use Coral today:** getting started → TUI → permissions.
- **Wire MCP or lock down a project:** configuration → permissions → MCP.
- **Run an `mlx:` model or write Python tools:** python → configuration → MCP.
- **Understand a session or a stuck turn:** architecture → context → troubleshooting.
