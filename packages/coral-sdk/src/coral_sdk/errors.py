# packages/coral-sdk/src/coral_sdk/errors.py
# typed errors for coral exec usage, failure, cancel, protocol, and binary

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from coral_sdk.events import CoralExecResult


class CoralError(Exception):
    """Base error for the unpublished coral exec SDK."""


class CoralUsageError(CoralError):
    """Raised for empty/conflicting prompts, bad cwd/model, or exit 2."""


class CoralFailedError(CoralError):
    """Raised when exec finishes `status: failed` or exit 1."""

    def __init__(
        self,
        message: str,
        *,
        result: CoralExecResult | None = None,
        exit_code: int | None = None,
    ) -> None:
        super().__init__(message)
        self.result = result
        self.exit_code = exit_code


class CoralCancelledError(CoralError):
    """Raised for `status: cancelled` or 130/143 without a forced failed result."""

    def __init__(
        self,
        message: str,
        *,
        result: CoralExecResult | None = None,
        exit_code: int | None = None,
    ) -> None:
        super().__init__(message)
        self.result = result
        self.exit_code = exit_code


class CoralProtocolError(CoralError):
    """Raised for malformed NDJSON, unknown event type, or a missing result."""


class CoralBinaryError(CoralError):
    """Raised when the coral/node executable cannot be found or spawned."""
