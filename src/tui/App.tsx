// src/tui/App.tsx
// main TUI component w/ streaming output & tool display

import React, { useState, useCallback, useRef } from "react";
import { Box, Text, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
import { Agent } from "../agent/agent.js";

interface Props {
  model: string;
  host: string;
}

interface OutputBlock {
  type: "user" | "assistant" | "tool" | "error";
  content: string;
}

// pending approval prompt state
interface ApprovalPrompt {
  toolName: string;
  args: Record<string, unknown>;
  resolve: (approved: boolean) => void;
}

// throttle interval for batching streamed tokens (~30fps)
const FLUSH_INTERVAL = 32;

// format tool args for the approval prompt — show the most relevant arg
function formatApprovalArgs(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "bash") return String(args.command ?? "");
  if (toolName === "write_file" || toolName === "edit_file") return String(args.path ?? "");
  return JSON.stringify(args);
}

export default function App({ model, host }: Props) {
  const { exit } = useApp();
  const [input, setInput] = useState("");
  const [output, setOutput] = useState<OutputBlock[]>([]);
  const [streaming, setStreaming] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [agent] = useState(() => new Agent(model, host));
  const [approval, setApproval] = useState<ApprovalPrompt | null>(null);

  // refs for throttled token streaming
  const streamingRef = useRef("");
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushStreaming = useCallback(() => {
    flushTimerRef.current = null;
    setStreaming(streamingRef.current);
  }, []);

  useInput((ch, key) => {
    if (key.escape) exit();

    // handle approval prompt: y to approve, n/esc to reject
    if (approval) {
      if (ch === "y" || ch === "Y") {
        approval.resolve(true);
        setApproval(null);
      } else if (ch === "n" || ch === "N") {
        approval.resolve(false);
        setApproval(null);
      }
    }
  });

  // handle user input submission
  const handleSubmit = useCallback(
    async (value: string) => {
      if (!value.trim() || isRunning) return;

      setInput("");
      setOutput((prev) => [...prev, { type: "user", content: value }]);
      setIsRunning(true);
      setStreaming("");
      streamingRef.current = "";

      await agent.run(value, {
        onToken(token) {
          streamingRef.current += token;
          if (!flushTimerRef.current) {
            flushTimerRef.current = setTimeout(flushStreaming, FLUSH_INTERVAL);
          }
        },
        onToolCall(name, args) {
          // flush any accumulated thinking text before showing the tool call
          if (flushTimerRef.current) {
            clearTimeout(flushTimerRef.current);
            flushTimerRef.current = null;
          }
          const pending = streamingRef.current;
          if (pending) {
            streamingRef.current = "";
            setStreaming("");
            setOutput((prev) => [
              ...prev,
              { type: "assistant", content: pending },
              { type: "tool", content: `[tool] ${name}(${JSON.stringify(args)})` },
            ]);
          } else {
            setOutput((prev) => [
              ...prev,
              { type: "tool", content: `[tool] ${name}(${JSON.stringify(args)})` },
            ]);
          }
        },
        onToolApproval(name, args) {
          return new Promise<boolean>((resolve) => {
            setApproval({ toolName: name, args, resolve });
          });
        },
        onToolResult(name, result, error) {
          if (error) {
            setOutput((prev) => [
              ...prev,
              { type: "error", content: `[${name} error] ${error}` },
            ]);
          } else if (result) {
            // truncate long results to keep TUI readable
            const MAX_RESULT_LINES = 30;
            const lines = result.split("\n");
            const truncated =
              lines.length > MAX_RESULT_LINES
                ? lines.slice(0, MAX_RESULT_LINES).join("\n") +
                  `\n… (${lines.length - MAX_RESULT_LINES} more lines)`
                : result;
            setOutput((prev) => [
              ...prev,
              { type: "tool", content: `[${name}] ${truncated}` },
            ]);
          }
        },
        onDone() {
          // flush any pending tokens immediately
          if (flushTimerRef.current) {
            clearTimeout(flushTimerRef.current);
            flushTimerRef.current = null;
          }

          const final = streamingRef.current;
          if (final) {
            setOutput((prev) => [
              ...prev,
              { type: "assistant", content: final },
            ]);
          }
          setStreaming("");
          streamingRef.current = "";
          setIsRunning(false);
        },
        onError(error) {
          if (flushTimerRef.current) {
            clearTimeout(flushTimerRef.current);
            flushTimerRef.current = null;
          }
          setOutput((prev) => [
            ...prev,
            { type: "error", content: error.message },
          ]);
          setStreaming("");
          streamingRef.current = "";
          setIsRunning(false);
        },
      });
    },
    [agent, isRunning, flushStreaming],
  );

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          coral
        </Text>
        <Text dimColor> · {model} · </Text>
        <Text dimColor>esc to quit</Text>
      </Box>

      {output.map((block, i) => (
        <Box key={i} marginBottom={block.type === "user" ? 0 : 1}>
          {block.type === "user" && (
            <Text>
              <Text bold color="green">
                {"❯ "}
              </Text>
              {block.content}
            </Text>
          )}
          {block.type === "assistant" && <Text>{block.content}</Text>}
          {block.type === "tool" && <Text dimColor>{block.content}</Text>}
          {block.type === "error" && (
            <Text color="red">{block.content}</Text>
          )}
        </Box>
      ))}

      {streaming && (
        <Box marginBottom={1}>
          <Text>{streaming}</Text>
        </Box>
      )}

      {approval && (
        <Box flexDirection="column" marginBottom={1}>
          <Box>
            <Text bold color="yellow">
              {"⚡ "}
            </Text>
            <Text bold>
              Allow {approval.toolName}
            </Text>
            <Text dimColor>
              ({formatApprovalArgs(approval.toolName, approval.args)})
            </Text>
          </Box>
          <Box>
            <Text dimColor>  press </Text>
            <Text bold color="green">y</Text>
            <Text dimColor> to approve · </Text>
            <Text bold color="red">n</Text>
            <Text dimColor> to reject</Text>
          </Box>
        </Box>
      )}

      <Box>
        <Text bold color="green">
          {"❯ "}
        </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          placeholder={isRunning ? "thinking..." : "ask coral anything"}
        />
      </Box>
    </Box>
  );
}
