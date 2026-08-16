# packages/coral-sdk/src/coral_sdk/client.py
# async-first CoralClient: stream() and run() over one coral exec turn

from __future__ import annotations

from collections.abc import AsyncIterator, Callable, Mapping
from pathlib import Path
from typing import TYPE_CHECKING, Literal, Self
import asyncio
import os

from coral_sdk.errors import (
    CoralCancelledError,
    CoralFailedError,
    CoralProtocolError,
    CoralUsageError,
)
from coral_sdk.events import (
    CoralExecEvent,
    CoralExecResult,
    ResultEvent,
    parse_event,
    result_from_event,
)
from coral_sdk.prompt import (
    PromptFileMode,
    PromptPlan,
    cleanup_prompt_plan,
    plan_prompt,
)
from coral_sdk.transport import Transport

if TYPE_CHECKING:
    from coral_sdk.sync import SyncCoralClient

PermissionProfile = Literal["read-only", "workspace-write"]

# catalogs from docs/cli.md; exec enforces these, the SDK does not
READ_ONLY_TOOLS: tuple[str, ...] = (
    "read_file",
    "grep",
    "glob",
    "list_files",
    "search_code",
    "skill",
    "code_intel",
    "git_status",
    "git_diff",
    "git_log",
)
WORKSPACE_WRITE_EXTRA_TOOLS: tuple[str, ...] = (
    "write_file",
    "edit_file",
    "bash",
)
PROFILE_EXCLUDED_TOOLS: tuple[str, ...] = (
    "git_add",
    "git_commit",
    "git_switch",
    "git_push",
    "task",
    "todo_write",
)

_COMMANDER_HELP_CODES = frozenset({0})


def _default_transport() -> Transport:
    from coral_sdk.subprocess import SubprocessTransport

    return SubprocessTransport()


def _stderr_of(transport: Transport) -> str:
    text = getattr(transport, "stderr_text", "")
    return text.strip() if isinstance(text, str) else ""


# result.status wins over the wait code so runError-beats-cancel is not hidden
def raise_for_outcome(
    result: ResultEvent | None,
    exit_code: int,
    *,
    stderr: str = "",
) -> None:
    detail = f" (stderr: {stderr[:500]})" if stderr else ""
    typed = result_from_event(result) if result is not None else None
    if result is not None:
        if result.status == "failed":
            message = result.error or "coral exec failed"
            raise CoralFailedError(
                f"{message}{detail}",
                result=typed,
                exit_code=exit_code,
            )
        if result.status == "cancelled":
            raise CoralCancelledError(
                f"coral exec cancelled{detail}",
                result=typed,
                exit_code=exit_code,
            )
        if result.status == "completed":
            return
        raise CoralProtocolError(
            f"unknown exec status {result.status!r}{detail}"
        )
    if exit_code == 2:
        raise CoralUsageError(f"coral exec usage error (exit 2){detail}")
    if exit_code in (130, 143):
        raise CoralCancelledError(
            f"coral exec cancelled (exit {exit_code}){detail}",
            exit_code=exit_code,
        )
    if exit_code == 1:
        raise CoralFailedError(
            f"coral exec failed (exit 1){detail}",
            exit_code=exit_code,
        )
    if exit_code in _COMMANDER_HELP_CODES:
        raise CoralProtocolError(f"missing terminal result{detail}")
    raise CoralUsageError(
        f"coral exec exited {exit_code} (commander/parse){detail}"
    )


