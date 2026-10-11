// src/ollama/model-name.ts
// shared Ollama model-name equivalence for metadata lookup

// match the shortest names returned by /api/tags while preserving custom hosts
export function modelLookupKey(model: string): string
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
