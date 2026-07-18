// src/tui/run/use-animation-timer.ts
// spinner/shimmer timer management for visible run-stage animations

import { useCallback, useEffect, useRef, useState } from 'react'
import { clearTimerRef } from './clear-timer-ref.js'
import { isAnimatedRunStage, type RunStage } from './run-stage.js'

export interface AnimationTimerState
{
  spinnerTick: number
  waitingElapsed: number
  showWaitingIndicator: boolean
  startWaiting: () => void
  stopWaiting: () => void
  resetAnimation: () => void
}

// drive only the animations that are currently visible
export function useAnimationTimer(
  runStage: RunStage,
  interval: number
): AnimationTimerState
{
  const waitingStartRef = useRef<number | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const [spinnerTick, setSpinnerTick] = useState(0)
  const [waitingElapsed, setWaitingElapsed] = useState(0)
  const [showWaitingIndicator, setShowWaitingIndicator] = useState(false)

  const startWaiting = useCallback(() =>
  {
    waitingStartRef.current = Date.now()
    setWaitingElapsed(0)
    setShowWaitingIndicator(true)
  }, [])

  const stopWaiting = useCallback(() =>
  {
    waitingStartRef.current = null
    setShowWaitingIndicator(false)
  }, [])

  const resetAnimation = useCallback(() =>
  {
    clearTimerRef(timerRef)

    waitingStartRef.current = null
    setWaitingElapsed(0)
    setShowWaitingIndicator(false)
  }, [])

  useEffect(() =>
  {
    if (!isAnimatedRunStage(runStage)) return

    timerRef.current = setInterval(() =>
    {
      if (runStage === 'waiting' && waitingStartRef.current != null)
      {
        setWaitingElapsed(Date.now() - waitingStartRef.current)
      }

      if (runStage.startsWith('tool:'))
      {
        setSpinnerTick((current) => current + 1)
      }
    }, interval)

    return () =>
    {
      clearTimerRef(timerRef)
    }
  }, [interval, runStage])

  return {
    spinnerTick,
    waitingElapsed,
    showWaitingIndicator,
    startWaiting,
    stopWaiting,
    resetAnimation,
  }
}
