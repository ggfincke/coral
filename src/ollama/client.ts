// src/ollama/client.ts
// Ollama REST API client w/ streaming & non-streaming chat

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
    parameters: Record<string, unknown>;
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
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.trim()) {
          yield JSON.parse(line) as ChatResponse;
        }
      }
    }

    if (buffer.trim()) {
      yield JSON.parse(buffer) as ChatResponse;
    }
  }

  // send a non-streaming chat request
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...request, stream: false }),
    });

    if (!res.ok) throw new Error(`Ollama API error: ${res.status}`);
    return (await res.json()) as ChatResponse;
  }
}
