// tests/tools.test.ts
// regression tests for file-discovery tools

import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { setCwd } from "../src/cwd.js";
import { globTool } from "../src/tools/glob.js";
import { listFilesTool } from "../src/tools/list-files.js";

const tempDirs: string[] = [];
const originalCwd = process.cwd();
const hasRipgrep = spawnSync("rg", ["--version"]).status === 0;

// restore temp dirs & cwd after tests finish
after(async () => {
  setCwd(originalCwd);
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

test("list_files renders nested entries under the correct parent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coral-tree-"));
  tempDirs.push(dir);

  await mkdir(join(dir, "nested"));
  await mkdir(join(dir, "other"));
  await writeFile(join(dir, "alpha.txt"), "alpha\n", "utf-8");
  await writeFile(join(dir, "nested", "child.txt"), "child\n", "utf-8");
  await writeFile(join(dir, "other", "deep.txt"), "deep\n", "utf-8");

  setCwd(dir);
  const result = await listFilesTool.execute({ path: ".", depth: 2 });

  assert.equal(result.error, undefined);
  assert.deepEqual(result.output.split("\n"), [
    `${dir}/`,
    "  alpha.txt",
    "  nested/",
    "    child.txt",
    "  other/",
    "    deep.txt",
  ]);
});

test("glob returns the newest modified file first", { skip: !hasRipgrep }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "coral-glob-"));
  tempDirs.push(dir);

  const oldPath = join(dir, "old.txt");
  const newPath = join(dir, "new.txt");

  await writeFile(oldPath, "old\n", "utf-8");
  await writeFile(newPath, "new\n", "utf-8");

  const oldTime = new Date("2024-01-01T01:01:00.000Z");
  const newTime = new Date("2025-01-01T01:01:00.000Z");

  await utimes(oldPath, oldTime, oldTime);
  await utimes(newPath, newTime, newTime);

  setCwd(dir);
  const result = await globTool.execute({ pattern: "*.txt" });

  assert.equal(result.error, undefined);
  assert.deepEqual(result.output.split("\n"), [newPath, oldPath]);
});
