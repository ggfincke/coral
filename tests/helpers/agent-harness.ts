// tests/helpers/agent-harness.ts
// shared Agent test harness: fake-client builder + event-sink factory

import {
  Agent,
  type AgentEvents,
  type AgentInferenceClient,
  type AgentOptions,
} from '../../src/agent/agent.js'
import type { ChatRequest, OllamaMessage } from '../../src/types/inference.js'

export interface FakeChunk
{
  message: OllamaMessage
  done: boolean
  prompt_eval_count?: number
  prompt_eval_duration?: number
  eval_count?: number
  eval_duration?: number
}

// request-inspecting generator form; turns[][] is the canonical form
export type FakeStream = (
  request?: ChatRequest,
  signal?: AbortSignal
) => AsyncGenerator<FakeChunk>

type FakeInferenceClient = Omit<AgentInferenceClient, 'chatStream'> & {
  chatStream: FakeStream
}

export type FakeAgentOptions = Omit<AgentOptions, 'inferenceClient'> & {
  inferenceClient?: Partial<FakeInferenceClient>
}

// build an Agent w/ a stubbed client that replays either one chunk array per
// model turn (turns[][], the canonical form) or a request-inspecting streamFn.
// streams() reports how many model turns ran, for both forms
export function makeFakeAgent(
  dir: string,
  script: FakeChunk[][] | FakeStream,
  options: FakeAgentOptions = {},
  baseUrl = 'http://localhost:11434'
): { agent: Agent; streams: () => number }
{
  let count = 0
  let scriptedStream: FakeStream
  if (typeof script === 'function')
  {
    scriptedStream = script
  }
  else
  {
    let scriptedCount = 0
    scriptedStream = async function* ()
    {
      const turn = script[Math.min(scriptedCount, script.length - 1)] ?? []
      scriptedCount += 1
      yield* turn
    }
  }

  const selectedStream = options.inferenceClient?.chatStream ?? scriptedStream
  const chatStream: FakeStream = async function* (request, signal)
  {
    count += 1
    yield* selectedStream(request, signal)
  }
  const inferenceClient: FakeInferenceClient = {
    startKeepAlive()
    {},
    async showModel()
    {
      return { contextLength: 8_192, architecture: 'gemma' }
    },
    async listModels()
    {
      return [
        { name: 'fake-model', model: 'fake-model', size: 0, modified_at: '' },
      ]
    },
    chatStream,
    ...options.inferenceClient,
  }
  inferenceClient.chatStream = chatStream

  const agent = new Agent('fake-model', baseUrl, dir, {
    ...options,
    inferenceClient,
  })

  return { agent, streams: () => count }
}

// event sink defaulting onToolApproval->true & onError->throw; callers layer
// recording/assertion callbacks on top via overrides
export function makeAgentEvents(
  overrides: Partial<AgentEvents> = {}
): AgentEvents
{
  return {
    onToken()
    {},
    onToolCall()
    {},
    onToolResult()
    {},
    onToolApproval()
    {
      return Promise.resolve(true)
    },
    onDone()
    {},
    onError(error)
    {
      throw error
    },
    ...overrides,
  }
}
