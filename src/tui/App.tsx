// src/tui/App.tsx
// main TUI component w/ model picking, approvals, & scrollback

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { Agent } from "../agent/agent.js";
import { OllamaClient, type Model } from "../ollama/client.js";
import { buildModelPickerLines, sortModels } from "./model-picker.js";
import { buildTranscriptLines, maxScrollOffset, sliceViewport, type OutputBlock } from "./transcript.js";

interface Props {
  model?: string;
  host: string;
  yolo: boolean;
}

interface ApprovalPrompt {
  toolName: string;
  args: Record<string, unknown>;
  resolve: (approved: boolean) => void;
}

type PickerState = "hidden" | "loading" | "ready" | "error";

const FLUSH_INTERVAL = 32;

function formatApprovalArgs(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "bash") return String(args.command ?? "");
  if (toolName === "write_file" || toolName === "edit_file") return String(args.path ?? "");
  return JSON.stringify(args);
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function buildApprovalLines(approval: ApprovalPrompt, width: number): string[] {
  const summary = formatApprovalArgs(approval.toolName, approval.args);
  const lines = [`Allow ${approval.toolName}`, summary || "(no arguments)"];

  return lines.flatMap((line, index) => {
    if (!line) return [""];

    const maxWidth = Math.max(width, 16);
    const wrapped = line.length > maxWidth
      ? line.match(new RegExp(`.{1,${maxWidth}}`, "g")) ?? [line]
      : [line];

    return wrapped.map((wrappedLine) => (index === 0 ? wrappedLine : `  ${wrappedLine}`));
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export default function App({ model, host, yolo }: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const terminal = stdout as typeof process.stdout;

  const [activeModel, setActiveModel] = useState(model ?? "");
  const [agent, setAgent] = useState<Agent | null>(() => (model ? new Agent(model, host) : null));
  const [pickerState, setPickerState] = useState<PickerState>(model ? "hidden" : "loading");
  const [pickerError, setPickerError] = useState("");
  const [models, setModels] = useState<Model[]>([]);
  const [selectedModelIndex, setSelectedModelIndex] = useState(0);
  const [input, setInput] = useState("");
  const [output, setOutput] = useState<OutputBlock[]>([]);
  const [streaming, setStreaming] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [approval, setApproval] = useState<ApprovalPrompt | null>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [terminalSize, setTerminalSize] = useState({
    columns: terminal.columns ?? 80,
    rows: terminal.rows ?? 24,
  });

  const streamingRef = useRef("");
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousLineCountRef = useRef(0);

  const transcriptWidth = Math.max(terminalSize.columns - 2, 20);
  const approvalLines = approval ? buildApprovalLines(approval, transcriptWidth) : [];
  const chatViewportHeight = Math.max(
    terminalSize.rows - 1 - (approval ? approvalLines.length + 1 : 2),
    6,
  );
  const pickerViewportHeight = Math.max(terminalSize.rows - 2, 6);
  const transcriptLines = buildTranscriptLines(output, streaming, transcriptWidth);
  const maxOffset = maxScrollOffset(transcriptLines.length, chatViewportHeight);
  const visibleTranscript = sliceViewport(transcriptLines, chatViewportHeight, scrollOffset);
  const paddedTranscript = [
    ...Array(Math.max(chatViewportHeight - visibleTranscript.length, 0)).fill(""),
    ...visibleTranscript,
  ];

  const pickerLines = pickerState === "ready"
    ? buildModelPickerLines(models, selectedModelIndex, transcriptWidth, pickerViewportHeight)
    : pickerState === "loading"
      ? [
          "Loading Ollama models…",
          `Host: ${host}`,
        ]
      : [
          "Failed to load Ollama models",
          `Host: ${host}`,
          "",
          pickerError,
        ];
  const visiblePicker = [
    ...Array(Math.max(pickerViewportHeight - pickerLines.length, 0)).fill(""),
    ...pickerLines.slice(-pickerViewportHeight),
  ];

  const flushStreaming = useCallback(() => {
    flushTimerRef.current = null;
    setStreaming(streamingRef.current);
  }, []);

  const activateModel = useCallback((nextModel: string) => {
    setActiveModel(nextModel);
    setAgent(new Agent(nextModel, host));
    setPickerState("hidden");
  }, [host]);

  const loadModels = useCallback(async () => {
    setPickerState("loading");
    setPickerError("");

    try {
      const client = new OllamaClient(host);
      const loadedModels = sortModels(await client.listModels());

      if (loadedModels.length === 1) {
        activateModel(loadedModels[0]!.name);
        return;
      }

      setModels(loadedModels);
      setSelectedModelIndex(0);
      setPickerState("ready");
    } catch (err) {
      setPickerError(toErrorMessage(err));
      setPickerState("error");
    }
  }, [activateModel, host]);

  useEffect(() => {
    const updateSize = () => {
      setTerminalSize({
        columns: terminal.columns ?? 80,
        rows: terminal.rows ?? 24,
      });
    };

    updateSize();
    terminal.on?.("resize", updateSize);

    return () => {
      terminal.off?.("resize", updateSize);
    };
  }, [terminal]);

  useEffect(() => {
    if (model) return;
    void loadModels();
  }, [loadModels, model]);

  useEffect(() => {
    const nextLineCount = transcriptLines.length;
    const previousLineCount = previousLineCountRef.current;

    if (scrollOffset > 0 && nextLineCount > previousLineCount) {
      setScrollOffset((current) => current + (nextLineCount - previousLineCount));
    }

    previousLineCountRef.current = nextLineCount;
  }, [output, scrollOffset, streaming, transcriptLines.length]);

  useEffect(() => {
    setScrollOffset((current) => Math.min(current, maxOffset));
  }, [maxOffset]);

  useInput((ch, key) => {
    if (approval) {
      if (ch === "y" || ch === "Y") {
        approval.resolve(true);
        setApproval(null);
      } else if (ch === "n" || ch === "N" || key.escape) {
        approval.resolve(false);
        setApproval(null);
      }
      return;
    }

    if (!agent) {
      if (pickerState === "loading") {
        if (key.escape) exit();
        return;
      }

      if (pickerState === "error") {
        if (ch === "r" || ch === "R") {
          void loadModels();
        } else if (key.escape) {
          exit();
        }
        return;
      }

      if (key.upArrow || ch === "k") {
        setSelectedModelIndex((current) => clamp(current - 1, 0, models.length - 1));
      } else if (key.downArrow || ch === "j") {
        setSelectedModelIndex((current) => clamp(current + 1, 0, models.length - 1));
      } else if (key.return) {
        const selected = models[selectedModelIndex];
        if (selected) activateModel(selected.name);
      } else if (key.escape) {
        exit();
      }
      return;
    }

    if (key.pageUp) {
      setScrollOffset((current) => clamp(current + Math.max(chatViewportHeight - 1, 1), 0, maxOffset));
      return;
    }

    if (key.pageDown) {
      setScrollOffset((current) => clamp(current - Math.max(chatViewportHeight - 1, 1), 0, maxOffset));
      return;
    }

    if (input.length === 0 && key.upArrow) {
      setScrollOffset((current) => clamp(current + 1, 0, maxOffset));
      return;
    }

    if (input.length === 0 && key.downArrow) {
      setScrollOffset((current) => clamp(current - 1, 0, maxOffset));
      return;
    }

    if (key.escape) {
      exit();
    }
  });

  const handleSubmit = useCallback(
    async (value: string) => {
      if (!agent || !value.trim() || isRunning || approval) return;

      setInput("");
      setScrollOffset(0);
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
          if (flushTimerRef.current) {
            clearTimeout(flushTimerRef.current);
            flushTimerRef.current = null;
          }

          const pending = streamingRef.current;
          streamingRef.current = "";
          setStreaming("");

          setOutput((prev) => {
            const next = [...prev];

            if (pending) {
              next.push({ type: "assistant", content: pending });
            }

            next.push({ type: "tool", content: `[tool] ${name}(${JSON.stringify(args)})` });
            return next;
          });
        },
        onToolApproval(name, args) {
          if (yolo) return Promise.resolve(true);

          return new Promise<boolean>((resolve) => {
            setApproval({ toolName: name, args, resolve });
          });
        },
        onToolResult(name, result, error) {
          if (error) {
            setOutput((prev) => [...prev, { type: "error", content: `[${name} error] ${error}` }]);
            return;
          }

          if (!result) return;

          const maxResultLines = 30;
          const lines = result.split("\n");
          const truncated = lines.length > maxResultLines
            ? `${lines.slice(0, maxResultLines).join("\n")}\n… (${lines.length - maxResultLines} more lines)`
            : result;

          setOutput((prev) => [...prev, { type: "tool", content: `[${name}] ${truncated}` }]);
        },
        onDone() {
          if (flushTimerRef.current) {
            clearTimeout(flushTimerRef.current);
            flushTimerRef.current = null;
          }

          const final = streamingRef.current;
          if (final) {
            setOutput((prev) => [...prev, { type: "assistant", content: final }]);
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

          setOutput((prev) => [...prev, { type: "error", content: error.message }]);
          setStreaming("");
          streamingRef.current = "";
          setIsRunning(false);
        },
      });
    },
    [agent, approval, flushStreaming, isRunning, yolo],
  );

  const statusLine = !agent
    ? pickerState === "loading"
      ? "Loading models from Ollama…"
      : pickerState === "error"
        ? "press r to retry · esc to quit"
        : `${models.length} models available · enter selects · esc quits`
    : approval
      ? "press y to approve · n or esc to reject"
      : scrollOffset > 0
        ? `scrollback active · ${scrollOffset} lines above live · pgdn returns toward live`
        : isRunning
          ? "running · ↑↓ or pgup/pgdn scroll · esc quits"
          : "ready · ↑↓ or pgup/pgdn scroll · esc quits";

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold color="cyan">coral</Text>
        <Text dimColor>{activeModel ? ` · ${activeModel}` : " · pick a model"}</Text>
        {yolo && <Text color="yellow" bold> · yolo</Text>}
      </Text>

      {agent ? (
        <Box flexDirection="column">
          {paddedTranscript.map((line, index) => (
            <Text key={index}>{line}</Text>
          ))}
        </Box>
      ) : (
        <Box flexDirection="column">
          {visiblePicker.map((line, index) => (
            <Text key={index}>{line}</Text>
          ))}
        </Box>
      )}

      {agent && approval && (
        <Box flexDirection="column">
          {approvalLines.map((line, index) => (
            <Text key={index} color={index === 0 ? "yellow" : undefined}>
              {line}
            </Text>
          ))}
        </Box>
      )}

      {agent && !approval && (
        <Box>
          <Text bold color="green">{"❯ "}</Text>
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={handleSubmit}
            placeholder={isRunning ? "thinking..." : "ask coral anything"}
          />
        </Box>
      )}

      <Text dimColor>{statusLine}</Text>
    </Box>
  );
}
