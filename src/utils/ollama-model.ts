// src/utils/ollama-model.ts
// canonical lookup identity for Ollama model aliases

// match the shortest names returned by /api/tags while preserving custom hosts
export function ollamaModelLookupKey(model: string): string
{
  let key = model.trim().replace(/^https?:\/\//i, '')
  key = key.replace(/^registry\.ollama\.ai\/library\//i, '')
  key = key.replace(/^library\//i, '')

  if (key.lastIndexOf(':') <= key.lastIndexOf('/'))
  {
    key += ':latest'
  }

  return key.toLowerCase()
}
