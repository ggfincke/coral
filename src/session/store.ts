// src/session/store.ts
// session persistence — save & resume conversations to/from disk

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import type { OllamaMessage } from "../ollama/client.js";

// where sessions live on disk
const SESSIONS_DIR = join(homedir(), ".coral", "sessions");

// session metadata stored alongside the conversation
export interface SessionMeta {
  // unique session ID (8-char hex)
  id: string;
  // model used for the session
  model: string;
  // absolute working directory at session start
  cwd: string;
  // ISO timestamp of session creation
  createdAt: string;
  // ISO timestamp of last update
  updatedAt: string;
  // first user message (for display in session list)
  title: string;
  // total number of messages (excluding system prompt)
  messageCount: number;
}

// full session on disk
interface SessionFile {
  meta: SessionMeta;
  messages: OllamaMessage[];
}

// summary for listing sessions (no messages loaded)
export interface SessionSummary {
  id: string;
  model: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  messageCount: number;
}

// generate an 8-char hex session ID
function generateId(): string {
  return randomBytes(4).toString("hex");
}

// extract a title from the first user message
function extractTitle(messages: OllamaMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return "(empty session)";

  const text = firstUser.content.trim();
  // truncate long messages for the title
  if (text.length > 80) return text.slice(0, 77) + "…";
  return text;
}

// ensure the sessions directory exists
function ensureDir(): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
}

// get the file path for a session ID
function sessionPath(id: string): string {
  return join(SESSIONS_DIR, `${id}.json`);
}

// create a new session & persist it
export function createSession(model: string, cwd: string, messages: OllamaMessage[]): SessionMeta {
  ensureDir();

  const id = generateId();
  const now = new Date().toISOString();
  const nonSystemMessages = messages.filter((m) => m.role !== "system");

  const meta: SessionMeta = {
    id,
    model,
    cwd,
    createdAt: now,
    updatedAt: now,
    title: extractTitle(messages),
    messageCount: nonSystemMessages.length,
  };

  const file: SessionFile = { meta, messages };
  writeFileSync(sessionPath(id), JSON.stringify(file, null, 2), "utf-8");

  return meta;
}

// save (update) an existing session
export function saveSession(id: string, model: string, cwd: string, messages: OllamaMessage[]): SessionMeta {
  ensureDir();

  const existing = loadSessionFile(id);
  const nonSystemMessages = messages.filter((m) => m.role !== "system");

  const meta: SessionMeta = {
    id,
    model,
    cwd,
    createdAt: existing?.meta.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    title: existing?.meta.title ?? extractTitle(messages),
    messageCount: nonSystemMessages.length,
  };

  const file: SessionFile = { meta, messages };
  writeFileSync(sessionPath(id), JSON.stringify(file, null, 2), "utf-8");

  return meta;
}

// load a session file by ID (returns null if not found/corrupt)
function loadSessionFile(id: string): SessionFile | null {
  try {
    const raw = readFileSync(sessionPath(id), "utf-8");
    return JSON.parse(raw) as SessionFile;
  } catch {
    return null;
  }
}

// load a session's messages by ID
export function loadSession(id: string): { meta: SessionMeta; messages: OllamaMessage[] } | null {
  const file = loadSessionFile(id);
  if (!file) return null;
  return { meta: file.meta, messages: file.messages };
}

// list all sessions, sorted by updatedAt (newest first)
export function listSessions(): SessionSummary[] {
  ensureDir();

  const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
  const summaries: SessionSummary[] = [];

  for (const file of files) {
    try {
      const raw = readFileSync(join(SESSIONS_DIR, file), "utf-8");
      const session = JSON.parse(raw) as SessionFile;

      summaries.push({
        id: session.meta.id,
        model: session.meta.model,
        cwd: session.meta.cwd,
        createdAt: session.meta.createdAt,
        updatedAt: session.meta.updatedAt,
        title: session.meta.title,
        messageCount: session.meta.messageCount,
      });
    } catch {
      // skip corrupt session files
    }
  }

  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// get the most recently updated session (for --resume)
export function getLatestSession(): SessionSummary | null {
  const sessions = listSessions();
  return sessions.length > 0 ? sessions[0]! : null;
}

// check if a session exists
export function sessionExists(id: string): boolean {
  return existsSync(sessionPath(id));
}
