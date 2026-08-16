# Skills

Coral skills are **instruction packs** the model can load on demand. They are not a second plugin loader: Coral never auto-executes files under a skill's `scripts/` directory. Python MCP tools stay on the MCP host (`packages/coral-plugins`).

Progressive disclosure:

1. Standing rules from `AGENTS_HOME/AGENTS.md` (default `~/.agents/AGENTS.md`) are read through an 8 KiB limit and injected **before** workspace project files.
2. The system prompt lists a **catalog** (`name` + `description`) for each discovered skill.
3. The model calls the built-in `skill` tool to load `SKILL.md` or a confined file under `references/`.

Standing rules and the rendered catalog share one 4 KiB UTF-8 prompt budget so
they cannot consume the minimum 8K context by themselves. When both exist,
standing rules receive up to 2,560 bytes and the catalog uses the remainder;
truncation is explicit. Every skill result loaded during the active turn stays
available through that turn's tool-result pruning. After finalization, the
latest loaded skill remains protected for follow-up turns; loading a newer
skill makes the older body ordinarily prunable.

Do not dump skill bodies into the default prompt. Personal skills are the same tree Codex reads (`AGENTS_HOME/skills`). Coral does **not** scan `CORAL_HOME/skills`. Install or sync with ggfincke-skills: `python3 scripts/sync-skills.py --target agents` or `make sync`.

---

## Discovery

Later roots override on frontmatter `name` collision. Invalid, oversized, and
non-regular `SKILL.md` files are skipped, not fatal. A skill directory may be a
symlink; file loads stay inside the **resolved** package root (`..` and symlink
escape are errors). Discovery and loads cap each file at 1 MiB.

1. `AGENTS_HOME/skills/<name>/SKILL.md` (personal; env `AGENTS_HOME`, default `~/.agents/skills`)
2. `<cwd>/.agents/skills/<name>/SKILL.md`
3. `<cwd>/.coral/skills/<name>/SKILL.md`

Discovery runs at composition roots (`src/tui/session/agent-session.ts`, `src/cli/exec.ts`) and is injected into the Agent. Missing `options.skills` is an empty catalog (tests and the eval harness stay deterministic). The Agent does not scan the real home on its own.

Each `SKILL.md` needs YAML frontmatter with `name` and `description` only (other keys ignored).

---

## Install

```bash
coral skills              # list name, source, description
coral skills path         # print AGENTS_HOME/skills
```

`coral skills seed` does **not** copy packages. It exits with a pointer at ggfincke-skills (`python3 scripts/sync-skills.py --target agents` / `make sync`). Coral does not snapshot into `CORAL_HOME` or invent a second copy into `~/.agents`.

Interactive launch does **not** copy skills. `AGENTS_HOME/skills/` (and the project roots above) is enough layout.

`/skills` in the TUI lists the catalog (like `/mcp`). It does not load or install packages.

Each discovered skill is also a first-class slash command: type `/simplification-review` (or a unique prefix such as `/sim`) to start a turn that loads that skill via the `skill` tool and follows it. Optional text after the name is extra user instructions. Built-in commands win on name collision (`/status`, `/sessions`, …). `/` completion and the Ctrl+P palette include skill names. Coral never auto-executes files under a skill's `scripts/` directory.

The optional `skill.file` argument accepts only `references/...`; other package
files, including `scripts/`, are not readable through the tool.

---

## Related

[Getting started](getting-started.md) · [CLI](cli.md) · [TUI](tui.md) · [Tools](tools.md) · [Configuration](configuration.md) · [Architecture](architecture.md)
