// src/cli/models.ts
// expose the same hosted and local inventory to external model pickers

import { createInferenceClient } from '../providers/router.js'
import { toErrorMessage } from '../utils/errors.js'
import { sanitizeUntrustedText } from '../utils/untrusted-text.js'
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
    // names come from the host, so a terminal gets them without control
    // sequences while pipes keep the raw bytes
    const names = models.map((model) => model.name).join('\n')
    console.log(
      options.json
        ? JSON.stringify({ models })
        : process.stdout.isTTY
          ? sanitizeUntrustedText(names)
          : names
    )
    return 0
  }
  catch (error)
  {
    const message = `Cannot list Coral models: ${toErrorMessage(error)}`
    console.error(
      process.stderr.isTTY ? sanitizeUntrustedText(message) : message
    )
    return 1
  }
}