class CoralClient:
    """Async client for one-shot `coral exec` turns over stream-json NDJSON."""

    def __init__(
        self,
        model: str,
        *,
        cwd: str | Path | None = None,
        host: str | None = None,
        permission_profile: PermissionProfile = "read-only",
        mcp: bool = False,
        output: str = "stream-json",
        result_file: str | Path | None = None,
        prompt_file: PromptFileMode = None,
        bin: str | Path | None = None,
        env: Mapping[str, str] | None = None,
        transport_factory: Callable[[], Transport] | None = None,
    ) -> None:
        trimmed = model.strip()
        if not trimmed:
            raise CoralUsageError("model must be nonempty")
        if permission_profile not in ("read-only", "workspace-write"):
            raise CoralUsageError(
                "permission_profile must be 'read-only' or 'workspace-write'"
            )
        if output != "stream-json":
            raise CoralUsageError(
                "coral_sdk always requests --output-format stream-json"
            )
        self._model = trimmed
        self._cwd = Path(cwd) if cwd is not None else None
        self._host = host
        self._permission_profile: PermissionProfile = permission_profile
        self._mcp = mcp
        self._result_file = Path(result_file) if result_file is not None else None
        self._prompt_file = prompt_file
        self._bin = bin
        self._env = dict(env) if env is not None else None
        self._injected = transport_factory is not None
        self._transport_factory = transport_factory or _default_transport
        self._active: Transport | None = None
        self._argv_prefix: list[str] | None = None

    @classmethod
    def sync(
        cls,
        model: str,
        *,
        cwd: str | Path | None = None,
        host: str | None = None,
        permission_profile: PermissionProfile = "read-only",
        mcp: bool = False,
        output: str = "stream-json",
        result_file: str | Path | None = None,
        prompt_file: PromptFileMode = None,
        bin: str | Path | None = None,
        env: Mapping[str, str] | None = None,
        transport_factory: Callable[[], Transport] | None = None,
    ) -> SyncCoralClient:
        from coral_sdk.sync import SyncCoralClient

        return SyncCoralClient(
            cls(
                model,
                cwd=cwd,
                host=host,
                permission_profile=permission_profile,
                mcp=mcp,
                output=output,
                result_file=result_file,
                prompt_file=prompt_file,
                bin=bin,
                env=env,
                transport_factory=transport_factory,
            )
        )

    async def __aenter__(self) -> Self:
        if not self._injected:
            from coral_sdk.subprocess import discover_coral_command

            self._argv_prefix = discover_coral_command(
                self._bin, env=self._env
            )
        return self

    async def __aexit__(
        self,
        exc_type: object,
        exc: object,
        tb: object,
    ) -> None:
        if self._active is not None:
            self._active.cancel()
            await self._active.wait()
            self._active = None

    # SIGINT the in-flight coral exec; wait() still reports failed-over-cancel
    def cancel(self) -> None:
        if self._active is not None:
            self._active.cancel()

    def _bin_prefix(self) -> list[str]:
        if self._argv_prefix is not None:
            return self._argv_prefix
        if self._injected:
            if self._bin is not None:
                return [str(self._bin)]
            return ["coral"]
        from coral_sdk.subprocess import discover_coral_command

        self._argv_prefix = discover_coral_command(self._bin, env=self._env)
        return self._argv_prefix

    def _build_argv(self, plan: PromptPlan) -> list[str]:
        argv = [
            *self._bin_prefix(),
            "exec",
            "--output-format",
            "stream-json",
            "--model",
            self._model,
            "--permission-profile",
            self._permission_profile,
            "--cwd",
            str(self._cwd) if self._cwd is not None else os.getcwd(),
        ]
        if self._host:
            argv.extend(["--host", self._host])
        argv.append("--mcp" if self._mcp else "--no-mcp")
        if self._result_file is not None:
            argv.extend(["--result-file", str(self._result_file)])
        if plan.prompt_file is not None:
            argv.extend(["--prompt-file", str(plan.prompt_file)])
        elif plan.positional is not None:
            argv.append(plan.positional)
        else:
            raise CoralUsageError("a nonempty prompt is required")
        return argv

    def _spawn_env(self) -> dict[str, str]:
        environ = dict(os.environ) if self._env is None else dict(self._env)
        return environ

    async def stream(self, prompt: str) -> AsyncIterator[CoralExecEvent]:
        if self._cwd is not None and not self._cwd.is_dir():
            raise CoralUsageError(f"not a directory: {self._cwd}")
        plan = plan_prompt(prompt, prompt_file=self._prompt_file)
        try:
            transport = self._transport_factory()
            argv = self._build_argv(plan)
            self._active = transport
            result: ResultEvent | None = None
            started = False
            try:
                await transport.start(argv, self._spawn_env())
                started = True
                try:
                    async for raw in transport.events():
                        event = parse_event(raw)
                        if isinstance(event, ResultEvent):
                            result = event
                        yield event
                except (asyncio.CancelledError, GeneratorExit):
                    transport.cancel()
                    raise
                except CoralProtocolError:
                    transport.cancel()
                    raise
            finally:
                exit_code = -1
                if started:
                    try:
                        exit_code = await transport.wait()
                    except CoralProtocolError:
                        exit_code = -1
                if self._active is transport:
                    self._active = None
            raise_for_outcome(result, exit_code, stderr=_stderr_of(transport))
        finally:
            cleanup_prompt_plan(plan)

    async def run(self, prompt: str) -> CoralExecResult:
        result_event: ResultEvent | None = None
        async for event in self.stream(prompt):
            if isinstance(event, ResultEvent):
                result_event = event
        if result_event is None:
            raise CoralProtocolError("missing terminal result")
        return result_from_event(result_event)
