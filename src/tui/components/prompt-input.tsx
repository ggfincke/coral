// src/tui/components/prompt-input.tsx
// inline prompt input w/ unified keyboard, wheel, & safe text insertion

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text } from 'ink'
import chalk from 'chalk'
import {
  useCoralInput,
  isParsedControlSequence,
  isParsedControlFragment,
  type CoralKey,
} from '../hooks/use-coral-input.js'
import { applyPromptEdit } from '../prompt/prompt-edit.js'
import {
  applyCompletion,
  detectCompletion,
  rankCommands,
  rankFiles,
  type CommandSummary,
  type CompletionItem,
} from '../prompt/completion.js'
import CompletionMenu from './completion-menu.js'
import { resetPromptFileSuggestions } from '../prompt/prompt-file-suggestions.js'
import { renderPromptValueWithCursor } from '../prompt/prompt-render.js'

export interface PromptInputProps
{
  value: string
  placeholder?: string
  focus?: boolean
  showCursor?: boolean
  filesCacheKey?: string
  completionCommands?: CommandSummary[]
  listFiles?: () => Promise<string[]>
  onChange: (value: string) => void
  onSubmit: (value: string) => void
  onEscape: () => void
  onInterrupt: () => void
  onPageUp: () => void
  onPageDown: () => void
  onScrollUp: () => void
  onScrollDown: () => void
  onToggleThinking: () => void
  onTogglePermissions: () => void
  onHistoryUp: () => void
  onHistoryDown: () => void
}

interface CursorState
{
  value: string
  cursorOffset: number
  cursorWidth: number
}

// ctrl + a specific letter; pass the letter pre-lowercased
function isCtrlLetter(input: string, key: CoralKey, letter: string): boolean
{
  return key.ctrl && input.toLowerCase() === letter
}

