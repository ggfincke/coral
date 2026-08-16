# packages/coral-backend/src/coral_backend/errors.py
# request-scoped worker failures that must not kill the process


class WorkerError(Exception):
    """Fail one in-flight request with a protocol `kind: error` frame."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
