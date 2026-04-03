// src/tui/App.tsx
// main TUI component w/ streaming output & tool display

import React, { useState, useCallback } from "react";
import { Box, Text, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
import { Agent } from "../agent/agent.js";

interface Props {
  model: string;
}

interface OutputBlock {
  type: "user" | "assistant" | "tool" | "error";
  content: string;
}

export default function App({ model }: Props) {
  const { exit } = useApp();
  const [input, setInput] = useState("");
  const [output, setOutput] = useState<OutputBlock[]>([]);
  const [streaming, setStreaming] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [agent] = useState(() => new Agent(model));

  useInput((_, key) => {
    if (key.escape) exit();
  });

  // handle user input submission
  const handleSubmit = useCallback(
    async (value: string) => {
      if (!value.trim() || isRunning) return;

      setInput("");
      setOutput((prev) => [...prev, { type: "user", content: value }]);
      setIsRunning(true);
      setStreaming("");

      await agent.run(value, {
        onToken(token) {
          setStreaming((prev) => prev + token);
        },
        onToolCall(name, args) {
          setOutput((prev) => [
            ...prev,
            { type: "tool", content: `[tool] ${name}(${JSON.stringify(args)})` },
          ]);
        },
        onToolResult(name, _result, error) {
          if (error) {
            setOutput((prev) => [
              ...prev,
              { type: "error", content: `[${name} error] ${error}` },
            ]);
          }
        },
        onDone() {
          setStreaming((current) => {
            if (current) {
              setOutput((prev) => [
                ...prev,
                { type: "assistant", content: current },
              ]);
            }
            return "";
          });
          setIsRunning(false);
        },
        onError(error) {
          setOutput((prev) => [
            ...prev,
            { type: "error", content: error.message },
          ]);
          setStreaming("");
          setIsRunning(false);
        },
      });
    },
    [agent, isRunning],
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
