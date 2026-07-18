// src/tui/prompt/prompt-input.tsx
// inline prompt input with unified keyboard, wheel, and safe text insertion

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text } from 'ink'
import chalk from 'chalk'
import { useCoralInput } from '../input/use-coral-input.js'
import {
  isParsedControlSequence,
  isParsedControlFragment,
  type CoralKey,
} from '../input/terminal-input.js'
import { matchPromptKeybinding } from '../input/keybindings.js'
import { applyPromptEdit } from './prompt-edit.js'
import {
  applyCompletion,
  detectCompletion,
  rankCommands,
  rankFiles,
  type CommandSummary,
  type CompletionItem,
} from './completion.js'
import CompletionMenu from './completion-menu.js'
import { resetPromptFileSuggestions } from './prompt-file-suggestions.js'
import { renderPromptValueWithCursor } from './prompt-render.js'

export interface PromptInputProps
{
  value: string
  placeholder?: string
  focus?: boolean
  showCursor?: boolean
  filesCacheKey?: string
  completionCommands?: CommandSummary[]
  refreshFiles?: () => Promise<string[]>
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
  onOpenPalette: () => void
  onHistoryUp: () => void
  onHistoryDown: () => void
}

interface CursorState
{
  value: string
  cursorOffset: number
  cursorWidth: number
}

export default function PromptInput({
  value,
  placeholder = '',
  focus = true,
  showCursor = true,
  filesCacheKey,
  completionCommands = [],
  refreshFiles,
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
  onOpenPalette,
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
  const filesCacheKeyRef = useRef(filesCacheKey)
  const fileRequestIdRef = useRef(0)
  const mountedRef = useRef(true)
  const pendingTerminalSequenceRef = useRef('')
  // move the cursor to the end when external value changes invalidate its
  // controlled position
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

  // active completion span and ranked suggestions under the cursor
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

  // reset cwd-bound completion state before starting a new-cwd refresh
  const needFiles = query?.kind === 'file'
  useEffect(() =>
  {
    if (filesCacheKeyRef.current === filesCacheKey) return
    filesCacheKeyRef.current = filesCacheKey
    fileRequestIdRef.current += 1

    const reset = resetPromptFileSuggestions()
    setFiles(reset.files)
    setSelectedIndex(reset.selectedIndex)
    setDismissed(reset.dismissed)
  }, [filesCacheKey])

  useEffect(() =>
  {
    mountedRef.current = true
    return () =>
    {
      mountedRef.current = false
    }
  }, [])

  // refresh whenever a fresh @-mention query opens
  useEffect(() =>
  {
    if (!needFiles || !refreshFiles)
    {
      fileRequestIdRef.current += 1
      return
    }

    const requestId = ++fileRequestIdRef.current
    const requestCacheKey = filesCacheKey
    void refreshFiles()
      .then((loaded) =>
      {
        if (
          mountedRef.current &&
          fileRequestIdRef.current === requestId &&
          filesCacheKeyRef.current === requestCacheKey
        )
        {
          setFiles(loaded)
        }
      })
      .catch(() => undefined)

    return () =>
    {
      if (fileRequestIdRef.current === requestId) fileRequestIdRef.current += 1
    }
  }, [filesCacheKey, needFiles, refreshFiles])

  // splice the highlighted suggestion into the prompt and close the menu
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

      const binding = matchPromptKeybinding(input, key)
      if (binding === 'page-up')
      {
        onPageUp()
        return
      }
      if (binding === 'page-down')
      {
        onPageDown()
        return
      }
      if (binding === 'toggle-thinking')
      {
        onToggleThinking()
        return
      }
      if (binding === 'toggle-permissions')
      {
        onTogglePermissions()
        return
      }
      if (binding === 'open-palette')
      {
        onOpenPalette()
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
        // reset the cursor after a real submit so later history recall does not
        // reuse a stale mid-text position
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
        // typing or deleting reopens a dismissed menu and resets the highlight;
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
      onOpenPalette,
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
