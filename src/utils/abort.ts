// src/utils/abort.ts
// shared abort-signal race helper

// race a promise against an AbortSignal — rejects w/ AbortError if aborted
// first; pre-aborted signals reject immediately; listeners detach on settle
export function raceAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal
): Promise<T>
{
  if (!signal) return promise
  if (signal.aborted)
  {
    return Promise.reject(new DOMException('Aborted', 'AbortError'))
  }

  return new Promise<T>((resolve, reject) =>
  {
    const onAbort = () =>
    {
      reject(new DOMException('Aborted', 'AbortError'))
    }

    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) =>
      {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) =>
      {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}
