# Permissions and approval

Coral has **three different knobs**. Mixing them up is the usual source of confusion.

| Knob                    | Values                                            | Where                                                                                                          |
| ----------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Per-tool policy**     | `always_allow`, `require_approval`, `always_deny` | Built-in defaults, `~/.coral.json` `permissions`, project `.coral.json` `permissions`                          |
| **TUI permission mode** | `ask` or `yolo`                                   | `--yolo`, `/permissions`, `Ctrl+Y`                                                                             |
| **MCP mode**            | `off`, `ask`, `yolo`                              | Interactive TUI always passes ask or yolo. `off` is Agent default, subagents, and `coral exec` without `--mcp` |

Policy is not a mode. Mode is not a sandbox.

---

## Per-tool policy

Resolved by `resolvePermissions(cwd)`:

1. Catalog defaults for built-ins
2. User `~/.coral.json` `permissions` (may loosen defaults)
3. Project `<cwd>/.coral.json` `permissions` — **stricter only** (`always_allow` < `require_approval` < `always_deny`)

Unknown names (including MCP tools you have not listed) use `require_approval`.

Invalid policy strings are dropped.

MCP tools are keyed by the canonical name `mcp__<alias>__<tool>`. Project config may tighten those keys; it cannot define the server or add it to `enabledTools` / `yoloTools`.

### Built-in defaults

**`always_allow`:** `read_file`, `grep`, `glob`, `list_files`, `search_code`, `code_intel`, `git_status`, `git_diff`, `git_log`, `task`, `todo_write`

**`require_approval`:** `write_file`, `edit_file`, `bash`, `git_add`, `git_commit`, `git_switch`, `git_push`

Nothing ships as `always_deny`; you set that in JSON.

---

## Ask vs yolo (interactive)

**Ask (default):** prompt before `require_approval` calls. MCP uses full permitted `enabledTools`. First or changed launch identity can show a trust modal.

**Yolo:** auto-approve `require_approval` **tool** calls, including file tools that were promoted because the path leaves the workspace. `always_deny` still blocks. MCP advertises only exact `yoloTools` whose **current** launch fingerprint was already approved in ask. Yolo never opens or persists new launch trust.

Mode change drops the old MCP catalog and processes immediately; the new allowlist is built on the **next chat turn**. You cannot toggle mode while a turn or command is running.

There is no TUI `off` permission mode. Turning MCP off for an interactive session is not a `/permissions` value — leave servers unconfigured, or use headless without `--mcp`.

---

## Workspace path gate

File/search/code-intel tools that declare a `path` argument still need a **separate** approval when that path is outside the workspace, even if their normal policy is `always_allow`. `write_file`, `edit_file`, `grep`, `glob`, and `list_files` default a missing path to `.`. `read_file` and `code_intel` require an explicit path.

- Lexical `..` escape: `Access outside workspace requires approval: …`
- Symlink escape: **fail closed** — `Access outside workspace through symlink is not allowed: …` (not an approval prompt)

After you approve, that invocation may read/write the resolved path. Outside-workspace **writes/edits are not undoable**.

**Not covered by path policy:** `bash`, all `git_*` tools (including `git_diff` / `git_log`, which take a `path` argument that is **not** workspace-gated), `search_code`, `task`, `todo_write`, MCP tools. `bash` runs in the session cwd with no workspace fence; after you approve the command, the shell can touch anything the OS user can.

---

## Parallel calls

A batch of consecutive calls runs in parallel only if each tool is `parallelSafe` **and** the resolved policy is `always_allow`. Promoted outside-workspace calls are serial. MCP is always serial across servers.

---

## What yolo does not do

- Override `always_deny`
- Prompt for or save MCP launch trust
- Widen `yoloTools` (only user `~/.coral.json` can list them, as a subset of `enabledTools`)
- Sandbox `bash` or MCP processes
- Change headless exec: exec **always rejects** approval prompts. Yolo is an interactive concept

---

## Approval UX

See [TUI](tui.md) for keys and scrolling. Tool reject message to the model: `Tool call rejected by user`. Deny: `Tool {name} is denied by permission policy`. Unknown: `Unknown tool: {name}`. Interrupt: `Tool call interrupted`.

MCP launch body includes alias, command, resolved executable, args, home-directory working directory, forwarded **environment names** (not values), enabled tools, yolo tools, SHA-256 fingerprint, and a not-sandboxed warning.

---

## Headless

`coral exec` profiles force `always_allow` on their catalog tools, then reject every `onToolApproval` / `onMcpLaunchApproval` / doom continue. Unexpected tools never run. `--mcp` only helps for already-trusted servers whose namespaced tools are `always_allow`. Details: [CLI](cli.md).

---

## Undo and secrets

`/undo` checks that the file on disk still matches Coral's recorded `after` (undo) or `before` (redo). If you or another process edited it: `file changed outside Coral`. Summarize, trim, `/compact`, and `/clear` clear undo; tool-result prune does not. Session snapshots under `CORAL_HOME/sessions/` can duplicate file contents, including secrets.

---

## Related

[Configuration](configuration.md) · [MCP](mcp.md) · [Tools](tools.md) · [TUI](tui.md) · [Architecture](architecture.md)
