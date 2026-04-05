// src/tui/model-picker.ts
// format startup model selection for the TUI

import chalk from "chalk";
import wrapAnsi from "wrap-ansi";
import type { Model } from "../ollama/client.js";

function parseModifiedAt(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function formatSize(size: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = size;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function wrapLine(line: string, width: number): string[] {
  if (!line) return [""];

  return wrapAnsi(line, Math.max(width, 16), {
    hard: false,
    trim: false,
    wordWrap: true,
  }).split("\n");
}

export function sortModels(models: Model[]): Model[] {
  return [...models].sort((left, right) => {
    const dateDiff = parseModifiedAt(right.modified_at) - parseModifiedAt(left.modified_at);
    if (dateDiff !== 0) return dateDiff;
    return left.name.localeCompare(right.name);
  });
}

export function buildModelPickerLines(
  models: Model[],
  selectedIndex: number,
  width: number,
  height: number,
): string[] {
  if (models.length === 0) {
    return [
      chalk.bold.red("No Ollama models found"),
      chalk.dim("Pull a model or pass --model explicitly."),
    ];
  }

  const visibleCount = Math.max(height - 6, 3);
  const start = Math.max(
    0,
    Math.min(
      selectedIndex - Math.floor(visibleCount / 2),
      Math.max(models.length - visibleCount, 0),
    ),
  );
  const end = Math.min(start + visibleCount, models.length);
  const selected = models[Math.min(selectedIndex, models.length - 1)]!;
  const lines: string[] = [
    chalk.bold.cyan("Select an Ollama model"),
    chalk.dim("enter selects · ↑↓ or j/k moves · esc quits"),
    "",
  ];

  for (let index = start; index < end; index += 1) {
    const model = models[index]!;
    const prefix = index === selectedIndex ? chalk.cyan("›") : chalk.dim(" ");
    lines.push(...wrapLine(`${prefix} ${model.name}`, width));
  }

  lines.push("");
  lines.push(...wrapLine(chalk.dim(`Selected: ${selected.name}`), width));
  lines.push(...wrapLine(chalk.dim(`Size: ${formatSize(selected.size)}`), width));
  lines.push(...wrapLine(chalk.dim(`Modified: ${selected.modified_at}`), width));

  if (models.length > visibleCount) {
    lines.push("");
    lines.push(chalk.dim(`Showing ${start + 1}-${end} of ${models.length}`));
  }

  return lines;
}
