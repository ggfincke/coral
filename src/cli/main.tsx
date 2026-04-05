#!/usr/bin/env node
// src/cli/main.tsx
// CLI entry point — parse args & render TUI

import React from "react";
import { render } from "ink";
import { Command } from "commander";
import App from "../tui/App.js";

const program = new Command()
  .name("coral")
  .description("A CLI/TUI coding agent for Ollama")
  .version("0.0.1")
  .option("-m, --model <model>", "Ollama model to use")
  .option("--host <url>", "Ollama host URL", "http://localhost:11434")
  .option("--yolo", "skip all tool approval prompts (auto-accept everything)")
  .parse(process.argv);

const opts = program.opts<{ model?: string; host: string; yolo: boolean }>();

render(<App model={opts.model} host={opts.host} yolo={opts.yolo ?? false} />);
