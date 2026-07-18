// src/tui/model/use-model-picker.ts
// own model discovery, picker selection, activation, and cancellation state

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Agent } from '../../agent/agent.js'
import { OllamaClient } from '../../ollama/client.js'
import type { SessionData } from '../../session/types.js'
import type { Model } from '../../types/inference.js'
import { clamp } from '../../utils/clamp.js'
import { toErrorMessage } from '../../utils/errors.js'
import { restoredSessionForPickerSelection } from './model-activation.js'
import { sortModels } from './model-picker.js'
import type { InteractiveSession } from '../session/use-interactive-session.js'

export type ModelPickerState = 'hidden' | 'loading' | 'ready' | 'error'

export interface UseModelPickerOptions
{
  requestedModel?: string
  host: string
  initialSession: SessionData | null
  agent: Agent | null
  activateModel: InteractiveSession['activateModel']
  isAcceptingTransitions: () => boolean
  shutdown: () => Promise<void>
  onPersistenceError: () => void
}

export interface ModelPickerController
{
  state: ModelPickerState
  visible: boolean
  errorTitle: string
  error: string
  models: Model[]
  selectedIndex: number
  reopen: () => void
  retry: () => void
  moveSelection: (offset: number) => void
  selectCurrent: () => void
  escape: () => void
  shutdown: () => Promise<void>
}

export function useModelPicker(
  options: UseModelPickerOptions
): ModelPickerController
{
  const {
    requestedModel,
    host,
    initialSession,
    agent,
    activateModel,
    isAcceptingTransitions,
    shutdown: shutdownSession,
    onPersistenceError,
  } = options
  const [state, setState] = useState<ModelPickerState>(
    requestedModel ? 'hidden' : 'loading'
  )
  const [errorTitle, setErrorTitle] = useState('Failed to load Ollama models')
  const [error, setError] = useState('')
  const [models, setModels] = useState<Model[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const loadAbortRef = useRef<AbortController | null>(null)
  const loadGenerationRef = useRef(0)
  const initialLoadStartedRef = useRef(false)
  const selectionPendingRef = useRef(false)
  const loadRef = useRef<(() => Promise<void>) | undefined>(undefined)

  const chooseModel = useCallback(
    (nextModel: string, restoredSession: SessionData | null) =>
    {
      if (selectionPendingRef.current) return
      selectionPendingRef.current = true
      setState('hidden')
      void activateModel(nextModel, restoredSession)
        .then((result) =>
        {
          if (result.status === 'changed')
          {
            if (result.persistence?.status === 'error')
            {
              onPersistenceError()
            }
            return
          }
          if (result.status === 'unchanged') return
          if (result.status === 'stale' || result.status === 'aborted') return

          selectionPendingRef.current = false
          setErrorTitle('Failed to activate model')
          setError('Another session update is still running.')
          setState('error')
        })
        .catch((activationError: unknown) =>
        {
          if (!isAcceptingTransitions()) return
          selectionPendingRef.current = false
          setErrorTitle('Failed to activate model')
          setError(toErrorMessage(activationError))
          setState('error')
        })
    },
    [activateModel, isAcceptingTransitions, onPersistenceError]
  )

  const load = useCallback(async () =>
  {
    loadAbortRef.current?.abort()
    const controller = new AbortController()
    loadAbortRef.current = controller
    const loadGeneration = ++loadGenerationRef.current
    selectionPendingRef.current = false
    setState('loading')
    setErrorTitle('Failed to load Ollama models')
    setError('')

    try
    {
      const client = new OllamaClient(host)
      const loadedModels = sortModels(
        await client.listModels(controller.signal)
      )
      if (
        controller.signal.aborted ||
        loadGeneration !== loadGenerationRef.current ||
        !isAcceptingTransitions()
      )
      {
        return
      }
      const isReopening = Boolean(agent)

      if (!isReopening)
      {
        if (loadedModels.length === 1)
        {
          chooseModel(loadedModels[0]!.name, initialSession)
          return
        }

        if (initialSession)
        {
          const sessionModel = loadedModels.find(
            (loadedModel) => loadedModel.name === initialSession.meta.model
          )
          if (sessionModel)
          {
            chooseModel(sessionModel.name, initialSession)
            return
          }
        }
      }

      const currentModelIndex = isReopening
        ? loadedModels.findIndex(
            (loadedModel) => loadedModel.name === agent?.getModel()
          )
        : 0

      setModels(loadedModels)
      setSelectedIndex(currentModelIndex >= 0 ? currentModelIndex : 0)
      setState('ready')
    }
    catch (loadError)
    {
      if (
        controller.signal.aborted ||
        loadGeneration !== loadGenerationRef.current ||
        !isAcceptingTransitions()
      )
      {
        return
      }
      setError(toErrorMessage(loadError))
      setState('error')
    }
    finally
    {
      if (loadAbortRef.current === controller)
      {
        loadAbortRef.current = null
      }
    }
  }, [agent, chooseModel, host, initialSession, isAcceptingTransitions])

  useEffect(() =>
  {
    loadRef.current = load
  }, [load])

  useEffect(() => () => loadAbortRef.current?.abort(), [])

  useEffect(() =>
  {
    loadGenerationRef.current++
  }, [agent])

  useEffect(() =>
  {
    if (requestedModel || initialLoadStartedRef.current) return
    initialLoadStartedRef.current = true
    queueMicrotask(() =>
    {
      void load()
    })
  }, [load, requestedModel])

  const reopen = useCallback(() =>
  {
    void loadRef.current?.()
  }, [])

  const retry = useCallback(() =>
  {
    void load()
  }, [load])

  const moveSelection = useCallback(
    (offset: number) =>
    {
      setSelectedIndex((current) =>
        clamp(current + offset, 0, models.length - 1)
      )
    },
    [models.length]
  )

  const selectCurrent = useCallback(() =>
  {
    const selected = models[selectedIndex]
    if (!selected) return
    chooseModel(
      selected.name,
      restoredSessionForPickerSelection(Boolean(agent), initialSession)
    )
  }, [agent, chooseModel, initialSession, models, selectedIndex])

  const shutdown = useCallback(() =>
  {
    loadAbortRef.current?.abort()
    return shutdownSession()
  }, [shutdownSession])

  const escape = useCallback(() =>
  {
    if (agent)
    {
      loadAbortRef.current?.abort()
      loadGenerationRef.current++
      setState('hidden')
      return
    }
    void shutdown()
  }, [agent, shutdown])

  return {
    state,
    visible: state !== 'hidden',
    errorTitle,
    error,
    models,
    selectedIndex,
    reopen,
    retry,
    moveSelection,
    selectCurrent,
    escape,
    shutdown,
  }
}
