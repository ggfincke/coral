// tests/helpers/fetch.ts
// stub globalThis.fetch for the duration of fn, restoring it after

type FetchStub = (
  input: Parameters<typeof globalThis.fetch>[0],
  init: Parameters<typeof globalThis.fetch>[1]
) => Response | Promise<Response>

export async function withFetch<T>(
  handler: FetchStub,
  fn: () => Promise<T>
): Promise<T>
{
  const original = globalThis.fetch
  globalThis.fetch = (async (input, init) =>
    handler(input, init)) as typeof fetch
  try
  {
    return await fn()
  }
  finally
  {
    globalThis.fetch = original
  }
}

export function parseFetchJsonBody<T>(
  init: Parameters<typeof globalThis.fetch>[1]
): T
{
  return JSON.parse(String(init?.body ?? '{}')) as T
}