export default function PromptInput({
  value,
  placeholder = '',
  focus = true,
  showCursor = true,
  filesCacheKey,
  completionCommands = [],
  listFiles,
  onChange,
  onSubmit,
  onEscape,
  onInterrupt,
  onPageUp,
  onPageDown,
  onScrollUp,
  onScrollDown,
  onToggleThinking,
  onTogglePermissions,
  onHistoryUp,
  onHistoryDown,
}: PromptInputProps)
{
  const [cursor, setCursor] = useState<CursorState>({
    value,
    cursorOffset: value.length,
    cursorWidth: 0,
  })
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [files, setFiles] = useState<string[]>([])
  const filesRequestedRef = useRef(false)
  const filesCacheKeyRef = useRef(filesCacheKey)
  const mountedRef = useRef(true)
  const pendingTerminalSequenceRef = useRef('')
  // cursor is out of sync w/ the controlled value -> the value changed
  // externally (history recall, submit clear), so render the cursor at the end
  const hasExternalValue = value !== cursor.value
  const resolvedCursor = useMemo(
    () =>
      focus && showCursor
        ? {
            value,
            cursorOffset: Math.min(
              Math.max(
                hasExternalValue ? value.length : cursor.cursorOffset,
                0
              ),
              value.length
            ),
            cursorWidth: 0,
          }
        : cursor,
    [cursor, focus, hasExternalValue, showCursor, value]
  )

  // active completion span under the cursor, & its ranked suggestions
  const query = useMemo(
    () => detectCompletion(value, resolvedCursor.cursorOffset),
    [value, resolvedCursor.cursorOffset]
  )
  const items: CompletionItem[] = useMemo(() =>
  {
    if (!query) return []
    if (query.kind === 'command')
      return rankCommands(query.token, completionCommands)
    return rankFiles(query.token, files)
  }, [query, completionCommands, files])
  const menuOpen =
    focus &&
    showCursor &&
    !dismissed &&
    !hasExternalValue &&
    query !== null &&
    items.length > 0
  const safeIndex = Math.min(selectedIndex, items.length - 1)

  // lazily load the project file list the first time an @-mention is typed
  const needFiles = query?.kind === 'file'
  useEffect(() =>
  {
    mountedRef.current = true
    return () =>
    {
      mountedRef.current = false
    }
  }, [])
  useEffect(() =>
  {
    if (!needFiles || !listFiles || filesRequestedRef.current) return
    filesRequestedRef.current = true
    void listFiles()
      .then((loaded) =>
      {
        if (mountedRef.current) setFiles(loaded)
      })
      .catch(() =>
      {
        if (!mountedRef.current) return
        filesRequestedRef.current = false
        setFiles([])
      })
  }, [needFiles, listFiles])

  useEffect(() =>
  {
    if (filesCacheKeyRef.current === filesCacheKey) return
    filesCacheKeyRef.current = filesCacheKey

    const reset = resetPromptFileSuggestions()
    filesRequestedRef.current = reset.filesRequested
    setFiles(reset.files)
    setSelectedIndex(reset.selectedIndex)
    setDismissed(reset.dismissed)
  }, [filesCacheKey])

  // splice the highlighted suggestion into the prompt & close the menu
  const acceptCompletion = useCallback(() =>
  {
    if (!query || items.length === 0) return
    const item = items[Math.min(selectedIndex, items.length - 1)]!
    const next = applyCompletion(value, query, item)
    setCursor({
      value: next.value,
      cursorOffset: next.cursorOffset,
      cursorWidth: 0,
    })
    setSelectedIndex(0)
    if (next.value !== value) onChange(next.value)
  }, [items, onChange, query, selectedIndex, value])

  let renderedValue = value
  let renderedPlaceholder = placeholder ? chalk.grey(placeholder) : undefined

  // render a fake cursor so Coral never writes raw cursor escapes
  if (showCursor && focus)
  {
    renderedPlaceholder =
      placeholder.length > 0
        ? chalk.inverse(placeholder[0]) + chalk.grey(placeholder.slice(1))
        : chalk.inverse(' ')

    renderedValue = renderPromptValueWithCursor(
      value,
      resolvedCursor.cursorOffset,
      resolvedCursor.cursorWidth
    )
  }

  const handleInput = useCallback(
    (input: string, key: CoralKey) =>
    {
      if (pendingTerminalSequenceRef.current)
      {
        const combinedInput = pendingTerminalSequenceRef.current + input

        if (isParsedControlFragment(combinedInput))
        {
          pendingTerminalSequenceRef.current = combinedInput
          return
        }
        if (isParsedControlSequence(combinedInput))
        {
          pendingTerminalSequenceRef.current = ''
          return
        }

        pendingTerminalSequenceRef.current = ''
      }

      // the completion menu owns arrows/tab/enter/escape while it's open
      if (menuOpen)
      {
        if (key.upArrow)
        {
          setSelectedIndex((i) => Math.max(0, i - 1))
          return
        }
        if (key.downArrow)
        {
          setSelectedIndex((i) => Math.min(items.length - 1, i + 1))
          return
        }
        if (key.tab || key.return)
        {
          acceptCompletion()
          return
        }
        if (key.escape)
        {
          setDismissed(true)
          setSelectedIndex(0)
          return
        }
      }

      if (key.pageUp)
      {
        onPageUp()
        return
      }
      if (key.pageDown)
      {
        onPageDown()
        return
      }
      if (key.wheelUp)
      {
        onScrollUp()
        return
      }
      if (key.wheelDown)
      {
        onScrollDown()
        return
      }
      if (key.upArrow)
      {
        onHistoryUp()
        return
      }
      if (key.downArrow)
      {
        onHistoryDown()
        return
      }
      if (isCtrlLetter(input, key, 't'))
      {
        onToggleThinking()
        return
      }
      if (isCtrlLetter(input, key, 'y'))
      {
        onTogglePermissions()
        return
      }
      if (key.escape)
      {
        onEscape()
        return
      }
      if (key.ctrl && input === 'c')
      {
        onInterrupt()
        return
      }
      if (key.tab)
      {
        return
      }
      if (key.return)
      {
        onSubmit(value)
        // a real submit clears the field; reset the cursor so a later history
        // recall of the same text isn't mistaken for the current (now stale)
        // cursor value & left mid-text; skip empty/whitespace (never submitted)
        if (value.trim())
        {
          setCursor({ value: '', cursorOffset: 0, cursorWidth: 0 })
        }
        return
      }
      if (isParsedControlFragment(input))
      {
        pendingTerminalSequenceRef.current = input
        return
      }
      if (isParsedControlSequence(input))
      {
        return
      }
      const nextState = applyPromptEdit({
        value,
        input,
        key,
        cursor: resolvedCursor,
      })
      if (!nextState) return

      setCursor({
        value: nextState.value,
        cursorOffset: nextState.cursorOffset,
        cursorWidth: nextState.cursorWidth,
      })

      if (nextState.value !== value)
      {
        onChange(nextState.value)
        // typing/deleting re-opens a dismissed menu & resets the highlight;
        // a cursor-only move leaves an Esc-dismissed menu closed
        setDismissed(false)
        setSelectedIndex(0)
      }
    },
    [
      acceptCompletion,
      items.length,
      menuOpen,
      onChange,
      onEscape,
      onHistoryDown,
      onHistoryUp,
      onInterrupt,
      onPageDown,
      onPageUp,
      onScrollDown,
      onScrollUp,
      onSubmit,
      onTogglePermissions,
      onToggleThinking,
      resolvedCursor,
      value,
    ]
  )

  useCoralInput(handleInput, { isActive: focus, enableMouseTracking: focus })

  const textLine = (
    <Text>
      {placeholder
        ? value.length > 0
          ? renderedValue
          : renderedPlaceholder
        : renderedValue}
    </Text>
  )

  if (!menuOpen || !query) return textLine

  return (
    <Box flexDirection="column">
      {textLine}
      <CompletionMenu
        items={items}
        selectedIndex={safeIndex}
        kind={query.kind}
      />
    </Box>
  )
}
