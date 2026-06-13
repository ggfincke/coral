// src/utils/json.ts
// JSON parsing helpers

// parse JSON, returning undefined on any parse error
export function tryParseJson(text: string): unknown
{
  try
  {
    return JSON.parse(text)
  }
  catch
  {
    return undefined
  }
}
