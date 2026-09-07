// src/tui/run/message-queue.ts
// pure FIFO queue for prompts typed while a run is active

export interface QueuedMessage
{
  readonly id: number
  readonly text: string
}

export interface MessageQueueState
{
  readonly entries: readonly QueuedMessage[]
  readonly nextId: number
}

// bound the visible backlog; each entry still carries full text
export const MAX_QUEUED_MESSAGES = 10
const MAX_QUEUE_LINE_CHARS = 120

export function emptyMessageQueue(): MessageQueueState
{
  return { entries: [], nextId: 1 }
}

export function enqueueMessage(
  state: MessageQueueState,
  rawText: string
): MessageQueueState
{
  const text = rawText.trim()
  if (!text) return state
  if (state.entries.length >= MAX_QUEUED_MESSAGES) return state

  return {
    entries: [...state.entries, { id: state.nextId, text }],
    nextId: state.nextId + 1,
  }
}

export function removeQueuedMessage(
  state: MessageQueueState,
  id: number
): MessageQueueState
{
  return {
    ...state,
    entries: state.entries.filter((entry) => entry.id !== id),
  }
}

export function editQueuedMessage(
  state: MessageQueueState,
  id: number,
  rawText: string
): MessageQueueState
{
  const text = rawText.trim()
  if (!text) return removeQueuedMessage(state, id)

  return {
    ...state,
    entries: state.entries.map((entry) =>
      entry.id === id ? { ...entry, text } : entry
    ),
  }
}

export interface DequeuedMessage
{
  readonly state: MessageQueueState
  readonly message: QueuedMessage
}

// pop the oldest entry for autosend; null when nothing is waiting
export function dequeueOldestMessage(
  state: MessageQueueState
): DequeuedMessage | null
{
  const oldest = state.entries[0]
  if (!oldest) return null

  return {
    state: {
      ...state,
      entries: state.entries.slice(1),
    },
    message: oldest,
  }
}

// take the newest entry back into the composer for editing
export function promoteNewestForEdit(
  state: MessageQueueState
): DequeuedMessage | null
{
  const newest = state.entries[state.entries.length - 1]
  if (!newest) return null

  return {
    state: {
      ...state,
      entries: state.entries.slice(0, -1),
    },
    message: newest,
  }
}

// single-line preview rows for the composer area
export function formatQueueLines(entries: readonly QueuedMessage[]): string[]
{
  return entries.map((entry) =>
  {
    const flat = entry.text.replace(/\s+/g, ' ')
    const text =
      flat.length > MAX_QUEUE_LINE_CHARS
        ? `${flat.slice(0, MAX_QUEUE_LINE_CHARS - 1)}…`
        : flat
    return `queued #${entry.id}: ${text}`
  })
}
