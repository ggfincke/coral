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
  .option("-m, --model <model>", "Ollama model to use", "devstral")
  .option("--host <url>", "Ollama host URL", "http://localhost:11434")
  .parse(process.argv);

const opts = program.opts<{ model: string; host: string }>();

render(<App model={opts.model} host={opts.host} />);
