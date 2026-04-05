// src/agent/agent.ts
// conversation loop w/ tool-use cycling

import { OllamaClient } from "../ollama/client.js";
import type { OllamaMessage, ChatResponse } from "../ollama/client.js";
import { allTools, getToolByName, toolToOllamaFormat } from "../tools/index.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { setCwd, getCwd } from "../cwd.js";

// pre-compute Ollama tool format (static after registration)
const ollamaTools = allTools.map(toolToOllamaFormat);

// max messages to keep in history (system prompt + recent context)
const MAX_HISTORY = 100;

// tools that require user approval before execution
const TOOLS_REQUIRING_APPROVAL = new Set(["write_file", "edit_file", "bash"]);

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
      let toolCalls: ChatResponse["message"]["tool_calls"] = undefined;

      try {
        for await (const chunk of this.client.chatStream({
          model: this.model,
          messages: this.messages,
          tools: ollamaTools,
        })) {
          if (chunk.message.content) {
            fullContent += chunk.message.content;
            events.onToken(chunk.message.content);
          }
          if (chunk.message.tool_calls) {
            toolCalls = chunk.message.tool_calls;
          }
        }
      } catch (err) {
        events.onError(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      // record assistant message
      const assistantMessage: OllamaMessage = {
        role: "assistant",
        content: fullContent,
      };
      if (toolCalls) {
        assistantMessage.tool_calls = toolCalls;
      }
      this.messages.push(assistantMessage);

      // no tool calls means the model is done
      if (!toolCalls || toolCalls.length === 0) {
        events.onDone();
        return;
      }

      // execute tool calls sequentially (approval requires serial flow)
      const toolResults: OllamaMessage[] = [];
      for (const call of toolCalls) {
        const toolName = call.function.name;
        const toolArgs = call.function.arguments;
        events.onToolCall(toolName, toolArgs);

        const tool = getToolByName(toolName);
        if (!tool) {
          const errorMsg = `Unknown tool: ${toolName}`;
          events.onToolResult(toolName, "", errorMsg);
          toolResults.push({ role: "tool", content: errorMsg });
          continue;
        }

        // gate dangerous tools behind user approval
        if (TOOLS_REQUIRING_APPROVAL.has(toolName)) {
          const approved = await events.onToolApproval(toolName, toolArgs);
          if (!approved) {
            const rejectedMsg = `Tool call rejected by user`;
            events.onToolResult(toolName, "", rejectedMsg);
            toolResults.push({ role: "tool", content: rejectedMsg });
            continue;
          }
        }

        const result = await tool.execute(toolArgs);
        events.onToolResult(toolName, result.output, result.error);
        toolResults.push({
          role: "tool",
          content: result.error
            ? `Error: ${result.error}\n${result.output}`
            : result.output,
        });
      }

      this.messages.push(...toolResults);
    }
  }
}
