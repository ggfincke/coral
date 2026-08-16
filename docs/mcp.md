# MCP

Coral can launch **local stdio** MCP servers that expose tools. Servers are defined only in **user** `~/.coral.json`. A cloned project's `.coral.json` cannot add a process.

MCP is optional. Interactive Coral still uses MCP mode `ask` or `yolo`; with no servers configured, `/mcp` reports that none are configured. Subagents and `coral exec` without `--mcp` use MCP `off`.

Coral does **not** sandbox MCP processes. Bounds below limit protocol messages and model-visible output; they do not make an untrusted server safe.

Deferred / not supported: remote transports, OAuth, standalone resource discovery, prompts, sampling, elicitation, hot config or tool-list updates, MCP from subagents, parallel MCP calls. Text resources **embedded in a tool result** are supported.

---

## Configure a server

```json
{
  "mcp": {
    "servers": {
      "github": {
        "command": "docker",
        "args": [
          "run",
          "-i",
          "--rm",
          "-e",
          "GITHUB_PERSONAL_ACCESS_TOKEN",
          "ghcr.io/github/github-mcp-server"
        ],
        "enabledTools": ["get_me", "get_file_contents", "pull_request_read"],
        "yoloTools": ["get_me", "get_file_contents"],
        "passEnv": ["GITHUB_PERSONAL_ACCESS_TOKEN"],
        "startupTimeoutMs": 30000,
        "toolTimeoutMs": 60000
      }
    }
  },
  "permissions": {
    "mcp__github__get_me": "always_allow"
  }
}
```

Put secrets in the environment that starts Coral, not in JSON:

```bash
export GITHUB_PERSONAL_ACCESS_TOKEN="$(gh auth token)"
npm run dev
```

Model-facing name: `mcp__<alias>__<tool>` (here `mcp__github__get_me`). TUI label: `MCP · alias · rawName`.

`always_allow` on a namespaced tool only skips the **ask-mode** per-call prompt. It is independent of `yoloTools`. `yoloTools` is the yolo opt-in.

Pin container images by digest if immutable server code matters to you. The launch fingerprint hashes the **resolved executable path and argv**, not image contents or a mutable tag.

---

## Fields

Alias keys: `/^[a-z0-9][a-z0-9_-]{0,31}$/` — 1–32 characters, start with a lowercase letter or digit.

