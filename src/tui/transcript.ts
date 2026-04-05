// src/tui/transcript.ts
// format conversation blocks into viewport-ready lines

import chalk from "chalk";
import wrapAnsi from "wrap-ansi";
import { renderMarkdownToAnsi } from "./markdown.js";

export interface OutputBlock {
  type: "user" | "assistant" | "tool" | "error";
  content: string;
}

function wrapLines(text: string, width: number, indent = ""): string[] {
  const visibleWidth = Math.max(width - indent.length, 12);

  return text.split("\n").flatMap((line) => {
    if (!line) return [""];

    return wrapAnsi(line, visibleWidth, {
      hard: false,
      trim: false,
      wordWrap: true,
    })
      .split("\n")
      .map((wrappedLine) => indent + wrappedLine);
  });
}

function formatBlock(block: OutputBlock, width: number): string[] {
  switch (block.type) {
    case "user":
      return [
        chalk.bold.green("You"),
        ...wrapLines(block.content, width, `${chalk.green("❯")} `),
      ];
    case "assistant":
      return [
        chalk.bold.cyan("Coral"),
        ...wrapLines(renderMarkdownToAnsi(block.content), width, "  "),
      ];
    case "tool":
      return [
        chalk.dim("Tool"),
        ...wrapLines(chalk.dim(block.content), width, "  "),
      ];
    case "error":
      return [
        chalk.bold.red("Error"),
        ...wrapLines(chalk.red(block.content), width, "  "),
      ];
  }
}

export function buildTranscriptLines(blocks: OutputBlock[], streaming: string, width: number): string[] {
  const transcript: string[] = [];

  for (const block of blocks) {
    if (transcript.length > 0) transcript.push("");
    transcript.push(...formatBlock(block, width));
  }

  if (streaming) {
    if (transcript.length > 0) transcript.push("");
    transcript.push(
      chalk.bold.cyan("Coral"),
      ...wrapLines(renderMarkdownToAnsi(streaming), width, "  "),
    );
  }

  return transcript;
}

export function maxScrollOffset(totalLines: number, viewportHeight: number): number {
  return Math.max(totalLines - viewportHeight, 0);
}

export function sliceViewport(lines: string[], viewportHeight: number, scrollOffset: number): string[] {
  const clampedOffset = Math.min(scrollOffset, maxScrollOffset(lines.length, viewportHeight));
  const end = Math.max(lines.length - clampedOffset, 0);
  const start = Math.max(end - viewportHeight, 0);
  return lines.slice(start, end);
}
