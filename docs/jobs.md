# Durable coding tasks

`coral jobs` runs an approved coding task in its own Git worktree, in the
background, on macOS and Linux. The task keeps running after you close the
terminal or the TUI panel that started it. It never commits, pushes, or merges;
you review the worktree yourself.

This page is the full reference. The [README](../README.md#durable-coding-tasks)
has a shorter walkthrough.

## Lifecycle

```text
plan -> draft -> start (approve) -> queued -> running -> ready_for_review
                                                      \-> needs_input
                                                      \-> interrupted
                                                      \-> failed / cancelled
```

| Status             | Meaning                                                                                                                                                                    |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `draft`            | Proposal saved; nothing has run. Its `spec` can still be edited.                                                                                                           |
| `queued`           | Approved and waiting for the single worker slot.                                                                                                                           |
| `running`          | A worker owns the task.                                                                                                                                                    |
| `ready_for_review` | The Agent finished, every agreed check passed, and the supervisor confirmed that execution stopped and the worktree is intact.                                             |
| `needs_input`      | The task stopped for something only you can resolve, such as checks still failing after the repair budget or the time budget running out. `coral jobs show` explains what. |
| `interrupted`      | Execution stopped without a settled result, for example after a crash or restart.                                                                                          |
| `failed`           | The task hit an error it could not settle, for example a failed Git or tool operation.                                                                                     |
| `cancelled`        | Cancelled before or during execution; owned processes were stopped first.                                                                                                  |

## Plan and approve

```bash
coral jobs plan "Update the greeting and verify its output" -m qwen3.8:27b-mlx \
  --cwd /path/to/repo --time-limit 120 --max-repairs 3
```

Planning reads the selected commit with read-only tools and proposes an
implementation plan, setup commands, and check commands. It runs nothing. The
starting point defaults to `HEAD`. If the checkout has uncommitted or untracked
files, pass `--ref HEAD` (or another commit) to confirm that only committed code
is used; uncommitted and ignored files are never copied into the task worktree.

`coral jobs show <id>` prints the draft file path and the specification digest.
You can edit the draft's `spec` (objective, plan, setup, checks, limits) until
it starts. Then show it again and approve that exact digest:

```bash
coral jobs start <id> --approve <digest> --allow-host-shell
```

The digest covers the whole specification, so approval always matches what you
reviewed. Once started, the specification and approval can no longer change.

## Execution

One background supervisor per `CORAL_HOME` runs a FIFO queue with **one active
worker**. `start`, `cancel`, `resume`, and the `/jobs` panel's actions launch it
on demand; `list`, `show`, `logs`, and `diff` only read task files. It exits
after 60 seconds with an empty queue.

A worker:

1. creates the task worktree under `CORAL_HOME/jobs/<id>/worktree` on branch
   `codex/job-<id>`, at the approved commit;
2. runs setup commands once;
3. runs an Agent turn to implement the objective;
4. runs the full check suite, then gives the Agent up to `--max-repairs` repair
   turns, rerunning the whole suite after each;
5. stops at `ready_for_review` when the suite passes, or at `needs_input` when
   the repair or time budget runs out.

The **active-time budget** (`--time-limit`, default 120 minutes) counts setup,
inference, shell commands, and checks, but not time in the queue. Consumed time
and repair attempts carry over to continuations.

Workers get file, search, `code_intel`, `bash`, read-only Git, and `todo_write`
tools, all pre-approved. MCP and nested subagents are not available. Agent
shell commands use the `bash` tool's 30-second default timeout unless the model
asks for another; setup and check commands are bounded only by the task budget.

### Environment

A task runs with the environment of the shell that started or resumed it
(`PATH`, Node version, virtualenv, credentials), not the environment of
whichever shell launched the supervisor. The supervisor holds that environment
in memory only; it is never written to task records. If the supervisor restarts
while a task is still queued, the environment is gone, so the task moves to
`needs_input` and asks you to resume it from the intended shell.

## Watch and review

```bash
coral jobs list                 # all tasks; unreadable records are named on stderr
coral jobs logs <id> --follow   # Ctrl+C stops following, not the task
coral jobs show <id>            # status, budgets, checks, worktree, next steps
coral jobs show <id> --transcript
coral jobs diff <id>            # staged, unstaged, and untracked changes
```

Every `coral jobs` subcommand accepts `--json`.

Each check or setup run is recorded with its command, attempt, result, and
timing. A record keeps only the last 8 KiB of output; longer output is saved in
full beside it as `output-<uuid>.log`, and `show` prints its path.

## Cancel and continue

```bash
coral jobs cancel <id>
coral jobs resume <id> --instructions "Inspect the current changes and continue"
```

Cancelling a running task waits for its owned processes to stop. A draft,
queued, interrupted, or `needs_input` task is cancelled immediately.

`resume` works on `interrupted`, `needs_input`, `failed`, `cancelled`, and
`ready_for_review` tasks while active time remains. It starts with a read-only
reconciliation turn that inspects the actual files and diff, then continues
with a writable implementation turn and the full check suite. Your instructions are added for that continuation; they are not
part of the approved specification.

Coral never silently repeats a command whose outcome is unknown:

| Situation                              | Required decision                                                                             |
| -------------------------------------- | --------------------------------------------------------------------------------------------- |
| A setup command was interrupted        | `--setup-resolution retry` or `--setup-resolution skip`, after inspecting its effects         |
| An Agent shell command was interrupted | `--shell-resolution continue` (keep its effects, do not replay) or `--shell-resolution retry` |
| A check command was interrupted        | `--shell-resolution retry` before the full suite runs again                                   |

## Recovery

- **Crash or restart.** A running task becomes `interrupted` with its worktree,
  events, and last checkpoint kept. Nothing restarts automatically; resume it.
- **One bad task does not stop the queue.** An unreadable task record is
  skipped and reported. A missing source checkout, a worker that cannot start,
  or a worktree that fails its final check moves only that task to
  `needs_input`, and the queue continues.
- **Unproven process ownership.** If the supervisor cannot prove that a
  worker's processes stopped, it takes no new work and exits. The next task
  command starts a fresh supervisor, which re-checks the previous worker before
  running anything; that command may report that the supervisor is restarting.
- **Worktree creation.** A worktree stays marked pending until it is verified.
  If creation was interrupted, the next run discards the partial worktree and
  builds it again, reusing the task branch only while it still points at the
  approved commit. A verified worktree that later goes missing is reported
  instead of rebuilt, because it held the task's changes.

See [Troubleshooting](troubleshooting.md#durable-tasks) for specific messages.

## Where data lives

| Path                                        | Contents                                                            |
| ------------------------------------------- | ------------------------------------------------------------------- |
| `CORAL_HOME/jobs/<id>/job.json`             | Task record: specification, approval, status, command results       |
| `CORAL_HOME/jobs/<id>/events.json`          | Bounded event log (2 MiB, 2,048 events)                             |
| `CORAL_HOME/jobs/<id>/snapshot-<uuid>.json` | Conversation checkpoints, one per settled Agent turn                |
| `CORAL_HOME/jobs/<id>/output-<uuid>.log`    | Full output of setup and check runs longer than 8 KiB               |
| `CORAL_HOME/jobs/<id>/processes/`           | Ownership journals for running commands                             |
| `CORAL_HOME/jobs/<id>/worktree/`            | The task worktree, locked in the source repository                  |
| `/tmp/coral-jobs-<uid>-<hash>/`             | Supervisor lock, control socket, active-worker journal, launch logs |

Task directories are private (`0o700`). Worktrees, `codex/job-<id>` branches,
checkpoints, and logs are kept after a task settles; Coral does not delete them.
To remove a finished task's worktree, run `git worktree remove --force --force`
on it from the source repository, then delete the branch if you no longer need
it.

## Safety model

- **Host execution.** Setup, checks, and Agent shell commands run on your
  machine as you. A Git worktree is not a sandbox. Workers are told to stay in
  their worktree and avoid Git mutations and background processes, but shell
  access is host access. Starting therefore requires `--allow-host-shell`.
- **Approval protects honest clients.** The approval digest guarantees that the
  supervisor and worker run the specification you reviewed. It is not
  authentication: any process running as your user can write task records.
- **No integration.** A task never commits, pushes, merges, or opens a pull
  request.

## Limitations

- macOS and Linux only. Windows, container sandboxing, and automatic
  integration are not included.
- `coral jobs` takes `--cwd` per subcommand; the global `-C` flag does not apply
  to it.
- There are no cleanup commands yet for retained worktrees, branches, and task
  directories.