| Field              | Contract                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `command`          | Required. `PATH` name or **absolute** path if it contains `/` or `\`. Never passed through a shell. Max 1,024 chars, no NUL. Windows: native `.exe` / `.com` only              |
| `args`             | Optional string array, default `[]`. Max 64 items, each 1–4,096 chars; duplicates allowed                                                                                      |
| `enabledTools`     | **Required** nonempty exact names. Each `/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/` (1–128 chars; **must start with a letter or digit**, not `_` or `-`). Unique. Wildcards rejected |
| `yoloTools`        | Optional unique subset of `enabledTools`. Default `[]` — that server **does not start in yolo**                                                                                |
| `passEnv`          | Names to forward (max 32). `/^[A-Za-z_][A-Za-z0-9_]*$/`, max 128 chars. Values read at launch; `/mcp` shows names only                                                         |
| `startupTimeoutMs` | Integer 1,000–60,000. Default **10,000**                                                                                                                                       |
| `toolTimeoutMs`    | Integer 1,000–600,000. Default **60,000**                                                                                                                                      |

Working directory is **not configurable**. Coral always sets `launchCwd` to `os.homedir()`. Trust fingerprints include that path — changing home invalidates trust.

Hard limits: at most **4** servers; at most **12** `enabledTools` **per server and across all accepted servers**. Exceeding the global cap rejects **all** servers. `yoloTools` does not add to the count.

If any `passEnv` variable is **unset** (`=== undefined`), that server is `failed` for the session (`missing required environment variable(s): …`) rather than launched incomplete. An empty string is forwarded as a value.

---

## Ask vs yolo vs off

| Mode   | Who uses it                                            | What starts                                                                   |
| ------ | ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `ask`  | Interactive default                                    | Servers with `enabledTools`; launch trust may prompt                          |
| `yolo` | `--yolo`, `/permissions yolo`                          | Only servers with nonempty `yoloTools` **and** current trust; no trust prompt |
| `off`  | Subagents; `coral exec` without `--mcp`; Agent default | Nothing                                                                       |

Ask bootstrap: if any server remains `needs_trust`, **no** MCP tools are admitted.

Yolo: untrusted servers stay `needs_trust` with a message to switch to ask and send a turn. Unrelated already-trusted servers may still start.

Switching modes retires processes; tools for the new mode appear on the next chat turn.

`/mcp` is observational and never launches.

---

## Launch trust

On first use in **ask**, Coral resolves the executable to a real path and asks you to approve:

- alias, configured command, resolved executable
- complete ordered arguments
- working directory (home)
- forwarded environment **names**
- `enabledTools` and `yoloTools`
- SHA-256 fingerprint

Fingerprint payload (version 1): alias, command, executable, args, launchCwd, sorted `passEnv`, sorted `enabledTools`, and sorted `yoloTools` **only if nonempty**. Empty/missing `yoloTools` is omitted so older ask-only trust records stay valid. Adding, widening, narrowing, or removing yolo authority changes the hash.

The hash does **not** include executable file bytes or container image contents. An update at the same path or tag does not by itself force reapproval.

Storage:

- New approvals: `CORAL_HOME/mcp-trust.d/<alias>.json`
- Legacy read: `CORAL_HOME/mcp-trust.json`
- A nonempty sidecar **shadows** legacy even if invalid (fail closed)

Launch approvals in ask run sequentially in configuration order. Coral starts at most **two** authorized servers at once, then installs tools in configuration order (deterministic collisions and budget).

---

## `/mcp` states

`/mcp` prints mode, config issues, and per server: alias, state, executable, working dir, env names, ask tools (`enabledTools`), yolo tools, available namespaced tools when ready, detail, stderr. Footer (when at least one server is listed): `Config changes require a new Coral session.`

| State         | Meaning                                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `configured`  | Valid config, not started yet — send a chat turn in the active mode                                                                                                                                                            |
| `needs_trust` | Ask can prompt on a turn; yolo skips                                                                                                                                                                                           |
| `blocked`     | Mode has no opted-in tools, MCP is `off`, or `always_deny` removed every candidate                                                                                                                                             |
| `failed`      | Missing executable/env, Docker failure, timeout, protocol error, or **no usable allowlisted tool remains**. A single missing/skipped tool with others still installed leaves the server `ready` and records the skip in Detail |
| `rejected`    | Ask-mode launch trust declined for this session                                                                                                                                                                                |
| `stopped`     | Interrupted/timed-out call retired the server; restart Coral to use it again                                                                                                                                                   |
| `ready`       | Discovery succeeded; only listed active-mode namespaced tools are available                                                                                                                                                    |

Empty config: `No MCP servers are configured in ~/.coral.json.`

Yolo banner: only exact `yoloTools` with current trust can start; missing/stale trust is skipped without prompting.

---

## Runtime limits

- Discovery: 16 pages, 512 discovered tools
- Schema: 25,000 chars per tool, 100,000 total; descriptions ellipsized to 2,000 chars
- Dynamic tools that would exceed the model's context-relative budget are skipped (`/mcp` reports the skip). Budget is roughly half the prompt limit minus trusted tool definitions
- Stdio: newline-delimited JSON; **16 MiB** per message or **8,192** fragments — over limit **stops the server** (`failed`)
- Result body: at most 100,000 characters, then an omitted-character marker. Structured JSON extra cap 80,000 chars, depth 20, 200 collection items
- Stderr on `/mcp`: at most 4,000 characters, redacted
- Images/audio/binary resources: unsupported placeholders
- `execution.taskSupport === 'required'` tools skipped (server can still be `ready` if others remain)
- All MCP calls share one queue (serial)
- Timeout/abort of a call **stops that server** for the session
- Client name `coral`, version from `package.json`; `enforceStrictCapabilities: true`

Launch without a shell, home as cwd, minimal default environment plus named `passEnv`. If every configured tool is `always_deny`, launch is refused.

These controls reduce ambient authority. They do not restrict what a launched process can do with its own filesystem, network, or forwarded secrets. `yoloTools` limits which **model calls** skip a prompt, not process authority.

---

## Headless `--mcp`

`coral exec --mcp` sets `mcpMode: 'ask'` but **rejects** launch and tool approvals. Only pre-trusted servers and namespaced tools already `always_allow` can run. `--no-mcp` is explicit off. See [CLI](cli.md).

---

## Related

[Configuration](configuration.md) · [Permissions](permissions.md) · [Troubleshooting](troubleshooting.md) · [Architecture](architecture.md)
