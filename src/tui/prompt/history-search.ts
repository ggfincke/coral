// src/tui/prompt/history-search.ts
// pure reverse-search state machine over prompt history entries

export interface HistorySearchState
{
  // whether search mode owns the composer's key handling
  readonly active: boolean
  readonly query: string
  // index into the entries array of the shown match; -1 = none yet
  readonly matchIndex: number
}

export const IDLE_HISTORY_SEARCH: HistorySearchState = {
  active: false,
  query: '',
  matchIndex: -1,
}

export interface HistorySearchText
{
  readonly text: string
}

// scan newest -> oldest for a case-insensitive substring hit, considering
// only indices strictly below fromExclusive (cycling support)
export function findHistoryMatchIndex(
  entries: readonly HistorySearchText[],
  query: string,
  fromExclusive: number = entries.length
): number
{
  const needle = query.toLowerCase()
  if (!needle) return -1

  const start = Math.min(fromExclusive, entries.length)
  for (let i = start - 1; i >= 0; i--)
  {
    if ((entries[i]?.text ?? '').toLowerCase().includes(needle)) return i
  }

  return -1
}

export function startHistorySearch(): HistorySearchState
{
  return { active: true, query: '', matchIndex: -1 }
}

export function updateHistorySearchQuery(
  entries: readonly HistorySearchText[],
  state: HistorySearchState,
  query: string
): HistorySearchState
{
  return {
    ...state,
    query,
    matchIndex: findHistoryMatchIndex(entries, query),
  }
}

// ctrl+r again walks to the next-older match; staying put when exhausted
export function cycleHistorySearchMatch(
  entries: readonly HistorySearchText[],
  state: HistorySearchState
): HistorySearchState
{
  const fromExclusive =
    state.matchIndex >= 0 ? state.matchIndex : entries.length
  const next = findHistoryMatchIndex(entries, state.query, fromExclusive)

  if (next < 0) return state
  return { ...state, matchIndex: next }
}

// text the composer should preview, or null when nothing matches yet
export function historySearchPreview(
  entries: readonly HistorySearchText[],
  state: HistorySearchState
): string | null
{
  if (!state.active || state.matchIndex < 0) return null
  return entries[state.matchIndex]?.text ?? null
}
