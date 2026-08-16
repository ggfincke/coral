# Troubleshooting

Errors below are from live source paths. If your build differs, trust the running binary.

---

## Ollama will not talk

**Symptom:** picker `Failed to fetch models from Ollama — is it running?` or `/model` same text. Chat: `Cannot reach Ollama at {url}: {detail}` (chat adds ` - the server may be down, or the request may have exceeded the model's context or memory`).

**Check:**

1. Ollama is running and `ollama list` shows models.
2. `--host` matches that server. Default `http://localhost:11434`. Coral does **not** read `OLLAMA_HOST`.
3. Host URL rules: `http` or `https` only; no username/password; no query or fragment. Errors: `Invalid Ollama host URL`, `Invalid Ollama host protocol …; use http or https`, `Ollama host URLs cannot include credentials…`, `…cannot include a query string or fragment`. Startup wraps these as `Cannot start Coral: …`.
4. API failures: `Ollama API error: {status} {body}`. Empty stream body: `No response body`. `/api/tags` without a models array: `Ollama /api/tags response did not include a models array`.

**No models:** `No Ollama models found` / `Pull a model or pass --model explicitly.`

**`--model` tag missing:** Agent still starts; the first chat then fails against Ollama. Prefer pulling the tag or using the picker.

Streamed reasoning missing without an error: `/api/chat` 400/404/422 whose body mentions `think` or `unknown field` is retried once without `think`. `--no-think` sends `think: false`. `Ctrl+T` only hides UI.

---

## Context / memory / budget

**Symptom:** `Model request budget exceeded (promptTokens/promptLimit prompt tokens): the system prompt, active tools, and current turn cannot fit; shorten the turn, disable optional MCP tools, or raise the context limit` — or the variant about **protected conversation history** (`history_overflow`).

**Do:** `/compact`, `/new`, fewer MCP `enabledTools`, smaller `@` attachments, or raise the ceiling (`CORAL_NUM_CTX` or `context.maxNumCtx`). Remember the **8192** floor, the **32,768** prompt-budget cap, and memory/native caps — [Context](context.md).

Pinned window unexpectedly small: full-attention models are KV-capped (`0.75 × RAM − weights − 6 GiB`). Gemma-family sliding-window models pin native after the weight check. Missing weight metadata is treated as 0 (more optimistic).

`/compact` says `Conversation too short to compact` or `Compaction skipped — not enough context to summarize`. Auto-compact notices: prune (`Auto-pruned …`, undo kept), summarize (`Context auto-compacted` + `Undo history cleared`), or trim (`Context trimmed to recent history (summarization unavailable)` + `Undo history cleared`).

---

## MCP

Use `/mcp` first. It never launches a server.

| State / detail                                                 | What to do                                                                                                                                                      |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No servers in `~/.coral.json`                                  | Config belongs in the **user** file, not the project file                                                                                                       |
| `mcp.servers must be an object` / alias invalid / field errors | Fix JSON; `/mcp` lists per-server issues                                                                                                                        |
| `missing required environment variable(s)`                     | Export every `passEnv` name in the shell that starts Coral                                                                                                      |
| `needs_trust` in yolo                                          | `/permissions ask`, send a turn, approve launch                                                                                                                 |
| `needs_trust` after ask initialize with no tools               | Ask fails closed until every configured launch settles                                                                                                          |
| `blocked` / `no tools are enabled for yolo mode`               | Add a nonempty `yoloTools` subset, or stay in ask                                                                                                               |
| `failed` missing executable / Docker                           | PATH, absolute `command`, daemon running                                                                                                                        |
| `failed` timeout                                               | Raise `startupTimeoutMs` (max 60,000) or `toolTimeoutMs` (max 600,000)                                                                                          |
| Allowlisted tool not exposed                                   | Server did not advertise that exact `enabledTools` name                                                                                                         |
| Protocol / 16 MiB / 8192 fragments                             | Server stopped; inspect stderr on `/mcp`                                                                                                                        |
| `tool call timed out; server stopped for this session`         | Restart Coral to launch again                                                                                                                                   |
| Config edited but `/mcp` unchanged                             | Restart Coral (`Config changes require a new Coral session.`)                                                                                                   |
| Trust prompt every time                                        | Fingerprint includes argv, resolved executable, home `launchCwd`, env **names**, tools; nonempty `yoloTools` is hashed. Home directory change invalidates trust |

