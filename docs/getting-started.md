# Getting started

Coral is a local-first coding agent in your terminal. It uses **your** Ollama
server by default or a Coral-owned local MLX worker, never a Coral cloud.

## Requirements

- **Node.js 24** or newer (`package.json` `engines.node` is `>=24`)
- At least one local inference backend: a running
  [Ollama](https://ollama.com/) server with a pulled model, or `uv` plus CPython
  3.14 and a configured MLX checkpoint
- [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) for the `grep` and `glob` tools
- Optional: whatever executable or container runtime your MCP servers need
- Optional on the Ollama path: `uv` + CPython 3.14 for MLX embeddings or
  Python MCP tools ([Python](python.md))
- Optional: `nomic-embed-text` (or another embedding model you configure) for semantic `search_code`

TypeScript/JavaScript `code_intel` is bundled. You do not install a separate language server.

## Run from a source checkout

Coral is currently run from the repo, not as a published-with-docs npm workflow:

```bash
git clone https://github.com/ggfincke/coral.git
cd coral
npm install
npm run dev
```

`npm run dev` is `tsx src/cli/main.tsx` — no compile step.

Compiled CLI:

```bash
npm run build
npm start
```

`npm start` runs `node dist/cli/main.js`. After build, that file is also the `coral` binary (`package.json` `"bin": { "coral": "./dist/cli/main.js" }`).

Pass flags after `--` with `npm run dev`:

```bash
npm run dev -- --model gemma4:31b-mlx
npm run dev -- --host http://localhost:11434
```

## First session

1. Prepare a local model: start Ollama and confirm `ollama list` shows a tag,
   or sync `packages/coral-backend` and place an MLX checkpoint under the
   configured models directory.
2. From a project directory, run `npm run dev` (or `npm start` after build).
3. If you did not pass `--model`, Coral opens a **model picker** of tags already installed in Ollama, plus any MLX checkpoints the worker can list.
   - `gemma4:31b-mlx` is pinned to the top and pre-selected **when that Ollama tag is installed**. It is an Ollama tag, not an `mlx:` backend ref.
   - If it is not installed, the first row is the newest model by `modified_at`.
   - Exactly one installed model, or a resumed session whose stored model is still installed, skips the picker.
   - Pass `mlx:<name>` to skip the picker and use the Python worker. Missing worker is an install error.
4. Type a normal prompt and press Enter. `/` autocompletes slash commands. `@` picks a project file.
5. `/help` lists commands and keybindings. Built-in commands are not sent to
   the model; discovered `/skill-name` commands start a turn that loads that
   instruction pack.

Default Ollama host is `http://localhost:11434`. Override with `--host`. Coral does not read `OLLAMA_HOST`.

Streamed reasoning requests are **on** unless you pass `--no-think`. `Ctrl+T` only hides or shows thinking in the transcript; it does not change what is requested.

Permission mode starts as **ask** (prompt before gated calls) unless you pass `--yolo`. See [Permissions](permissions.md).

`--resume` loads the newest session by `updatedAt` and **exits 1** if that session's cwd is gone. It does not skip to the next session. Details: [CLI](cli.md), [Sessions](sessions.md).

## Semantic search (optional)

```bash
ollama pull nomic-embed-text
```

Then `/index` in the TUI, or just use `search_code` — the first search also
refreshes the index. Override the model with `CORAL_EMBEDDING_MODEL` (bare
Ollama name, `ollama:<name>`, or `mlx:<name>`) or project `.coral.json`
`retrieval.embeddingModel` / optional `retrieval.provider`. The environment
override replaces both project fields. Default stays `nomic-embed-text` on
Ollama.

## Project instructions

If the workspace contains `.coral.md` (then `AGENTS.md`, `README.md`, and other known files), Coral may inject excerpts into the system prompt as **Loaded Project Context**. Standing user rules from `AGENTS_HOME/AGENTS.md` (default `~/.agents/AGENTS.md`) are injected first. That text cannot grant tools or permissions. See [Architecture](architecture.md), [Configuration](configuration.md), and [Skills](skills.md).

## What to read next

- Daily use: [TUI](tui.md)
- Skills: [Skills](skills.md)
- Flags and `coral exec`: [CLI](cli.md)
- `.coral.json` and `CORAL_HOME`: [Configuration](configuration.md)
- Optional MLX / Python SDK / plugins: [Python](python.md)
- How the loop is built: [Architecture](architecture.md)
- Resume and session files: [Sessions](sessions.md)
