// src/tui/commands/command-operation.ts
// join command history and dispatch under one operation lifetime

interface CommandOperation<T>
{
  run: (work: () => Promise<T>) => Promise<T>
  recordHistory: () => void
  setRunning: (running: boolean) => void
  finish: () => void
  onError: (error: unknown) => T
}

// register work before history can throw so shutdown always joins the command
export function runAdmittedCommand<T>(
  operation: CommandOperation<T>,
  dispatch: () => T | Promise<T>
): Promise<T>
{
  return operation.run(async () =>
  {
    try
    {
      operation.setRunning(true)
      operation.recordHistory()
      return await dispatch()
    }
    catch (error)
    {
      return operation.onError(error)
    }
    finally
    {
      operation.finish()
      operation.setRunning(false)
    }
  })
}
