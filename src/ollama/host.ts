// src/ollama/host.ts
// default Ollama host config

export const DEFAULT_OLLAMA_HOST = 'http://localhost:11434'

// canonicalize host identity & reject URL parts Coral cannot safely preserve
export function normalizeOllamaHost(host: string): string
{
  let parsed: URL
  try
  {
    parsed = new URL(host.trim())
  }
  catch
  {
    throw new Error(`Invalid Ollama host URL: ${host}`)
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
  {
    throw new Error(
      `Invalid Ollama host protocol ${parsed.protocol || '(missing)'}; use http or https`
    )
  }

  if (parsed.username || parsed.password)
  {
    throw new Error(
      'Ollama host URLs cannot include credentials; configure an authenticated proxy without URL userinfo'
    )
  }

  if (parsed.search || parsed.hash)
  {
    throw new Error(
      'Ollama host URLs cannot include a query string or fragment'
    )
  }

  const path = parsed.pathname.replace(/\/+$/, '')
  return `${parsed.origin}${path === '/' ? '' : path}`
}
