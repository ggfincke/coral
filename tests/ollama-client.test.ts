// tests/ollama-client.test.ts
// regression tests for Ollama keep-alive behavior

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { OllamaClient } from "../src/ollama/client.js";

function buildNdjsonResponse(lines: unknown[]): Response {
  return new Response(
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" },
    },
  );
}

test("chatStream defaults keep_alive to 10m", async () => {
  const originalFetch = globalThis.fetch;
  const requests: unknown[] = [];

  globalThis.fetch = (async (_input, init) => {
    requests.push(JSON.parse(String(init?.body ?? "{}")));

    return buildNdjsonResponse([
      {
        message: {
          role: "assistant",
          content: "done",
        },
        done: true,
      },
    ]);
  }) as typeof fetch;

  try {
    const client = new OllamaClient("http://localhost:11434");
    const chunks = [];

    for await (const chunk of client.chatStream({
      model: "fake-model",
      messages: [{ role: "user", content: "hello" }],
    })) {
      chunks.push(chunk);
    }

    assert.equal(chunks.length, 1);
    assert.deepEqual(requests, [
      {
        model: "fake-model",
        messages: [{ role: "user", content: "hello" }],
        keep_alive: "10m",
        stream: true,
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unloadModel sends keep_alive 0 for immediate shutdown", async () => {
  const originalFetch = globalThis.fetch;
  const requests: unknown[] = [];

  globalThis.fetch = (async (_input, init) => {
    requests.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  try {
    const client = new OllamaClient("http://localhost:11434");
    client.startKeepAlive("fake-model");

    await client.unloadModel();

    assert.deepEqual(requests, [
      {
        model: "fake-model",
        messages: [],
        keep_alive: 0,
        stream: false,
        options: { num_predict: 0 },
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
