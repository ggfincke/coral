# packages/coral-plugins/examples/wordcount.py
# read-only word count over an explicit workspace path

from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel, Field

from coral_plugins.tool import tool

# MCP cwd is always $HOME (Coral launchCwd in src/config/mcp.ts). relative
# paths resolve against home, not the project; require an absolute path.
MAX_READ_BYTES = 8 * 1024 * 1024


class WordCountArgs(BaseModel):
    """Absolute workspace path to a UTF-8 file whose words should be counted."""

    path: str = Field(
        description=(
            "absolute path to a file in the workspace. MCP cwd is $HOME, "
            "not the project; relative paths are rejected"
        )
    )


# whitespace-split; matches str.split with no args
def count_text_words(text: str) -> int:
    return len(text.split())


# read one utf-8 file and return a short word/char summary
@tool(
    WordCountArgs,
    description=(
        "count whitespace-separated words in one UTF-8 file. pass an absolute "
        "workspace path; MCP cwd is $HOME, never the project. read-only"
    ),
)
def word_count(args: WordCountArgs) -> str:
    target = Path(args.path).expanduser()
    if not target.is_absolute():
        return (
            "error: path must be absolute. MCP cwd is always $HOME "
            "(Coral launchCwd), never the workspace"
        )
    if not target.exists():
        return f"error: path does not exist: {target}"
    if not target.is_file():
        return (
            f"error: path is not a file: {target}. pass a file, not a directory"
        )
    size = target.stat().st_size
    if size > MAX_READ_BYTES:
        return (
            f"error: file is {size} bytes; this example reads at most "
            f"{MAX_READ_BYTES} bytes"
        )
    try:
        text = target.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return f"error: not utf-8 text: {target}"
    except OSError as exc:
        return f"error: could not read {target}: {exc}"

    words = count_text_words(text)
    return f"path: {target}\nfiles: 1\nwords: {words}\nchars: {len(text)}"