Headless `--mcp` still rejects prompts: only pre-trusted + `always_allow` namespaced tools run.

Windows: command must resolve to `.exe` or `.com`.

---

## ripgrep / grep / glob

`grep` and `glob` require `rg`. Install: https://github.com/BurntSushi/ripgrep#installation

Timeout 15s, 5 MiB buffer, 200 grep hits / 100 glob files.

---

## Semantic search / `/index`

`search_code failed while using embedding model {name}: …` and, if the model is missing, a hint to `ollama pull {name}`.

`/index` uses a different string: `Index build failed (embedding model {name}): …` plus the same pull hint when the model is missing. Already in progress: `Index build already in progress`. Usage: `/index` or `/index rebuild` (`force` is the same as `rebuild`).

Caps: 2,000 files, 512 KiB each, no symlinks. Huge monorepos will be incomplete. Digest errors (missing/ambiguous/invalid from `/api/tags`) fail closed so Coral will not reuse vectors under a mutable tag. Index files: `CORAL_HOME/retrieval/v2/spaces/*.sqlite`. Legacy `retrieval/index.sqlite` is unused.

---

## Sessions and resume

- `--resume` does **not** skip unusable cwds. Newest session whose directory is gone → CLI error, exit 1.
- `--session` is exact id; `/resume` allows prefixes. Ambiguous prefix: list of matches, use the full id.
- `Working directory no longer exists` — the session's `cwd` is gone. TUI: `Session unavailable: {id}`.
- `Current session could not be saved; resume was canceled.` Same pattern for `/new`: `…the new conversation was not started.`
- `/clear` and `/new` do not delete JSON files.
- TUI resume: `No other sessions to resume.`; `Already in this session.`; `Failed to load session: {id}`.

---

## Undo

`Nothing to undo`, `Cannot undo after compaction or history changes`, `file changed outside Coral`, `file is missing`, concurrent/stale history. Outside-workspace edits were never recorded. Compaction clears the stack.

---

## Permissions and yolo

`Ctrl+Y` while a turn/command/transition/approval is active: `Permission mode is locked while a turn or command is running.` `/permissions` is ignored in that state. `always_deny` still blocks in yolo. MCP launch is never auto-trusted. Path symlink escape is not approvable (`Access outside workspace through symlink is not allowed`).

---

## Tools and loops

`Unknown tool: …` — name not in the active catalog (MCP not admitted yet, or not in the headless profile).

Doom loop modal: identical tool+args or identical error **3** times in **12** calls. `(y) continue  (n) stop`. Exec emits `doom_loop_stopped` and ends.

`code_intel`: `code_intel supports .ts, .tsx, .mts, .cts, .js, .jsx, .mjs, and .cjs files`; `code_intel is unavailable in this session` / `TypeScript language server is unavailable`; `TypeScript diagnostics were not published within 5000ms; run the project typecheck as a fallback` (advice to the model — Coral does not run typecheck).

`bash` / MCP: not sandboxed. Approval of a command or trust of a server is host-level authority.

---

## Theme and prefs

`Unknown theme: …` on `--theme` exits 1. Unknown `prefs.json` theme is ignored (`Ignoring unknown theme in prefs.json: …`). Valid ids: `coral-reef`, `deep-sea`, `sunset-tide`, `kelp-forest`, `tide-pool`, `adaptive`.

---

## Interrupt vs exit

During a run, `Ctrl+C` / `Esc` abort the Agent (partial assistant or `(interrupted)`). When idle, the same keys exit. MCP launch Esc **aborts the run**; tool-approval Esc **rejects the call**.

---

## Related

[Getting started](getting-started.md) · [CLI](cli.md) · [TUI](tui.md) · [MCP](mcp.md) · [Context](context.md) · [Sessions](sessions.md) · [Architecture](architecture.md)
