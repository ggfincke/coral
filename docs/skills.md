# Skills

Coral skills are instruction packs the model can load on demand. They are not a
plugin loader: a skill cannot add tools or permissions, and Coral never
auto-executes files under `scripts/`.

## Prompt and loading

Coral reads standing rules from `AGENTS_HOME/AGENTS.md` (default
`~/.agents/AGENTS.md`) through an 8 KiB file limit. Standing rules and the
discovered skill catalog (`name` and bounded `description`) share a prompt
allowance of one eighth of the context window, between 4 KiB and 10 KiB.
While skills are available, standing rules take at most half of it (and never
more than 4 KiB); the catalog gets the rest, up to 6 KiB. A catalog that does
not fit ends with an omitted-count line, and calling `skill` with an unknown
name lists every winner.

Interactive, exec, and ACP sessions all load skills and standing rules. With no
skills installed, the `skill` tool is not offered. Skills are discovered once
per Agent, so new packages appear after a restart or session switch.
`coral exec --permission-profile none` exposes no tools, so no catalog is
shown, but standing rules are still included.

The model calls the built-in `skill` tool to load `SKILL.md` or a confined file
under `references/`. Loads are capped at 1 MiB and reject `..`, absolute paths,
symlink escape, non-regular files, and every other package directory. Skill
scripts are never read or executed by this tool.

## Discovery and precedence

Each package directory needs a `SKILL.md` with YAML-like `name` and
`description` frontmatter. Names use letters, digits, `.`, `_`, and `-`, and
identity is ASCII case-insensitive while authored casing remains visible.

Precedence is:

1. `AGENTS_HOME/skills/<package>` (personal)
2. `<cwd>/.coral/skills/<package>`
3. `<cwd>/.agents/skills/<package>`

Personal package symlinks are allowed because `AGENTS_HOME` is user-owned; all
subsequent file loads remain confined to the resolved package. Project skill
roots must resolve inside the checkout, and project packages must resolve
inside their corresponding resolved skill root. A project root or package
symlink that escapes is skipped.

For a case-folded collision, the higher-precedence package wins. Packages in
the same source use code-point lexical package-path order as a deterministic
tie-breaker. The winning catalog is immutable, and both `coral skills` and
`/skills` show the winner plus every rejected package's authored name, source,
and resolved root. Only the winner reaches the model catalog or slash registry.

## Commands

```bash
coral skills             # list winners and rejected collisions
coral -C repo skills     # list for another workspace
coral skills path        # print AGENTS_HOME/skills
```

Coral never copies packages into or scans `CORAL_HOME/skills`.

`/skills` is observational. Each winning skill is also a slash command, such as
`/simplification-review`. Only the full name (case-insensitive) runs a skill;
completion fills in partial names. Built-ins win exact collisions. Optional text after the skill
name becomes additional user instruction. The typed command is retained in the
transcript, input history, session title, and restored sessions; the model sees
a semantic instruction to call `skill` for the resolved winner.

All skill results in the active turn are protected from tool-result pruning.
After the turn completes, the newest completed skill result remains protected
for follow-up context; earlier skill results return to ordinary pruning rules.

## Related

[CLI](cli.md) · [TUI](tui.md) · [Tools](tools.md) ·
[Configuration](configuration.md) · [Context](context.md)
