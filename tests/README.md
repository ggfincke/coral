# Tests

This directory contains the test suite for Coral.

## Philosophy

**Only major, important tests — not exhaustive coverage.**

We focus on testing critical pure-function logic that, if broken, would cause significant user impact:

- **Tool Execution**: File read/write/edit correctness, bash output capture, search result formatting
- **Agent Loop**: Tool call detection, tool dispatch, message history construction, error propagation
- **System Prompt**: Prompt assembly w/ CWD, tool descriptions, project context
- **Ollama Client**: Request/response serialization, ndjson stream parsing, error handling
- **Path Resolution**: CWD-relative path handling across tools

We intentionally do not test:

- Every edge case or configuration combination
- React Ink components or hooks
- TUI rendering or layout
- Ollama model behavior or output quality
- Utility functions with obvious behavior (single ternary, field projection)
- CLI arg parsing (commander handles this)

## Running Tests

```bash
# run all tests
npm test

# run in watch mode
npm run test:watch

# run a specific test file
node --import tsx --test tests/agent.test.ts
```

## Adding Tests

Before adding a new test, ask:

1. Does this test a critical path that would break core functionality if it failed?
2. Is this behavior not already covered by existing tests?
3. Can this be tested as a pure function without DOM or mocking?
4. Would breakage cause significant user impact (broken tool calls, corrupted files, lost conversation state)?

If yes to all four, add the test. Otherwise, consider whether it's truly necessary.
