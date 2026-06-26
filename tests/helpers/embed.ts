// tests/helpers/embed.ts
// shared keyword->vector rule for retrieval/search test embedders

export function keywordVector(text: string): number[]
{
  return /auth|login|session/i.test(text) ? [1, 0] : [0, 1]
}
