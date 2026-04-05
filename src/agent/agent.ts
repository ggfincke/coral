// src/agent/agent.ts
// conversation loop w/ tool-use cycling

import { OllamaClient } from "../ollama/client.js";
import type { OllamaMessage, ChatResponse, OllamaToolCall } from "../ollama/client.js";
import { allTools, getToolByName, toolToOllamaFormat } from "../tools/index.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { setCwd, getCwd } from "../cwd.js";

// pre-compute Ollama tool format (static after registration)
const ollamaTools = allTools.map(toolToOllamaFormat);

// max messages to keep in history (system prompt + recent context)
const MAX_HISTORY = 100;

// tools that require user approval before execution
const TOOLS_REQUIRING_APPROVAL = new Set(["write_file", "edit_file", "bash"]);

// merge streamed tool call chunks into a stable ordered list
function mergeToolCalls(existing: OllamaToolCall[], incoming: OllamaToolCall[]): OllamaToolCall[] {
  const merged = [...existing];

  for (const call of incoming) {
    const index = call.function.index;

    if (typeof index === "number") {
      const existingIndex = merged.findIndex((candidate) => candidate.function.index === index);

      if (existingIndex === -1) {
        merged.push(call);
      } else {
        merged[existingIndex] = call;
      }

      continue;
    }

    merged.push(call);
  }

  return merged.sort((a, b) => {
    const left = a.function.index;
    const right = b.function.index;

    if (typeof left === "number" && typeof right === "number") {
      return left - right;
    }
    if (typeof left === "number") return -1;
    if (typeof right === "number") return 1;
    return 0;
  });
}

// normalize unknown thrown values into an Error
function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

// callbacks for streaming tokens, tool calls, & completion
export interface AgentEvents {
  onToken: (token: string) => void;
  onToolCall: (name: string, args: Record<string, unknown>) => void;
  onToolResult: (name: string, result: string, error?: string) => void;
  // return true to approve, false to reject — only called for write/edit/bash
  onToolApproval: (name: string, args: Record<string, unknown>) => Promise<boolean>;
  onDone: () => void;
  onError: (error: Error) => void;
}

// * Conversation agent w/ tool dispatch
export class Agent {
  private client: OllamaClient;
  private messages: OllamaMessage[] = [];
  private model: string;

  constructor(model: string, baseUrl?: string, cwd?: string) {
    this.model = model;
    this.client = new OllamaClient(baseUrl);

    // set the global working directory — all tools resolve paths against this
    if (cwd) setCwd(cwd);

    // inject system prompt as first message
    const systemContent = buildSystemPrompt({
      model,
      cwd: getCwd(),
      tools: allTools,
    });
    this.messages.push({ role: "system", content: systemContent });

    // keep model loaded in memory between requests
    this.client.startKeepAlive(model);
  }

  // run a user message through the agent loop
  async run(userMessage: string, events: AgentEvents): Promise<void> {
    this.messages.push({ role: "user", content: userMessage });

    // keep going while the model wants to call tools
    while (true) {
      // trim history if it grows too large, preserving system prompt
      if (this.messages.length > MAX_HISTORY) {
        const systemMsg = this.messages[0];
        const recent = this.messages.slice(-(MAX_HISTORY - 1));
        this.messages = [systemMsg, ...recent];
      }

      let fullContent = "";
      let fullThinking = "";
      let toolCalls: OllamaToolCall[] = [];

      try {
        for await (const chunk of this.client.chatStream({
          model: this.model,
          messages: this.messages,
          tools: ollamaTools,
        })) {
          if (chunk.message.thinking) {
            fullThinking += chunk.message.thinking;
          }
          if (chunk.message.content) {
            fullContent += chunk.message.content;
            events.onToken(chunk.message.content);
          }
          if (chunk.message.tool_calls?.length) {
            toolCalls = mergeToolCalls(toolCalls, chunk.message.tool_calls);
          }
        }
      } catch (err) {
        events.onError(toError(err));
        return;
      }

      // record assistant message
      const assistantMessage: OllamaMessage = {
        role: "assistant",
        content: fullContent,
      };
      if (fullThinking) {
        assistantMessage.thinking = fullThinking;
      }
      if (toolCalls.length > 0) {
        assistantMessage.tool_calls = toolCalls;
      }
      this.messages.push(assistantMessage);

      // no tool calls means the model is done
      if (toolCalls.length === 0) {
        events.onDone();
        return;
      }

      // execute tool calls sequentially (approval requires serial flow)
      const toolResults: OllamaMessage[] = [];
      for (const call of toolCalls) {
        const toolName = call.function.name;
        const toolArgs = call.function.arguments ?? {};
        events.onToolCall(toolName, toolArgs);

        const tool = getToolByName(toolName);
        if (!tool) {
          const errorMsg = `Unknown tool: ${toolName}`;
          events.onToolResult(toolName, "", errorMsg);
          toolResults.push({ role: "tool", tool_name: toolName, content: errorMsg });
          continue;
        }

        // gate dangerous tools behind user approval
        if (TOOLS_REQUIRING_APPROVAL.has(toolName)) {
          let approved: boolean;
          try {
            approved = await events.onToolApproval(toolName, toolArgs);
          } catch (err) {
            const errorMsg = `Tool approval failed for ${toolName}: ${toError(err).message}`;
            events.onToolResult(toolName, "", errorMsg);
            toolResults.push({ role: "tool", tool_name: toolName, content: errorMsg });
            continue;
          }

          if (!approved) {
            const rejectedMsg = `Tool call rejected by user`;
            events.onToolResult(toolName, "", rejectedMsg);
            toolResults.push({ role: "tool", tool_name: toolName, content: rejectedMsg });
            continue;
          }
        }

        let result;
        try {
          result = await tool.execute(toolArgs);
        } catch (err) {
          result = {
            output: "",
            error: `Tool execution failed for ${toolName}: ${toError(err).message}`,
          };
        }

        events.onToolResult(toolName, result.output, result.error);
        toolResults.push({
          role: "tool",
          tool_name: toolName,
          content: result.error
            ? `Error: ${result.error}\n${result.output}`
            : result.output,
        });
      }

      this.messages.push(...toolResults);
    }
  }
}
