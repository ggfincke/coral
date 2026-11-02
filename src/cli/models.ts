// src/cli/models.ts
// expose the same hosted and local inventory to external model pickers

import { createInferenceClient } from '../providers/router.js'
import { toErrorMessage } from '../utils/errors.js'
import type { CliOptions } from './args.js'

export async function runModelsCli(options: CliOptions): Promise<number>
{
  try
  {
    const available = await createInferenceClient(options.host).listModels(
      AbortSignal.timeout(8_000)
    )
    const models = [...new Set(available.map((model) => model.name))].map(
      (name) => ({ name })
    )
    console.log(
      options.json
        ? JSON.stringify({ models })
        : models.map((model) => model.name).join('\n')
    )
    return 0
  }
  catch (error)
  {
    console.error(`Cannot list Coral models: ${toErrorMessage(error)}`)
    return 1
  }
}
