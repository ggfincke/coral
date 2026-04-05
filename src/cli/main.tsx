#!/usr/bin/env node
// src/cli/main.tsx
// CLI entry point — parse args & render TUI

import React from "react";
import { render } from "ink";
import { Command } from "commander";
import App from "../tui/App.js";
import { listSessions, getLatestSession, loadSession, sessionExists } from "../session/store.js";

const program = new Command()
  .name("coral")
  .description("A CLI/TUI coding agent for Ollama")
  .version("0.0.1")
  .option("-m, --model <model>", "Ollama model to use")
  .option("--host <url>", "Ollama host URL", "http://localhost:11434")
  .option("--yolo", "skip all tool approval prompts (auto-accept everything)")
  .option("--resume", "resume the most recent session")
  .option("--session <id>", "resume a specific session by ID")
  .option("--sessions", "list saved sessions & exit")
  .parse(process.argv);

const opts = program.opts<{
  model?: string;
  host: string;
  yolo: boolean;
  resume: boolean;
  session?: string;
  sessions: boolean;
}>();

// handle --sessions: list & exit
if (opts.sessions) {
  const sessions = listSessions();

  if (sessions.length === 0) {
    console.log("No saved sessions.");
  } else {
    console.log(`${sessions.length} saved session(s):\n`);

    for (const s of sessions) {
      const date = new Date(s.updatedAt).toLocaleString();
      console.log(`  ${s.id}  ${s.model}  ${date}  (${s.messageCount} msgs)`);
      console.log(`         ${s.title}`);
      console.log();
    }

    console.log("Resume with: coral --session <id>");
  }

  process.exit(0);
}

// resolve session to resume (if any)
let resumeSessionId: string | undefined;

if (opts.session) {
  if (!sessionExists(opts.session)) {
    console.error(`Session not found: ${opts.session}`);
    console.error("Run coral --sessions to see available sessions.");
    process.exit(1);
  }
  resumeSessionId = opts.session;
} else if (opts.resume) {
  const latest = getLatestSession();
  if (!latest) {
    console.error("No sessions to resume.");
    process.exit(1);
  }
  resumeSessionId = latest.id;
}

render(
  <App
    model={opts.model}
    host={opts.host}
    yolo={opts.yolo ?? false}
    resumeSessionId={resumeSessionId}
  />,
);
