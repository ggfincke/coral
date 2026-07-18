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
- **TUI Logic**: Critical prompt editing, keypress parsing, transcript rendering, and session restoration helpers
- **Persistence**: Session, prompt-history, undo/redo, and local telemetry storage, including isolated test homes
- **MCP boundaries**: Three major integration scenarios cover user-owned launch
  config, fingerprint trust, and the exact `always_deny` pre-launch block; the
  Agent-mediated strict stdio bridge (a real SDK subprocess driven through a
  fake model, asserting context-budgeted advertised tools, strict validation,
  bounded/redacted large results, disable, and trusted re-enable at the
  model-request boundary); and ordered two-worker startup, abort, and lifecycle
  cleanup. Two narrow causal seam cases additionally pin raw-schema validation
  versus sanitized model projection and fail-closed negative protocol-result
  conversion.

We intentionally do not test:

- Every edge case or configuration combination
- Full React Ink component rendering or layout snapshots
- Exhaustive MCP server/config/protocol combinations beyond the critical
  integration and causal boundary scenarios
- Cosmetic-only TUI formatting
- Ollama model behavior or output quality
- Utility functions with obvious behavior (single ternary, field projection)
- CLI arg parsing (commander handles this)

## Running Tests

```bash
# run Node tests
npm test

# compile-check Python dev tools and run focused dev-tool checks
npm run check:dev-tools

# typecheck TypeScript eval and benchmark scripts
npm run typecheck:scripts

# run in watch mode
npm run test:watch

# run a specific test file
node --import tsx --test tests/agent/agent.test.ts
```

## Adding Tests

Before adding a new test, ask:

1. Does this test a critical path that would break core functionality if it failed?
2. Is this behavior not already covered by existing tests?
3. Can this be tested as a pure function or narrowly scoped hook/helper?
4. Would breakage cause significant user impact (broken tool calls, corrupted files, lost conversation state)?

If yes to all four, add the test. Otherwise, consider whether it's truly necessary.
