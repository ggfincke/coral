// tests/helpers/agent-harness.ts
// shared Agent test harness: fake-client builder + event-sink factory

import { Agent, type AgentEvents } from '../../src/agent/agent.js'
import type { ChatRequest, OllamaMessage } from '../../src/types/inference.js'

export interface FakeChunk
{
  message: OllamaMessage
  done: boolean
}

// request-inspecting generator form; turns[][] is the canonical form
export type FakeStream = (request?: ChatRequest) => AsyncGenerator<FakeChunk>

export type TestAgent = Agent & {
  client: {
    startKeepAlive: (model: string) => void
    unloadModel?: (model?: string) => Promise<void>
    chatStream: FakeStream
  }
  messages: OllamaMessage[]
}

// build an Agent w/ a stubbed client that replays either one chunk array per
// model turn (turns[][], the canonical form) or a request-inspecting streamFn.
// streams() reports how many model turns ran, for both forms
export function makeFakeAgent(
  dir: string,
  script: FakeChunk[][] | FakeStream,
  options: ConstructorParameters<typeof Agent>[3] = {},
  baseUrl = 'http://localhost:11434'
): { agent: TestAgent; streams: () => number }
{
  const agent = new Agent('fake-model', baseUrl, dir, options) as TestAgent

  let count = 0
  let chatStream: FakeStream
  if (typeof script === 'function')
  {
    chatStream = async function* (request)
    {
      count += 1
      yield* script(request)
    }
  }
  else
  {
    chatStream = async function* ()
    {
      const turn = script[Math.min(count, script.length - 1)] ?? []
      count += 1
      yield* turn
    }
  }

  agent.client = {
    startKeepAlive()
    {},
    chatStream,
  }

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
