// tests/context.test.ts
// tests for context injection at startup

import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { gatherProjectContext } from "../src/agent/context.js";

const tempDirs: string[] = [];

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

test("gatherProjectContext returns empty string for empty directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coral-ctx-"));
  tempDirs.push(dir);

  const ctx = gatherProjectContext(dir);
  assert.equal(ctx, "");
});

test("gatherProjectContext loads README.md", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coral-ctx-"));
  tempDirs.push(dir);

  await writeFile(join(dir, "README.md"), "# Test Project\n\nA test fixture.\n", "utf-8");

  const ctx = gatherProjectContext(dir);
  assert.match(ctx, /# Test Project/);
  assert.match(ctx, /README/);
});

test("gatherProjectContext loads package.json & detects Node.js project", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coral-ctx-"));
  tempDirs.push(dir);

  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "test-fixture", version: "1.0.0" }),
    "utf-8",
  );

  const ctx = gatherProjectContext(dir);
  assert.match(ctx, /package\.json/);
  assert.match(ctx, /Node\.js\/JavaScript/);
  assert.match(ctx, /test-fixture/);
});

test("gatherProjectContext detects Python projects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coral-ctx-"));
  tempDirs.push(dir);

  await writeFile(
    join(dir, "pyproject.toml"),
    '[project]\nname = "my-project"\nversion = "0.1.0"\n',
    "utf-8",
  );

  const ctx = gatherProjectContext(dir);
  assert.match(ctx, /Python/);
  assert.match(ctx, /pyproject\.toml/);
});

test("gatherProjectContext detects Rust projects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coral-ctx-"));
  tempDirs.push(dir);

  await writeFile(
    join(dir, "Cargo.toml"),
    '[package]\nname = "my-crate"\nversion = "0.1.0"\n',
    "utf-8",
  );

  const ctx = gatherProjectContext(dir);
  assert.match(ctx, /Rust/);
  assert.match(ctx, /Cargo\.toml/);
});

test("gatherProjectContext detects Go projects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coral-ctx-"));
  tempDirs.push(dir);

  await writeFile(join(dir, "go.mod"), "module example.com/mymod\n\ngo 1.21\n", "utf-8");

  const ctx = gatherProjectContext(dir);
  assert.match(ctx, /Go/);
  assert.match(ctx, /go\.mod/);
});

test("gatherProjectContext loads multiple files in priority order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coral-ctx-"));
  tempDirs.push(dir);

  await writeFile(join(dir, "README.md"), "# My App\n", "utf-8");
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "my-app" }),
    "utf-8",
  );
  await writeFile(join(dir, "Dockerfile"), "FROM node:20\n", "utf-8");

  const ctx = gatherProjectContext(dir);
  assert.match(ctx, /README/);
  assert.match(ctx, /package\.json/);
  assert.match(ctx, /Dockerfile/);
});

test("gatherProjectContext prioritizes .coral.md over other files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coral-ctx-"));
  tempDirs.push(dir);

  await writeFile(join(dir, ".coral.md"), "# Project Instructions\nDo this.\n", "utf-8");
  await writeFile(join(dir, "README.md"), "# My Project\n", "utf-8");

  const ctx = gatherProjectContext(dir);
  // .coral.md should appear (it's first priority)
  assert.match(ctx, /Project Instructions/);
});

test("gatherProjectContext includes directory tree", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coral-ctx-"));
  tempDirs.push(dir);

  await writeFile(join(dir, "README.md"), "# Test\n", "utf-8");
  await mkdir(join(dir, "src"));
  await writeFile(join(dir, "src", "index.ts"), "// entry\n", "utf-8");

  const ctx = gatherProjectContext(dir);
  assert.match(ctx, /Directory structure/);
  assert.match(ctx, /src\//);
});

test("gatherProjectContext truncates large files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coral-ctx-"));
  tempDirs.push(dir);

  // create a file larger than MAX_FILE_BYTES (8192)
  const bigContent = "x".repeat(10_000);
  await writeFile(join(dir, "README.md"), bigContent, "utf-8");

  const ctx = gatherProjectContext(dir);
  assert.match(ctx, /truncated/);
  // should not contain the full 10k content
  assert.ok(ctx.length < bigContent.length);
});

test("gatherProjectContext skips empty files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coral-ctx-"));
  tempDirs.push(dir);

  await writeFile(join(dir, "README.md"), "", "utf-8");
  await writeFile(join(dir, "package.json"), '{"name":"test"}', "utf-8");

  const ctx = gatherProjectContext(dir);
  // should load package.json but not the empty README
  assert.match(ctx, /package\.json/);
  assert.doesNotMatch(ctx, /### README/);
});
