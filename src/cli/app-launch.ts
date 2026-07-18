// src/cli/app-launch.ts
// validate CLI runtime inputs before composing the Ink application

import { normalizeOllamaHost } from '../ollama/host.js'
import type { AppProps } from '../tui/App.js'
import { toErrorMessage } from '../utils/errors.js'

type RenderCliApp = (props: AppProps) => void
type ReportCliError = (message: string) => void

export function launchCliApp(
  props: AppProps,
  renderApp: RenderCliApp,
  reportError: ReportCliError
): number
{
  let host: string
  try
  {
    host = normalizeOllamaHost(props.host)
  }
  catch (error)
  {
    reportError(`Cannot start Coral: ${toErrorMessage(error)}`)
    return 1
  }

  renderApp({ ...props, host })
  return 0
}
