// src/retrieval/vector.ts
// vector serialization and similarity helpers

export function vectorToBlob(vector: number[]): Buffer
{
  const floats = new Float32Array(vector)
  return Buffer.from(floats.buffer)
}

// returns a zero-copy view over the blob; do not mutate
export function blobToVector(blob: Buffer, dims: number): Float32Array
{
  if (blob.byteLength !== dims * Float32Array.BYTES_PER_ELEMENT)
  {
    return new Float32Array(0)
  }

  return new Float32Array(
    blob.buffer,
    blob.byteOffset,
    blob.byteLength / Float32Array.BYTES_PER_ELEMENT
  )
}

export function cosineSimilarity(
  left: ArrayLike<number>,
  right: ArrayLike<number>
): number
{
  if (left.length === 0 || left.length !== right.length) return 0

  let dot = 0
  let leftNorm = 0
  let rightNorm = 0

  for (let i = 0; i < left.length; i++)
  {
    const a = left[i]!
    const b = right[i]!
    dot += a * b
    leftNorm += a * a
    rightNorm += b * b
  }

  if (leftNorm === 0 || rightNorm === 0) return 0
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}
