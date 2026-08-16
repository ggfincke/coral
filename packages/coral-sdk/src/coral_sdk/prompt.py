# packages/coral-sdk/src/coral_sdk/prompt.py
# choose positional prompt vs --prompt-file and refuse payloads over 1 MiB

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal
import os
import tempfile

from coral_sdk.errors import CoralUsageError

# match src/cli/exec.ts MAX_PROMPT_BYTES
MAX_PROMPT_BYTES = 1_048_576

# stay under typical ARG_MAX including env; over this, write a prompt file
ARGV_PROMPT_MAX_BYTES = 64 * 1024

PromptFileMode = bool | str | Path | None


@dataclass(frozen=True)
class PromptPlan:
    """How one prompt will be passed to coral exec (positional xor file)."""

    positional: str | None
    prompt_file: Path | None
    temp_file: Path | None


# utf-8 byte length, matching exec's buffer.byteLength check
def prompt_byte_length(text: str) -> int:
    return len(text.encode("utf-8"))


# unlink a helper tempfile; ignore races if exec already released it
def cleanup_prompt_plan(plan: PromptPlan) -> None:
    if plan.temp_file is None:
        return
    try:
        plan.temp_file.unlink()
    except FileNotFoundError:
        return
    except OSError:
        return


# decide positional vs --prompt-file; refuse over-cap before spawn
def plan_prompt(
    prompt: str,
    *,
    prompt_file: PromptFileMode = None,
) -> PromptPlan:
    if not prompt.strip():
        raise CoralUsageError("a nonempty prompt is required")
    size = prompt_byte_length(prompt)
    if size > MAX_PROMPT_BYTES:
        raise CoralUsageError(
            f"prompt exceeds {MAX_PROMPT_BYTES} bytes ({size}); "
            "coral exec caps --prompt-file at 1 MiB"
        )

    force_file = prompt_file is True
    dest: Path | None = None
    if isinstance(prompt_file, (str, Path)) and prompt_file is not True:
        dest = Path(prompt_file)

    use_file = force_file or dest is not None or size > ARGV_PROMPT_MAX_BYTES
    if not use_file:
        return PromptPlan(positional=prompt, prompt_file=None, temp_file=None)

    temp_file: Path | None = None
    if dest is None:
        fd, name = tempfile.mkstemp(prefix="coral-sdk-prompt-", suffix=".txt")
        os.close(fd)
        dest = Path(name)
        temp_file = dest
    plan = PromptPlan(positional=None, prompt_file=dest, temp_file=temp_file)
    try:
        dest.write_text(prompt, encoding="utf-8")
    except BaseException:
        cleanup_prompt_plan(plan)
        raise
    return plan


# exported for tests that want the cap constant without importing exec
def prompt_file_mode_name(mode: PromptFileMode) -> Literal["auto", "force", "path"]:
    if mode is True:
        return "force"
    if isinstance(mode, (str, Path)):
        return "path"
    return "auto"
