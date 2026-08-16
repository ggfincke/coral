// tests/helpers/agents-home.ts
// capture AGENTS_HOME & return an undefined-aware restore fn for node:test files

export function captureAgentsHome(): () => void
{
  const original = process.env.AGENTS_HOME
  return () =>
  {
    if (original === undefined)
    {
      delete process.env.AGENTS_HOME
    }
    else
    {
      process.env.AGENTS_HOME = original
    }
  }
}
