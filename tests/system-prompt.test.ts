// tests/system-prompt.test.ts
// regression tests for system prompt project context

import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { buildSystemPrompt } from "../src/agent/system-prompt.js";

const tempDirs: string[] = [];

// remove temp workspaces created during tests
after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

test("buildSystemPrompt includes lightweight project context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coral-prompt-"));
  tempDirs.push(dir);

  await mkdir(join(dir, "src"));
  await writeFile(join(dir, "README.md"), "# Fixture\n", "utf-8");
  await writeFile(join(dir, "package.json"), "{\n  \"name\": \"fixture\"\n}\n", "utf-8");

  const prompt = buildSystemPrompt({
    model: "qwen3-coder:latest",
    cwd: dir,
    tools: [],
  });

  assert.match(prompt, /Running model: qwen3-coder:latest/);
  assert.match(prompt, /## Project Context/);
  assert.match(prompt, /Project name: coral-prompt-/);
  assert.match(prompt, /Top-level entries: package\.json, README\.md, src\//);
});
