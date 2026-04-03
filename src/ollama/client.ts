// src/ollama/client.ts
// Ollama REST API client w/ streaming chat

// JSON Schema subset for tool parameters
export interface JsonSchema {
  type: "object";
  properties: Record<string, {
    type: string;
    description?: string;
    enum?: string[];
  }>;
  required?: string[];
}

// chat message
export interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
}

// tool call returned by the model
export interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

// tool definition sent to the model
export interface OllamaTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
}

// request payload for /api/chat
export interface ChatRequest {
  model: string;
  messages: OllamaMessage[];
  stream?: boolean;
  tools?: OllamaTool[];
}

// response chunk from /api/chat
export interface ChatResponse {
  message: OllamaMessage;
  done: boolean;
  done_reason?: string;
}

// model metadata from /api/tags
export interface Model {
  name: string;
  size: number;
  modified_at: string;
}

// * Ollama REST API client
export class OllamaClient {
  constructor(private baseUrl = "http://localhost:11434") {}

  // fetch available models from the Ollama instance
  async listModels(): Promise<Model[]> {
    const res = await fetch(`${this.baseUrl}/api/tags`);
    if (!res.ok) throw new Error(`Ollama API error: ${res.status}`);
    const data = (await res.json()) as { models: Model[] };
    return data.models;
  }

  // stream chat completions via ndjson
  async *chatStream(request: ChatRequest): AsyncGenerator<ChatResponse> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...request, stream: true }),
    });

    if (!res.ok) throw new Error(`Ollama API error: ${res.status}`);
    if (!res.body) throw new Error("No response body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    // collect partial-line chunks in an array to avoid O(n²) string concat
    const remainderParts: string[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      remainderParts.push(decoder.decode(value, { stream: true }));
      const joined = remainderParts.join("");
      remainderParts.length = 0;

      const lines = joined.split("\n");
      const tail = lines.pop() ?? "";
      if (tail) remainderParts.push(tail);

      for (const line of lines) {
        if (line.trim()) {
          yield JSON.parse(line) as ChatResponse;
        }
      }
    }

    const final = remainderParts.join("");
    if (final.trim()) {
      yield JSON.parse(final) as ChatResponse;
    }
  }
}
