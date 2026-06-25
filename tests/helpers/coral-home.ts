// tests/helpers/coral-home.ts
// capture CORAL_HOME & return an undefined-aware restore fn for node:test files

export function captureCoralHome(): () => void
{
  const original = process.env.CORAL_HOME
  return () =>
  {
    if (original === undefined)
    {
      delete process.env.CORAL_HOME
    }
    else
    {
      process.env.CORAL_HOME = original
    }
  }
}
