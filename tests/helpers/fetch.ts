// tests/helpers/fetch.ts
// stub globalThis.fetch for the duration of fn, restoring it after

export async function withFetch<T>(
  handler: typeof globalThis.fetch,
  fn: () => Promise<T>
): Promise<T>
{
  const original = globalThis.fetch
  globalThis.fetch = handler
  try
  {
    return await fn()
  }
  finally
  {
    globalThis.fetch = original
  }
}
