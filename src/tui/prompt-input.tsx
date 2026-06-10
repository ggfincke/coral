// src/tui/prompt-input.tsx
// inline prompt input w/ unified keyboard, wheel, & safe text insertion

import React, { useCallback, useMemo, useRef, useState } from 'react'
import { Text } from 'ink'
import chalk from 'chalk'
import {
  useCoralInput,
  isParsedControlSequence,
  isParsedControlFragment,
  type CoralKey,
} from './use-coral-input.js'
import { applyPromptEdit } from './prompt-edit.js'

export interface PromptInputProps
{
  value: string
  placeholder?: string
  focus?: boolean
  showCursor?: boolean
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

export function isThinkingToggleShortcut(
  input: string,
  key: CoralKey
): boolean
{
  return key.ctrl && input.toLowerCase() === 't'
}

export function isPermissionToggleShortcut(
  input: string,
  key: CoralKey
): boolean
{
  return key.ctrl && input.toLowerCase() === 'y'
}

export default function PromptInput({
  value,
  placeholder = '',
  focus = true,
  showCursor = true,
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

  let renderedValue = value
  let renderedPlaceholder = placeholder ? chalk.grey(placeholder) : undefined

  // render a fake cursor so Coral never writes raw cursor escapes
  if (showCursor && focus)
  {
    renderedPlaceholder =
      placeholder.length > 0
        ? chalk.inverse(placeholder[0]) + chalk.grey(placeholder.slice(1))
        : chalk.inverse(' ')

    renderedValue = value.length > 0 ? '' : chalk.inverse(' ')

    let index = 0
    for (const char of value)
    {
      renderedValue +=
        index >= resolvedCursor.cursorOffset - resolvedCursor.cursorWidth &&
        index <= resolvedCursor.cursorOffset
          ? chalk.inverse(char)
          : char
      index += 1
    }

    if (value.length > 0 && resolvedCursor.cursorOffset === value.length)
    {
      renderedValue += chalk.inverse(' ')
    }
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
      if (isThinkingToggleShortcut(input, key))
      {
        onToggleThinking()
        return
      }
      if (isPermissionToggleShortcut(input, key))
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
      if (key.tab || (key.shift && key.tab))
      {
        return
      }
      if (key.return)
      {
        onSubmit(value)
        // a real submit clears the field — reset the cursor so a later history
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
      }
    },
    [
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

  return (
    <Text>
      {placeholder
        ? value.length > 0
          ? renderedValue
          : renderedPlaceholder
        : renderedValue}
    </Text>
  )
}
