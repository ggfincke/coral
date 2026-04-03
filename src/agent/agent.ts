// src/agent/agent.ts
// conversation loop w/ tool-use cycling

import { OllamaClient } from "../ollama/client.js";
import type { OllamaMessage, ChatResponse } from "../ollama/client.js";
import { allTools, getToolByName, toolToOllamaFormat } from "../tools/index.js";
import { buildSystemPrompt } from "./system-prompt.js";

// callbacks for streaming tokens, tool calls, & completion
export interface AgentEvents {
  onToken: (token: string) => void;
  onToolCall: (name: string, args: Record<string, unknown>) => void;
  onToolResult: (name: string, result: string, error?: string) => void;
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

    // inject system prompt as first message
    const systemContent = buildSystemPrompt({
      model,
      cwd: cwd ?? process.cwd(),
      tools: allTools,
    });
    this.messages.push({ role: "system", content: systemContent });
  }

  // return a copy of the conversation history
  getMessages(): OllamaMessage[] {
    return [...this.messages];
  }

  // run a user message through the agent loop
  async run(userMessage: string, events: AgentEvents): Promise<void> {
    this.messages.push({ role: "user", content: userMessage });

    const ollamaTools = allTools.map(toolToOllamaFormat);

    // keep going while the model wants to call tools
    while (true) {
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

      // execute each tool call & feed results back
      for (const call of toolCalls) {
        const toolName = call.function.name;
        const toolArgs = call.function.arguments;
        events.onToolCall(toolName, toolArgs);

        const tool = getToolByName(toolName);
        if (!tool) {
          const errorMsg = `Unknown tool: ${toolName}`;
          events.onToolResult(toolName, "", errorMsg);
          this.messages.push({ role: "tool", content: errorMsg });
          continue;
        }

        const result = await tool.execute(toolArgs);
        events.onToolResult(toolName, result.output, result.error);
        this.messages.push({
          role: "tool",
          content: result.error
            ? `Error: ${result.error}\n${result.output}`
            : result.output,
        });
      }
    }
  }
}
